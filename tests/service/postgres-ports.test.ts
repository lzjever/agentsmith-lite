import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { readPostgresMigrations } from "../../packages/adapters-postgres/src/migrations.js";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import { isFileDeletionOperationTransition } from "../../packages/ports/src/store.js";
import type {
  BeginTaskIdempotencyInput,
  FileDeletionOperationOwner,
  FileDeletionOperationState,
  TaskIdempotencyOperation,
} from "../../packages/ports/src/store.js";

describe("postgres adapter ports", () => {
  it("exposes JSONB document and fenced lease semantics without Redis or Mongo", async () => {
    const store = createInMemoryProductStore();

    await store.jsonDocs.put("project_settings", "p1", { concurrency: 2 });
    assert.deepEqual(await store.jsonDocs.get("project_settings", "p1"), { concurrency: 2 });
    assert.equal(await store.jsonDocs.get("project_settings", "missing"), null);

    const acquired = await store.leases.acquire({
      name: "sandbox:t1",
      holder: "api-1",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.lease?.fencingToken, 1);

    const stale = await store.leases.compareAndSet("sandbox:t1", 0, { phase: "running" });
    assert.equal(stale, false);
    const current = await store.leases.compareAndSet("sandbox:t1", 1, { phase: "running" });
    assert.equal(current, true);
  });

  it("keeps product schema migrations sourced from SQL files and separate from substrate metadata", async () => {
    const migrations = await readPostgresMigrations();
    const migrationSql = migrations.map((migration) => migration.sql).join("\n");
    assert.match(migrationSql, /create table if not exists workspaces/i);
    assert.match(migrationSql, /create table if not exists agent_tasks/i);
    assert.doesNotMatch(migrationSql, /juicefs/i);
    assert.doesNotMatch(migrationSql, /redis/i);
    assert.doesNotMatch(migrationSql, /mongo/i);
  });

  it("normalizes completed PostgreSQL receipts only at operation-specific DTO fields", async () => {
    function receipt(operation: TaskIdempotencyOperation, responseBody: unknown) {
      const row = {
        actor_id: "user_receipt",
        project_id: "project_receipt",
        operation,
        idempotency_key: `${operation}-key`,
        request_hash: `legacy-${operation}-request-hash`,
        resource_id: "project_receipt",
        status: "completed",
        claim_token: "claim-token",
        lease_expires_at: "2026-07-25T00:01:00.000Z",
        response_status: 200,
        response_body: responseBody,
        created_at: "2026-07-25T00:00:00.000Z",
        updated_at: "2026-07-25T00:00:01.000Z",
      };
      const client = {
        async query(sql: string) {
          if (/select \* from task_idempotency_records/i.test(sql)) return { rows: [row], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
      const pool = {
        async connect() { return client; },
        async query() { return { rows: [row], rowCount: 1 }; },
      };
      const store = Object.create(PostgresProductStore.prototype) as PostgresProductStore;
      Object.defineProperty(store, "pool", { value: pool });
      const input: BeginTaskIdempotencyInput = {
        actorId: row.actor_id,
        projectId: row.project_id,
        operation,
        key: row.idempotency_key,
        requestHash: row.request_hash,
        resourceId: row.resource_id,
        claimToken: "new-claim-token",
        now: "2026-07-25T00:00:02.000Z",
        leaseExpiresAt: "2026-07-25T00:01:02.000Z",
      };
      return { input, row, store };
    }

    const projectStored = {
      id: "project_receipt",
      taskConcurrencyLimit: 2,
      title: "active_tasks",
      prompt: "active_tasks_limit",
      context: { taskConcurrencyLimit: 9, activeTasksLimit: 3, activeTasks: 1, metric: "active_tasks" },
      content: ["active_tasks", "active_tasks_limit", { taskConcurrencyLimit: 4 }],
      similarKey: { taskConcurrencyLimits: 4, activeTask: 1 },
    };
    const projectExpected = {
      id: "project_receipt",
      sandboxLimit: 2,
      title: "active_tasks",
      prompt: "active_tasks_limit",
      context: { taskConcurrencyLimit: 9, activeTasksLimit: 3, activeTasks: 1, metric: "active_tasks" },
      content: ["active_tasks", "active_tasks_limit", { taskConcurrencyLimit: 4 }],
      similarKey: { taskConcurrencyLimits: 4, activeTask: 1 },
    };
    const projectReceipt = receipt("project.archive", projectStored);
    assert.deepEqual(await projectReceipt.store.beginTaskIdempotency(projectReceipt.input), {
      kind: "replay",
      resourceId: projectReceipt.row.resource_id,
      responseStatus: 200,
      responseBody: projectExpected,
    });
    assert.deepEqual(await projectReceipt.store.findTaskIdempotency({
      actorId: projectReceipt.input.actorId,
      projectId: projectReceipt.input.projectId,
      operation: projectReceipt.input.operation,
      key: projectReceipt.input.key,
      requestHash: projectReceipt.input.requestHash,
    }), {
      kind: "replay",
      resourceId: projectReceipt.row.resource_id,
      responseStatus: 200,
      responseBody: projectExpected,
    });
    assert.deepEqual(await projectReceipt.store.findTaskIdempotencyByResource({
      actorId: projectReceipt.input.actorId,
      operation: projectReceipt.input.operation,
      key: projectReceipt.input.key,
      requestHash: projectReceipt.input.requestHash,
      resourceId: projectReceipt.input.resourceId,
    }), {
      kind: "replay",
      resourceId: projectReceipt.row.resource_id,
      responseStatus: 200,
      responseBody: projectExpected,
    });
    const unarchiveReceipt = receipt("project.unarchive", projectStored);
    assert.deepEqual(await unarchiveReceipt.store.beginTaskIdempotency(unarchiveReceipt.input), {
      kind: "replay",
      resourceId: unarchiveReceipt.row.resource_id,
      responseStatus: 200,
      responseBody: projectExpected,
    });

    const settingsStored = {
      project: {
        id: "project_receipt",
        taskConcurrencyLimit: 3,
        title: "active_tasks",
        context: { taskConcurrencyLimit: 9, activeTasksLimit: 4 },
      },
      workspaceLifecycleStatus: "active",
      content: ["active_tasks", "active_tasks_limit"],
      activeTasksLimit: 7,
    };
    const settingsReceipt = receipt("project.settings.update", settingsStored);
    assert.equal(settingsReceipt.input.requestHash, settingsReceipt.row.request_hash);
    assert.deepEqual(await settingsReceipt.store.beginTaskIdempotency(settingsReceipt.input), {
      kind: "replay",
      resourceId: settingsReceipt.row.resource_id,
      responseStatus: 200,
      responseBody: {
        project: {
          id: "project_receipt",
          sandboxLimit: 3,
          title: "active_tasks",
          context: { taskConcurrencyLimit: 9, activeTasksLimit: 4 },
        },
        workspaceLifecycleStatus: "active",
        content: ["active_tasks", "active_tasks_limit"],
        activeTasksLimit: 7,
      },
    });

    const policyStored = {
      projectId: "project_receipt",
      activeTasksLimit: 4,
      title: "active_tasks",
      context: { activeTasksLimit: 9, activeTasks: 2, metric: "active_tasks" },
      content: ["active_tasks", "active_tasks_limit"],
    };
    const policyReceipt = receipt("project.policy.update", policyStored);
    assert.equal(policyReceipt.input.requestHash, policyReceipt.row.request_hash);
    assert.deepEqual(await policyReceipt.store.beginTaskIdempotency(policyReceipt.input), {
      kind: "replay",
      resourceId: policyReceipt.row.resource_id,
      responseStatus: 200,
      responseBody: {
        projectId: "project_receipt",
        sandboxLimit: 4,
        title: "active_tasks",
        context: { activeTasksLimit: 9, activeTasks: 2, metric: "active_tasks" },
        content: ["active_tasks", "active_tasks_limit"],
      },
    });

    const alertStored = {
      id: "alert_receipt",
      type: "active_tasks_limit",
      metric: "active_tasks",
      title: "active_tasks",
      context: { type: "active_tasks_limit", metric: "active_tasks", activeTasks: 1 },
      content: ["active_tasks", "active_tasks_limit"],
    };
    for (const operation of ["project.alert.transition", "project.alert.acknowledge", "project.alert.silence"] as const) {
      const alertReceipt = receipt(operation, alertStored);
      assert.deepEqual(await alertReceipt.store.beginTaskIdempotency(alertReceipt.input), {
        kind: "replay",
        resourceId: alertReceipt.row.resource_id,
        responseStatus: 200,
        responseBody: { ...alertStored, type: "sandbox_capacity", metric: "active_sandboxes" },
      });
    }

    const ruleStored = {
      id: "rule_receipt",
      alertType: "active_tasks_limit",
      metric: "active_tasks",
      name: "active_tasks",
      context: { alertType: "active_tasks_limit", metric: "active_tasks" },
      content: ["active_tasks", "active_tasks_limit"],
    };
    for (const operation of ["project.alert-rule.create", "project.alert-rule.update", "project.alert-rule.delete"] as const) {
      const ruleReceipt = receipt(operation, ruleStored);
      assert.deepEqual(await ruleReceipt.store.beginTaskIdempotency(ruleReceipt.input), {
        kind: "replay",
        resourceId: ruleReceipt.row.resource_id,
        responseStatus: 200,
        responseBody: { ...ruleStored, alertType: "sandbox_capacity", metric: "active_sandboxes" },
      });
    }

    const taskStored = {
      title: "active_tasks",
      prompt: "active_tasks_limit",
      context: { taskConcurrencyLimit: 2, activeTasksLimit: 3, activeTasks: 1 },
      content: ["active_tasks", "active_tasks_limit", { activeTasks: 1 }],
      taskConcurrencyLimit: 2,
      activeTasksLimit: 3,
      activeTasks: 1,
    };
    const taskReceipt = receipt("create", taskStored);
    assert.deepEqual(await taskReceipt.store.beginTaskIdempotency(taskReceipt.input), {
      kind: "replay",
      resourceId: taskReceipt.row.resource_id,
      responseStatus: 200,
      responseBody: taskStored,
    });
    assert.deepEqual(
      await taskReceipt.store.beginTerminalStart({ idempotency: taskReceipt.input } as Parameters<PostgresProductStore["beginTerminalStart"]>[0]),
      { kind: "replay", responseStatus: 200, responseBody: taskStored },
    );
    assert.deepEqual(
      await taskReceipt.store.failTaskSandboxStartupAtomically({ idempotency: taskReceipt.input } as unknown as Parameters<PostgresProductStore["failTaskSandboxStartupAtomically"]>[0]),
      { kind: "replay", responseStatus: 200, responseBody: taskStored },
    );
    assert.deepEqual(projectStored.taskConcurrencyLimit, 2);
  });

  it("defines only the Phase 1 file library persistence model in migration 060", async () => {
    const migration = (await readPostgresMigrations()).find((item) => item.id === "060_file_libraries");
    assert.ok(migration);
    assert.match(migration.sql, /create table file_libraries/i);
    assert.match(migration.sql, /unique.*project_id.*root_sub_path/is);
    assert.match(migration.sql, /lower\(btrim\(name\)\)/i);
    assert.doesNotMatch(migration.sql, /file_library_id.*agent_tasks|sandbox/i);
  });

  it("fences file deletion phases with the current full idempotency owner", async () => {
    const store = createInMemoryProductStore();
    const base = {
      actorId: "user_delete",
      projectId: "project_delete",
      operation: "project.file.delete" as const,
      key: "delete-key",
      requestHash: "delete-request",
      resourceId: "delete-operation",
    };
    const first: FileDeletionOperationOwner = { ...base, claimToken: "claim-one" };
    assert.equal((await store.beginTaskIdempotency({
      ...base,
      claimToken: first.claimToken,
      now: "2026-07-25T00:00:00.000Z",
      leaseExpiresAt: "2026-07-25T00:00:30.000Z",
    })).kind, "claimed");
    const isolated: FileDeletionOperationState = {
      phase: "isolated",
      quarantineDevice: "100",
      quarantineInode: "200",
      entryType: "directory",
      bytes: 12,
    };
    assert.equal(await store.persistFileDeletionOperation(first, isolated), true);

    const second: FileDeletionOperationOwner = { ...base, claimToken: "claim-two" };
    assert.equal((await store.beginTaskIdempotency({
      ...base,
      claimToken: second.claimToken,
      now: "2026-07-25T00:00:31.000Z",
      leaseExpiresAt: "2026-07-25T00:01:01.000Z",
    })).kind, "claimed");
    assert.equal(await store.findFileDeletionOperation(first), null);
    assert.equal(await store.persistFileDeletionOperation(first, { ...isolated, phase: "removed" }), false);
    assert.deepEqual(await store.findFileDeletionOperation(second), isolated);
    assert.equal(await store.persistFileDeletionOperation(second, { ...isolated, phase: "removed" }), true);
  });

  it("uses every idempotency owner field to fence PostgreSQL file deletion transitions", async () => {
    const statements: string[] = [];
    const owner: FileDeletionOperationOwner = {
      actorId: "user_delete",
      projectId: "project_delete",
      operation: "project.file.delete",
      key: "delete-key",
      requestHash: "delete-request",
      resourceId: "delete-operation",
      claimToken: "delete-claim",
    };
    const state: FileDeletionOperationState = {
      phase: "isolated",
      quarantineDevice: "100",
      quarantineInode: "200",
      entryType: "file",
      bytes: 8,
    };
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (/select \* from task_idempotency_records/i.test(sql)) {
          return {
            rows: [{
              file_deletion_phase: null,
              file_deletion_quarantine_device: null,
              file_deletion_quarantine_inode: null,
              file_deletion_entry_type: null,
              file_deletion_bytes: null,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const store = Object.create(PostgresProductStore.prototype) as PostgresProductStore;
    Object.defineProperty(store, "pool", {
      value: { async connect() { return client; } },
    });

    assert.equal(await store.persistFileDeletionOperation(owner, state), true);
    const fencedSql = statements.filter((sql) => /task_idempotency_records/i.test(sql)).join("\n");
    for (const column of [
      "actor_id",
      "project_id",
      "operation",
      "idempotency_key",
      "request_hash",
      "resource_id",
      "claim_token",
      "status",
    ]) {
      assert.match(fencedSql, new RegExp(column, "i"));
    }
  });

  it("stores only isolated and removed file deletion phases in migration 075", async () => {
    const migration = (await readPostgresMigrations()).find((item) => item.id === "075_file_entry_deletion_operations");
    assert.ok(migration);
    assert.match(migration.sql, /file_deletion_quarantine_device/i);
    assert.match(migration.sql, /file_deletion_quarantine_inode/i);
    assert.match(migration.sql, /file_deletion_phase in \('isolated', 'removed'\)/i);
    assert.match(migration.sql, /file_deletion_quarantine_device\s*~\s*'\^\[0-9\]\+\$'/i);
    assert.match(migration.sql, /file_deletion_quarantine_inode\s*~\s*'\^\[0-9\]\+\$'/i);
    assert.match(migration.sql, /file_deletion_bytes\s*<=\s*9007199254740991/i);
    for (const column of [
      "file_deletion_phase",
      "file_deletion_quarantine_device",
      "file_deletion_quarantine_inode",
      "file_deletion_entry_type",
      "file_deletion_bytes"
    ]) {
      assert.match(migration.sql, new RegExp(`${column} is not null`, "i"));
    }
    assert.doesNotMatch(migration.sql, /source_claimed|file_deletion_source_/i);
  });

  it("keeps transition validation at parity with migration 075 scalar bounds", () => {
    const valid: FileDeletionOperationState = {
      phase: "isolated",
      quarantineDevice: "0",
      quarantineInode: "200",
      entryType: "file",
      bytes: Number.MAX_SAFE_INTEGER
    };
    assert.equal(isFileDeletionOperationTransition(null, valid), true);
    for (const invalid of [
      { ...valid, quarantineDevice: "" },
      { ...valid, quarantineDevice: " 100" },
      { ...valid, quarantineInode: "-1" },
      { ...valid, bytes: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      assert.equal(isFileDeletionOperationTransition(null, invalid), false);
    }
  });

  it("defines the sole Phase 2 Task File Library binding in migration 061",async()=>{
    const migrations = await readPostgresMigrations();
    const interactionMigration = migrations.find((item) => item.id === "047_task_interaction_changes");
    const migration=migrations.find((item)=>item.id==="061_task_file_library_binding");
    assert.ok(interactionMigration);
    assert.ok(migration);
    assert.match(interactionMigration.sql, /alter table task_follow_ups rename to task_messages/i);
    assert.match(interactionMigration.sql, /drop table agent_task_events/i);
    assert.match(migration.sql,/delete from agent_tasks/i);
    assert.match(migration.sql,/delete from task_messages/i);
    assert.match(migration.sql,/delete from task_interaction_changes/i);
    assert.match(migration.sql,/delete from agent_task_artifacts/i);
    assert.match(migration.sql,/foreign key \(file_library_id, workspace_id, project_id\)[\s\S]*references file_libraries\(id, workspace_id, project_id\)[\s\S]*on delete restrict/i);
    assert.match(migration.sql,/deleted_at is null and file_library_id is not null[\s\S]*deleted_at is not null and file_library_id is null/i);
    assert.match(migration.sql,/unique index agent_tasks_file_library_active_unique[\s\S]*where deleted_at is null\s*;/i);
    assert.match(migration.sql,/drop column if exists input_paths/i);
    assert.match(migration.sql,/drop column if exists source_task_id/i);
    assert.doesNotMatch(migration.sql,/\btask_follow_ups\b/i);
    assert.doesNotMatch(migration.sql,/\bagent_task_events\b/i);
  });

  it("transitions Phase 2 Tasks directly to reusable sessions in migration 062",async()=>{
    const migrations=await readPostgresMigrations();
    const phase2=migrations.findIndex((item)=>item.id==="061_task_file_library_binding");
    const phase3=migrations.findIndex((item)=>item.id==="062_reusable_task_sessions");
    assert.equal(phase3,phase2+1);
    const migration=migrations[phase3];
    assert.ok(migration);
    assert.match(migration.sql,/insert into task_messages/i);
    assert.match(migration.sql,/select\s+task\.id,\s+task\.id,/i);
    assert.match(migration.sql,/delivery_message_/i);
    assert.match(migration.sql,/terminal_reason = null/i);
    assert.match(migration.sql,/finalization_intent_status = null/i);
    assert.match(migration.sql,/delete from task_idempotency_records where operation = 'cancel'/i);
    assert.doesNotMatch(migration.sql,/archived_at\s*=/i);
    assert.match(migration.sql,/collection = 'sandbox_run_state'/i);
    assert.match(migration.sql,/coalesce\(run\.document->>'cleanupStatus', ''\) <> 'cleaned'/i);
    assert.match(migration.sql,/coalesce\(run\.document->>'phase', ''\) <> 'cleaned'/i);
    assert.doesNotMatch(migration.sql,/cleanupStatus' = 'active'/i);
    assert.doesNotMatch(migration.sql,/delete from (agent_tasks|task_messages|task_interaction_changes|agent_task_artifacts)/i);
  });

  it("makes explicit release the sole Phase 4 sandbox cleanup contract in migration 063",async()=>{
    const migrations=await readPostgresMigrations();
    const phase3=migrations.findIndex((item)=>item.id==="062_reusable_task_sessions");
    const phase4=migrations.findIndex((item)=>item.id==="063_explicit_task_sandbox_release");
    assert.equal(phase4,phase3+1);
    const migration=migrations[phase4];assert.ok(migration);
    assert.match(migration.sql,/document - 'expiresAt' - 'idleExpiresAt'/i);
    assert.match(migration.sql,/sandbox\.released/);
    assert.match(migration.sql,/run\.document->>'taskId' = task\.id/i);
    assert.match(migration.sql,/run\.document->>'runId' = task\.run_id/i);
    assert.match(migration.sql,/run\.document->>'projectId' = task\.project_id/i);
    assert.match(migration.sql,/run\.document->>'workspaceId' = task\.workspace_id/i);
    assert.match(migration.sql,/update projects project[\s\S]*lifecycle_status = 'active'/i);
    assert.match(migration.sql,/update workspaces workspace[\s\S]*lifecycle_status = 'active'/i);
    assert.doesNotMatch(migration.sql,/interval|idle_ttl|max_lifetime/i);
  });

  it("adds nullable Sandbox startup readiness/deadline, backfills only active Runs, and rewrites exact generated copy in migration 074",async()=>{
    const migration=(await readPostgresMigrations()).find((item)=>item.id==="074_sandbox_startup_readiness");
    assert.ok(migration);
    assert.match(migration.sql,/alter table sandbox_runs\s+add column startup_ready_at timestamptz/i);
    assert.match(migration.sql,/alter table sandbox_runs\s+add column startup_action_deadline_at timestamptz/i);
    assert.doesNotMatch(migration.sql,/startup_ready_at timestamptz not null/i);
    assert.doesNotMatch(migration.sql,/startup_action_deadline_at timestamptz not null/i);
    assert.match(migration.sql,/update sandbox_runs\s+set startup_ready_at = updated_at\s+where state = 'active'\s+and startup_ready_at is null/i);
    assert.doesNotMatch(migration.sql,/where state = 'starting'[\s\S]*startup_ready_at/i);
    assert.match(migration.sql,/notification\.type = 'project_alert'/i);
    assert.match(migration.sql,/alert\.type = 'active_tasks_limit'/i);
    assert.match(migration.sql,/notification\.title = 'Task capacity reached'/i);
    assert.match(migration.sql,/notification\.body = project\.name \|\| ': Task capacity reached\.'/i);
    assert.match(migration.sql,/notification\.body = project\.name \|\| ': Active tasks ' \|\| alert\.metric_value::text \|\| ' of ' \|\| alert\.threshold::text \|\| '\.'/i);
    assert.match(migration.sql,/Sandbox capacity reached/i);
    assert.match(migration.sql,/Active sandboxes/i);
    assert.doesNotMatch(migration.sql,/replace\s*\(|regexp_replace|like\s+'%/i);
    assert.doesNotMatch(migration.sql,/alter table project_alerts[\s\S]*(type|metric)|alter table project_alert_rules[\s\S]*(alert_type|metric)/i);
  });
});
