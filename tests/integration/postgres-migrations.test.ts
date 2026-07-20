import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { readPostgresMigrations } from "../../packages/adapters-postgres/src/migrations.js";
import { readPostgresTestUrl } from "./postgres-test-database.js";

const postgresUrl = readPostgresTestUrl();
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("postgres migrations", () => {
  it("applies SQL-file migrations to a ledger in the app database", async () => {
    assert.ok(postgresUrl);
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      const expected = await readPostgresMigrations();
      const ledger = await client.query<{ id: string; checksum: string }>(
        "select id, checksum from agentsmith_migrations order by id"
      );
      assert.deepEqual(ledger.rows.map((row) => row.id), expected.map((migration) => migration.id));
      assert.equal(ledger.rows.every((row) => row.checksum.length === 64), true);

      const tables = await client.query<{ table_name: string }>(`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'users',
            'auth_sessions',
            'workspaces',
            'projects',
            'project_memberships',
            'model_endpoints',
            'agent_tasks',
            'task_interaction_changes',
            'task_messages',
            'agent_task_artifacts',
            'postgres_json_docs',
            'runtime_leases',
            'sandbox_usage_settlements'
          )
        order by table_name
      `);
      assert.deepEqual(tables.rows.map((row) => row.table_name), [
        "agent_task_artifacts",
        "agent_tasks",
        "auth_sessions",
        "model_endpoints",
        "postgres_json_docs",
        "project_memberships",
        "projects",
        "runtime_leases",
        "sandbox_usage_settlements",
        "task_interaction_changes",
        "task_messages",
        "users",
        "workspaces"
      ]);
      const sandboxAuditSubject=await client.query<{is_nullable:string}>("select is_nullable from information_schema.columns where table_schema='public' and table_name='project_audit_events' and column_name='subject_user_id'");
      assert.deepEqual(sandboxAuditSubject.rows,[{is_nullable:"YES"}]);
      const sandboxSettlementTrigger=await client.query<{tgname:string}>("select tgname from pg_trigger where tgrelid='sandbox_usage_settlements'::regclass and not tgisinternal");
      assert.deepEqual(sandboxSettlementTrigger.rows,[{tgname:"sandbox_usage_settlements_immutable"}]);

      const interactionUniqueConstraints = await client.query<{ conname: string; definition: string }>(`
        select c.conname, pg_get_constraintdef(c.oid) as definition
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        where t.relname = 'task_interaction_changes'
          and c.contype = 'u'
        order by c.conname
      `);
      assert.equal(
        interactionUniqueConstraints.rows.some((row) => /UNIQUE \(task_id, source_kind, source_id, source_revision\)/i.test(row.definition)),
        true
      );
      assert.equal(
        interactionUniqueConstraints.rows.some((row) => /UNIQUE \(task_id, interaction_id, revision\)/i.test(row.definition)),
        true
      );
      const interactionSourceRevision = await client.query<{ data_type:string }>(`select data_type from information_schema.columns where table_schema='public' and table_name='task_interaction_changes' and column_name='source_revision'`);
      assert.deepEqual(interactionSourceRevision.rows, [{ data_type:"bigint" }]);
      const interactionSourceIdentity = await client.query<{ definition:string }>(`select pg_get_constraintdef(c.oid) as definition from pg_constraint c join pg_class t on t.oid=c.conrelid where t.relname='task_interaction_changes' and c.conname='task_interaction_changes_source_identity_check'`);
      assert.match(interactionSourceIdentity.rows[0]?.definition??"", /source_revision >= 0.*source_kind.*<>.*botified.*source_revision = 0/i);
      const interactionIndexes = await client.query<{ indexname:string }>("select indexname from pg_indexes where schemaname='public' and tablename='task_interaction_changes' order by indexname");
      for(const name of ["task_interaction_changes_latest_idx","task_interaction_changes_history_idx","task_interaction_changes_tool_call_idx","task_interaction_changes_work_task_idx","task_interaction_changes_callback_idx"]) assert.equal(interactionIndexes.rows.some((row)=>row.indexname===name),true);

      const chatMessageUniqueConstraints = await client.query<{ definition: string }>(`
        select pg_get_constraintdef(c.oid) as definition
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        where t.relname = 'project_chat_messages'
          and c.contype = 'u'
      `);
      assert.equal(
        chatMessageUniqueConstraints.rows.some((row) => /UNIQUE \(thread_id, sequence\)/i.test(row.definition)),
        true
      );
      assert.equal(
        chatMessageUniqueConstraints.rows.some((row) => /UNIQUE \(sequence\)/i.test(row.definition)),
        false
      );

      const executionMode = await client.query<{ is_nullable: string; column_default: string | null }>(`
        select is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and table_name = 'agent_tasks' and column_name = 'execution_mode'
      `);
      assert.deepEqual(executionMode.rows, [{ is_nullable: "NO", column_default: "'dry-run'::text" }]);
      const executionModeConstraint = await client.query<{ definition: string }>(`
        select pg_get_constraintdef(c.oid) as definition
        from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'agent_tasks' and c.conname = 'agent_tasks_execution_mode_check'
      `);
      assert.equal(executionModeConstraint.rows.some((row) => /dry-run.*live/i.test(row.definition)), true);

      const providerSettlementEndpoint = await client.query<{ is_nullable: string }>(`
        select is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'project_provider_settlements'
          and column_name = 'endpoint_id'
      `);
      assert.deepEqual(providerSettlementEndpoint.rows, [{ is_nullable: "YES" }]);

      const chatThreadEndpoint = await client.query<{ is_nullable: string }>(`
        select is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'project_chat_threads'
          and column_name = 'endpoint_id'
      `);
      assert.deepEqual(chatThreadEndpoint.rows, [{ is_nullable: "YES" }]);

      const endpointForeignKeys = await client.query<{ table_name: string; definition: string }>(`
        select t.relname as table_name, pg_get_constraintdef(c.oid) as definition
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        where c.conname in (
          'agent_tasks_endpoint_id_fkey',
          'project_chat_threads_endpoint_id_fkey',
          'project_provider_settlements_endpoint_id_fkey'
        )
        order by t.relname
      `);
      assert.match(endpointForeignKeys.rows.find((row) => row.table_name === "agent_tasks")?.definition ?? "", /FOREIGN KEY \(endpoint_id\).*model_endpoints\(id\)(?!.*SET NULL)/i);
      assert.match(endpointForeignKeys.rows.find((row) => row.table_name === "project_chat_threads")?.definition ?? "", /ON DELETE SET NULL/i);
      assert.match(endpointForeignKeys.rows.find((row) => row.table_name === "project_provider_settlements")?.definition ?? "", /ON DELETE SET NULL/i);
      const endpointIndexes = await client.query<{ indexname: string; indexdef: string }>("select indexname,indexdef from pg_indexes where schemaname='public' and tablename='model_endpoints'");
      assert.match(endpointIndexes.rows.find((row) => row.indexname === "model_endpoints_project_name_unique")?.indexdef ?? "", /unique.*project_id.*lower\(btrim\(name\)\)/i);

      const legacyAliasColumn = await client.query<{ is_nullable: string }>(`
        select is_nullable
        from information_schema.columns
        where table_schema = 'public' and table_name = 'model_endpoints' and column_name = 'api_key_secret_ref'
      `);
      assert.deepEqual(legacyAliasColumn.rows, [{ is_nullable: "YES" }]);

      const messageColumns = await client.query<{ column_name: string; is_nullable: string }>(`
        select column_name, is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'agent_tasks' and column_name = 'source_task_id')
            or (table_name = 'task_messages' and column_name = 'target_task_id'))
        order by table_name, column_name
      `);
      assert.deepEqual(messageColumns.rows, [
        { column_name: "source_task_id", is_nullable: "YES" },
        { column_name: "target_task_id", is_nullable: "YES" }
      ]);
      const removed = await client.query<{ table_name:string }>("select table_name from information_schema.tables where table_schema='public' and table_name in ('agent_task_events','task_follow_ups')");
      assert.deepEqual(removed.rows, []);
    } finally {
      await client.end();
    }
  });

  it("drops the legacy audit action check before rewriting follow-up rows", async () => {
    assert.ok(postgresUrl);
    const migration = (await readPostgresMigrations()).find((item) => item.id === "047_task_interaction_changes");
    assert.ok(migration);
    const dropAt = migration.sql.indexOf("alter table project_audit_events drop constraint if exists project_audit_events_action_check");
    const rewriteAt = migration.sql.indexOf("update project_audit_events set action='task.message.create' where action='task.follow_up.create'");
    const installAt = migration.sql.indexOf("alter table project_audit_events add constraint project_audit_events_action_check");
    assert.ok(dropAt >= 0 && dropAt < rewriteAt && rewriteAt < installAt);

    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query("begin");
      const ids = await insertProjectFixture(client, "legacy_follow_up_audit");
      const auditIds = ["create","edit","delete"].map((operation) => `audit_legacy_follow_up_${operation}_${ids.suffix}`);
      await client.query("alter table project_audit_events drop constraint project_audit_events_action_check");
      await client.query("alter table project_audit_events add constraint project_audit_events_action_check check (action not like 'task.message.%') not valid");
      for (const [index, operation] of ["create","edit","delete"].entries()) {
        await client.query("insert into project_audit_events (id,project_id,actor_id,action,status,resource_kind,resource_id,created_at) values ($1,$2,$3,$4,'accepted','task',$2,now())", [auditIds[index],ids.projectId,ids.userId,`task.follow_up.${operation}`]);
      }
      await client.query("savepoint constrained_rewrite");
      await assert.rejects(client.query("update project_audit_events set action=replace(action,'task.follow_up.','task.message.') where id=any($1)", [auditIds]), isCheckViolation);
      await client.query("rollback to savepoint constrained_rewrite");
      await client.query("alter table project_audit_events drop constraint project_audit_events_action_check");
      await client.query("update project_audit_events set action=replace(action,'task.follow_up.','task.message.') where id=any($1)", [auditIds]);
      assert.deepEqual((await client.query<{ action:string }>("select action from project_audit_events where id=any($1) order by action", [auditIds])).rows, [{action:"task.message.create"},{action:"task.message.delete"},{action:"task.message.edit"}]);
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  });

  it("backfills owner memberships for existing projects idempotently", async () => {
    assert.ok(postgresUrl);
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const userId = `migration_owner_${suffix}`;
      const workspaceId = `migration_workspace_${suffix}`;
      const projectId = `migration_project_${suffix}`;
      const timestamp = new Date().toISOString();
      await client.query(
        `insert into users (id, email, oidc_issuer, oidc_subject, email_verified, password_hash, created_at, updated_at)
         values ($1, $2, $3, $4, true, 'external:oidc', $5, $5)`,
        [userId, `${userId}@example.test`, "https://keycloak.example.test/realms/agentsmith", userId, timestamp]
      );
      await client.query(
        `insert into workspaces (id, name, owner_user_id, created_at, updated_at)
         values ($1, 'Migration workspace', $2, $3, $3)`,
        [workspaceId, userId, timestamp]
      );
      await client.query(
        `insert into projects (id, workspace_id, name, owner_user_id, root_path, task_concurrency_limit, created_at, updated_at)
         values ($1, $2, 'Migration project', $3, $4, 2, $5, $5)`,
        [projectId, workspaceId, userId, `workspaces/${workspaceId}/projects/${projectId}`, timestamp]
      );
      const migration = (await readPostgresMigrations()).find((item) => item.id === "006_project_owner_memberships");
      assert.ok(migration);
      await client.query(migration.sql);
      await client.query(migration.sql);
      const membership = await client.query<{ role: string }>(
        "select role from project_memberships where project_id = $1 and user_id = $2",
        [projectId, userId]
      );
      assert.deepEqual(membership.rows, [{ role: "owner" }]);
    } finally {
      await client.end();
    }
  });

  it("enforces closed phase-5 alert and audit metadata values", async () => {
    assert.ok(postgresUrl);
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      const ids = await insertProjectFixture(client, "phase5_constraints");
      const timestamp = new Date().toISOString();
      await assert.rejects(
        client.query("insert into project_alerts (id, project_id, type, status, created_at, updated_at) values ($1, $2, 'not_an_alert', 'active', $3, $3)", [`alert_${ids.suffix}`, ids.projectId, timestamp]),
        isCheckViolation
      );
      await assert.rejects(
        client.query("insert into project_audit_events (id, project_id, actor_id, action, status, resource_kind, resource_id, created_at) values ($1, $2, $3, 'not_an_action', 'accepted', 'project', $2, $4)", [`audit_action_${ids.suffix}`, ids.projectId, ids.userId, timestamp]),
        isCheckViolation
      );
      await assert.rejects(
        client.query("insert into project_audit_events (id, project_id, actor_id, action, status, resource_kind, resource_id, created_at) values ($1, $2, $3, 'policy.update', 'accepted', 'not_a_kind', $2, $4)", [`audit_kind_${ids.suffix}`, ids.projectId, ids.userId, timestamp]),
        isCheckViolation
      );
    } finally {
      await client.end();
    }
  });

  it("permits workspace context while rejecting invalid context ownership shapes", async () => {
    assert.ok(postgresUrl);
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      const ids = await insertProjectFixture(client, "context_scope");
      const timestamp = new Date().toISOString();
      await client.query(
        `insert into project_context_entries (
           id, workspace_id, project_id, owner_user_id, scope, context_key,
           content, name, user_id, created_at, updated_at
         ) values ($1, $2, null, null, 'workspace_shared', 'instructions', 'safe', 'instructions', null, $3, $3)`,
        [`context_workspace_${ids.suffix}`, ids.workspaceId, timestamp]
      );
      await assert.rejects(
        client.query(
          `insert into project_context_entries (
             id, workspace_id, project_id, owner_user_id, scope, context_key,
             content, name, user_id, created_at, updated_at
           ) values ($1, $2, $3, null, 'workspace_shared', 'invalid', 'safe', 'invalid', null, $4, $4)`,
          [`context_invalid_${ids.suffix}`, ids.workspaceId, ids.projectId, timestamp]
        ),
        isCheckViolation
      );
    } finally {
      await client.end();
    }
  });

  it("normalizes legacy audit actions and resource kinds in the phase-5 migration", async () => {
    assert.ok(postgresUrl);
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      const migrations = await readPostgresMigrations();
      const phase5 = migrations.findIndex((migration) => migration.id === "009_phase5_audit_metadata");
      assert.ok(phase5 > 0);
      const schema = `migration_phase5_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      await client.query("begin");
      await client.query(`create schema ${quoteIdentifier(schema)}`);
      await client.query(`set local search_path to ${quoteIdentifier(schema)}, public`);
      for (const migration of migrations.slice(0, phase5)) await client.query(migration.sql);
      const ids = await insertProjectFixture(client, "phase5_normalization");
      const timestamp = new Date().toISOString();
      await client.query(
        "insert into project_audit_events (id, project_id, actor_id, action, status, resource_id, created_at) values ($1, $2, $3, 'sandbox.terminal', 'accepted', $4, $5)",
        [`audit_legacy_${ids.suffix}`, ids.projectId, ids.userId, ids.projectId, timestamp]
      );
      await client.query(migrations[phase5]!.sql);
      const normalized = await client.query<{ action: string; resource_kind: string }>("select action, resource_kind from project_audit_events where id = $1", [`audit_legacy_${ids.suffix}`]);
      assert.deepEqual(normalized.rows, [{ action: "sandbox.failed", resource_kind: "sandbox" }]);
      await client.query("rollback");
    } finally {
      await client.end();
    }
  });

  it("upgrades 043 endpoint history rows through 044 idempotently", async () => {
    assert.ok(postgresUrl);
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      const migrations = await readPostgresMigrations();
      const endpointDeletion = migrations.findIndex((migration) => migration.id === "044_endpoint_deletion_boundaries");
      assert.ok(endpointDeletion >= 0);
      const schema = `migration_endpoint_delete_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      await client.query("begin");
      await client.query(`create schema ${quoteIdentifier(schema)}`);
      await client.query(`set local search_path to ${quoteIdentifier(schema)}, public`);
      for (const migration of migrations.slice(0, endpointDeletion)) await client.query(migration.sql);

      const ids = await insertProjectFixture(client, "endpoint_delete_upgrade");
      const timestamp = "2026-07-12T00:00:00.000Z";
      const endpointId = `endpoint_${ids.suffix}`;
      await client.query(
        `insert into model_endpoints (
           id, project_id, name, protocol, base_url, model, api_key_secret_ref,
           capabilities, request_timeout_secs, created_at, updated_at
         ) values ($1, $2, 'Endpoint', 'openai_chat_completions', 'https://models.example.test/v1', 'model', 'secret/upgrade', '["text"]'::jsonb, 30, $3, $3)`,
        [endpointId, ids.projectId, timestamp]
      );
      await client.query(
        "insert into project_chat_threads (id, project_id, endpoint_id, title, created_at, updated_at) values ($1, $2, $3, 'Retained thread', $4, $4)",
        [`thread_${ids.suffix}`, ids.projectId, endpointId, timestamp]
      );
      await client.query(
        `insert into project_provider_settlements (
           id, project_id, endpoint_id, status, reserved_tokens, reserved_cost,
           reserved_at, expires_at, updated_at
         ) values ($1, $2, $3, 'settled', 0, 0, $4, $5, $4)`,
        [`settlement_${ids.suffix}`, ids.projectId, endpointId, timestamp, "2026-07-12T00:01:00.000Z"]
      );

      const migration = migrations[endpointDeletion]!;
      await client.query(migration.sql);
      await client.query(migration.sql);
      await client.query("delete from model_endpoints where id = $1", [endpointId]);

      const retained = await client.query<{ thread_endpoint_id: string | null; settlement_endpoint_id: string | null }>(
        `select t.endpoint_id as thread_endpoint_id, s.endpoint_id as settlement_endpoint_id
         from project_chat_threads t
         join project_provider_settlements s on s.project_id = t.project_id
         where t.id = $1 and s.id = $2`,
        [`thread_${ids.suffix}`, `settlement_${ids.suffix}`]
      );
      assert.deepEqual(retained.rows, [{ thread_endpoint_id: null, settlement_endpoint_id: null }]);
      await client.query("rollback");
    } finally {
      await client.end();
    }
  });
});

async function insertProjectFixture(client: pg.Client, prefix: string) {
  const suffix = `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const userId = `user_${suffix}`;
  const workspaceId = `workspace_${suffix}`;
  const projectId = `project_${suffix}`;
  const timestamp = new Date().toISOString();
  await client.query(
    `insert into users (id, email, oidc_issuer, oidc_subject, email_verified, password_hash, created_at, updated_at)
     values ($1, $2, $3, $4, true, 'external:oidc', $5, $5)`,
    [userId, `${userId}@example.test`, "https://keycloak.example.test/realms/agentsmith", userId, timestamp]
  );
  await client.query(
    "insert into workspaces (id, name, owner_user_id, created_at, updated_at) values ($1, 'Migration workspace', $2, $3, $3)",
    [workspaceId, userId, timestamp]
  );
  await client.query(
    "insert into projects (id, workspace_id, name, owner_user_id, root_path, task_concurrency_limit, created_at, updated_at) values ($1, $2, 'Migration project', $3, $4, 2, $5, $5)",
    [projectId, workspaceId, userId, `workspaces/${workspaceId}/projects/${projectId}`, timestamp]
  );
  return { suffix, userId, workspaceId, projectId };
}

function isCheckViolation(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === "23514";
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
