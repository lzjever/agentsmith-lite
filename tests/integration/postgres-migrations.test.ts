import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import pg from "pg";
import { readPostgresMigrations } from "../../packages/adapters-postgres/src/migrations.js";
import { readPostgresTestUrl } from "./postgres-test-database.js";

const postgresUrl = readPostgresTestUrl();
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("postgres migrations", { concurrency: false }, () => {
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
            'sandbox_runs',
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
        "sandbox_runs",
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

      const removedChatTables = await client.query<{ table_name: string }>(`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('project_chat_threads', 'project_chat_messages')
      `);
      assert.deepEqual(removedChatTables.rows, []);

      const finalAuditConstraints = await client.query<{ conname: string; definition: string }>(`
        select conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conrelid = 'project_audit_events'::regclass
          and conname in ('project_audit_events_action_check', 'project_audit_events_resource_kind_check')
        order by conname
      `);
      assert.equal(finalAuditConstraints.rows.length, 2);
      assert.equal(finalAuditConstraints.rows.every((row) => !/chat[._]/i.test(row.definition)), true);

      const removedTaskExecutionColumns = await client.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'agent_tasks'
          and column_name = any($1)
      `, [[
        "status","run_id","execution_mode","active_reservation","terminal_reason","terminalized_at",
        "start_intent_status","artifact_projection_status","cleanup_status","sandbox",
        "finalization_intent_status"
      ]]);
      assert.deepEqual(removedTaskExecutionColumns.rows, []);

      const runStateConstraint = await client.query<{ definition: string }>(`
        select pg_get_constraintdef(c.oid) as definition
        from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'sandbox_runs' and c.conname = 'sandbox_runs_state_check'
      `);
      assert.match(runStateConstraint.rows[0]?.definition ?? "", /starting.*active.*release_requested.*failed.*released/i);
      const failureCodeColumn=await client.query<{column_name:string}>("select column_name from information_schema.columns where table_schema='public' and table_name='sandbox_runs' and column_name='failure_code'");
      assert.deepEqual(failureCodeColumn.rows,[{column_name:"failure_code"}]);
      const startupLeaseColumns=await client.query<{column_name:string}>("select column_name from information_schema.columns where table_schema='public' and table_name='sandbox_runs' and column_name in ('startup_claim_token','startup_lease_expires_at') order by column_name");
      assert.deepEqual(startupLeaseColumns.rows,[{column_name:"startup_claim_token"},{column_name:"startup_lease_expires_at"}]);
      const releaseReasonConstraints=await client.query<{table_name:string;definition:string}>(`select t.relname as table_name,pg_get_constraintdef(c.oid) as definition from pg_constraint c join pg_class t on t.oid=c.conrelid where c.conname in ('sandbox_runs_release_reason_check','sandbox_usage_settlements_release_reason_check') order by t.relname`);
      assert.equal(releaseReasonConstraints.rows.length,2);
      assert.equal(releaseReasonConstraints.rows.every((row)=>/requested.*failed.*cleanup/i.test(row.definition)&&!/ttl/i.test(row.definition)),true);
      const unreleasedIndex = await client.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where schemaname='public' and indexname='sandbox_runs_one_unreleased_per_task'"
      );
      assert.match(unreleasedIndex.rows[0]?.indexdef ?? "", /unique.*task_id.*state.*released/i);

      const providerSettlementEndpoint = await client.query<{ is_nullable: string }>(`
        select is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'project_provider_settlements'
          and column_name = 'endpoint_id'
      `);
      assert.deepEqual(providerSettlementEndpoint.rows, [{ is_nullable: "YES" }]);

      const endpointForeignKeys = await client.query<{ table_name: string; definition: string }>(`
        select t.relname as table_name, pg_get_constraintdef(c.oid) as definition
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        where c.conname in (
          'agent_tasks_endpoint_id_fkey',
          'project_provider_settlements_endpoint_id_fkey'
        )
        order by t.relname
      `);
      assert.match(endpointForeignKeys.rows.find((row) => row.table_name === "agent_tasks")?.definition ?? "", /FOREIGN KEY \(endpoint_id\).*model_endpoints\(id\)(?!.*SET NULL)/i);
      assert.match(endpointForeignKeys.rows.find((row) => row.table_name === "project_provider_settlements")?.definition ?? "", /ON DELETE SET NULL/i);
      const endpointIndexes = await client.query<{ indexname: string; indexdef: string }>("select indexname,indexdef from pg_indexes where schemaname='public' and tablename='model_endpoints'");
      assert.match(endpointIndexes.rows.find((row) => row.indexname === "model_endpoints_project_name_unique")?.indexdef ?? "", /unique.*project_id.*lower\(btrim\(name\)\)/i);

      const endpointCredentialColumn = await client.query<{ is_nullable: string }>(`
        select is_nullable
        from information_schema.columns
        where table_schema = 'public' and table_name = 'model_endpoints' and column_name = 'credential_id'
      `);
      assert.deepEqual(endpointCredentialColumn.rows, [{ is_nullable: "NO" }]);
      const legacyAliasColumn = await client.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = 'model_endpoints' and column_name = 'api_key_secret_ref'
      `);
      assert.deepEqual(legacyAliasColumn.rows, []);

      const messageColumns = await client.query<{ column_name: string; is_nullable: string }>(`
        select column_name, is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'agent_tasks' and column_name = 'source_task_id')
            or (table_name = 'task_messages' and column_name = 'target_task_id'))
        order by table_name, column_name
      `);
      assert.deepEqual(messageColumns.rows, []);
      const removed = await client.query<{ table_name:string }>("select table_name from information_schema.tables where table_schema='public' and table_name in ('agent_task_events','task_follow_ups')");
      assert.deepEqual(removed.rows, []);
      const cutover=(await readPostgresMigrations()).find((migration)=>migration.id==="066_converge_task_turn_run_state");
      assert.ok(cutover);
      assert.match(cutover.sql,/delete from project_provider_settlements where task_id is not null;[\s\S]*update project_resource_usage/i);
      assert.match(cutover.sql,/provider_requests\s*=\s*\([\s\S]*status <> 'failed'/i);
      assert.match(cutover.sql,/tg_op = 'DELETE'[\s\S]*lifecycle_status = 'deleting'/i);
      assert.match(cutover.sql,/drop constraint if exists agent_tasks_file_library_tombstone_check/i);
    } finally {
      await client.end();
    }
  });

  it("preserves non-Task receipts, bound endpoints, and read-only historical rows through migration 066", async () => {
    assert.ok(postgresUrl);
    await withMigration066Database(postgresUrl, async (client, cutoverSql) => {
      await client.query("begin");

      const ids = await insertProjectFixture(client, "cutover_preserve");
      const timestamp = new Date().toISOString();
      const credentialId = `credential_${ids.suffix}`;
      const endpointId = `endpoint_${ids.suffix}`;
      await client.query(
        "insert into project_credentials (id,project_id,name,base_url,created_at,updated_at) values ($1,$2,'Bound credential','https://api.example.test',$3,$3)",
        [credentialId, ids.projectId, timestamp]
      );
      await client.query(
        `insert into model_endpoints (
           id,project_id,name,protocol,base_url,model,api_key_secret_ref,capabilities,
           request_timeout_secs,credential_id,created_at,updated_at
         ) values ($1,$2,'Bound endpoint','openai_chat_completions','https://api.example.test','model','stale-alias','[]'::jsonb,30,$3,$4,$4)`,
        [endpointId, ids.projectId, credentialId, timestamp]
      );

      const taskOperations = [
        "create","message","message-edit","message-delete","abort-turn","work-stop",
        "release-sandbox","edit","archive","delete",
        "retry","duplicate","cancel","follow-up","follow-up-edit","follow-up-delete",
      ];
      const preservedOperations = [
        "workspace.create","project.create","project.credential.create",
        "project.file.upload","project.policy.update","project.member.add",
      ];
      await client.query(
        `insert into task_idempotency_records (
           actor_id,project_id,operation,idempotency_key,request_hash,resource_id,
           status,claim_token,lease_expires_at,created_at,updated_at
         )
         select $1,$2,operation,'key-'||ordinality,'hash-'||ordinality,'resource-'||ordinality,
                'in_progress','claim-'||ordinality,$3::timestamptz,$4::timestamptz,$4::timestamptz
         from unnest($5::text[]) with ordinality as operations(operation,ordinality)`,
        [ids.userId, ids.projectId, new Date(Date.now() + 60_000).toISOString(), timestamp, [...taskOperations, ...preservedOperations]]
      );

      const ruleIds = [1, 2, 3].map((value) => `alert_rule_task_${value}_${ids.suffix}`);
      for (const [index, ruleId] of ruleIds.entries()) {
        await client.query(
          `insert into project_alert_rules (
             id,project_id,alert_type,name,metric,condition,threshold,window_seconds,
             scope_kind,endpoint_id,enabled,created_at,updated_at
           ) values ($1,$2,'task_failure',$3,'failure_count','greater_than_or_equal',1,3600,'project',null,$4,$5,$5)`,
          [ruleId, ids.projectId, `Task failure ${index + 1}`, index !== 1, timestamp]
        );
      }
      const activeRuleId = `alert_rule_sandbox_${ids.suffix}`;
      await client.query(
        `insert into project_alert_rules (
           id,project_id,alert_type,name,metric,condition,threshold,window_seconds,
           scope_kind,endpoint_id,enabled,created_at,updated_at
         ) values ($1,$2,'sandbox_failure','Sandbox failure','failure_count','greater_than_or_equal',1,3600,'project',null,true,$3,$3)`,
        [activeRuleId, ids.projectId, timestamp]
      );
      const alertIds = ["active", "resolved", "dismissed"].map((status) => `alert_task_${status}_${ids.suffix}`);
      await client.query(
        `insert into project_alerts (
           id,project_id,type,status,delivery_status,rule_id,created_at,updated_at,resolved_at,dismissed_at
         ) values
           ($1,$4,'task_failure','active','delivered',$5,$8,$8,null,null),
           ($2,$4,'task_failure','resolved','delivered',$6,$8,$8,$8,null),
           ($3,$4,'task_failure','dismissed','delivered',$7,$8,$8,null,$8)`,
        [alertIds[0], alertIds[1], alertIds[2], ids.projectId, ruleIds[0], ruleIds[1], ruleIds[2], timestamp]
      );
      await client.query(
        "insert into project_alerts (id,project_id,type,status,delivery_status,created_at,updated_at,resolved_at) values ($1,$2,'sandbox_failure','resolved','delivered',$3,$3,$3)",
        [`alert_sandbox_${ids.suffix}`, ids.projectId, timestamp]
      );

      const terminalActions = ["task.cancel","task.completed","task.failed","task.expired","task.cleaned"];
      for (const [index, action] of terminalActions.entries()) {
        await client.query(
          `insert into project_audit_events (
             id,project_id,actor_id,action,status,resource_kind,resource_id,detail,created_at
           ) values ($1,$2,$3,$4,'accepted','task',$5,$6::jsonb,$7)`,
          [
            `audit_terminal_${index}_${ids.suffix}`,
            ids.projectId,
            ids.userId,
            action,
            `task_terminal_${index}_${ids.suffix}`,
            JSON.stringify({ taskId: `task_terminal_${index}_${ids.suffix}`, historicalAction: "unsafe-value" }),
            timestamp,
          ]
        );
      }

      await client.query(cutoverSql);

      assert.deepEqual(
        (await client.query<{ operation:string }>("select operation from task_idempotency_records order by operation")).rows.map((row) => row.operation),
        [...preservedOperations].sort()
      );
      assert.deepEqual(
        (await client.query<{ id:string; credential_id:string }>("select id,credential_id from model_endpoints")).rows,
        [{ id:endpointId, credential_id:credentialId }]
      );
      assert.deepEqual(
        (await client.query<{ column_name:string }>("select column_name from information_schema.columns where table_schema=current_schema() and table_name='model_endpoints' and column_name='api_key_secret_ref'")).rows,
        []
      );

      const historicalAlerts = await client.query<{ id:string; type:string; status:string; resolved_at:Date|null }>(
        "select id,type,status,resolved_at from project_alerts where id=any($1) order by id",
        [alertIds]
      );
      assert.equal(historicalAlerts.rowCount, 3);
      assert.equal(historicalAlerts.rows.every((row) => row.type === "historical_task_failure"), true);
      assert.deepEqual(historicalAlerts.rows.map((row) => row.status).sort(), ["dismissed","resolved","resolved"]);
      assert.notEqual(historicalAlerts.rows.find((row) => row.id === alertIds[0])?.resolved_at, null);
      assert.equal((await client.query("select 1 from project_alerts where type='sandbox_failure'")).rowCount, 1);

      const historicalRules = await client.query<{ alert_type:string; enabled:boolean; retired_was_enabled:boolean }>(
        "select alert_type,enabled,retired_was_enabled from project_alert_rules where id=any($1) order by id",
        [ruleIds]
      );
      assert.equal(historicalRules.rowCount, 3);
      assert.equal(historicalRules.rows.every((row) => row.alert_type === "historical_task_failure" && row.enabled === false), true);
      assert.deepEqual(historicalRules.rows.map((row) => row.retired_was_enabled), [true,false,true]);
      assert.deepEqual(
        (await client.query<{ retired_was_enabled:boolean|null }>("select retired_was_enabled from project_alert_rules where id=$1", [activeRuleId])).rows,
        [{ retired_was_enabled:null }]
      );

      const historicalAudits = await client.query<{ action:string; resource_id:string; detail:Record<string,unknown> }>(
        "select action,resource_id,detail from project_audit_events where id like $1 order by resource_id",
        [`audit_terminal_%_${ids.suffix}`]
      );
      assert.equal(historicalAudits.rowCount, terminalActions.length);
      assert.equal(historicalAudits.rows.every((row) => row.action === "task.historical_terminal"), true);
      assert.deepEqual(historicalAudits.rows.map((row) => row.resource_id), terminalActions.map((_, index) => `task_terminal_${index}_${ids.suffix}`));
      assert.deepEqual(historicalAudits.rows.map((row) => row.detail.historicalAction), terminalActions);

      await client.query("savepoint historical_alert_active");
      await assert.rejects(client.query("update project_alerts set status='active' where id=$1", [alertIds[0]]), isCheckViolation);
      await client.query("rollback to savepoint historical_alert_active");
      await client.query("savepoint historical_rule_enabled");
      await assert.rejects(client.query("update project_alert_rules set enabled=true where id=$1", [ruleIds[0]]), isCheckViolation);
      await client.query("rollback to savepoint historical_rule_enabled");
      await client.query("savepoint historical_rule_marker");
      await assert.rejects(client.query("update project_alert_rules set retired_was_enabled=null where id=$1", [ruleIds[0]]), isCheckViolation);
      await client.query("rollback to savepoint historical_rule_marker");
      await client.query("savepoint active_rule_marker");
      await assert.rejects(client.query("update project_alert_rules set retired_was_enabled=true where id=$1", [activeRuleId]), isCheckViolation);
      await client.query("rollback to savepoint active_rule_marker");
      await client.query("rollback");
    });
  });

  it("rolls back all of migration 066 when any endpoint lacks a credential binding", async () => {
    assert.ok(postgresUrl);
    await withMigration066Database(postgresUrl, async (client, cutoverSql) => {
      await client.query("begin");

      const ids = await insertProjectFixture(client, "cutover_rollback");
      const timestamp = new Date().toISOString();
      const aliasBackedId = `endpoint_alias_backed_${ids.suffix}`;
      const aliasFreeId = `endpoint_alias_free_${ids.suffix}`;
      for (const [endpointId, alias] of [[aliasBackedId, "legacy-alias"], [aliasFreeId, null]] as const) {
        await client.query(
          `insert into model_endpoints (
             id,project_id,name,protocol,base_url,model,api_key_secret_ref,capabilities,
             request_timeout_secs,credential_id,created_at,updated_at
           ) values ($1,$2,$3,'openai_chat_completions','https://api.example.test','model',$4,'[]'::jsonb,30,null,$5,$5)`,
          [endpointId, ids.projectId, endpointId, alias, timestamp]
        );
      }
      await client.query(
        `insert into task_idempotency_records (
           actor_id,project_id,operation,idempotency_key,request_hash,resource_id,
           status,claim_token,lease_expires_at,created_at,updated_at
         ) values ($1,$2,'create','task-key','task-hash','task-resource','in_progress','task-claim',$3,$4,$4)`,
        [ids.userId, ids.projectId, new Date(Date.now() + 60_000).toISOString(), timestamp]
      );

      await client.query("savepoint migration_066");
      await assert.rejects(
        client.query(cutoverSql),
        (error:unknown) => error instanceof Error
          && (error as {code?:string}).code === "23514"
          && /alias-backed=1/.test(error.message)
          && /alias-free=1/.test(error.message)
          && error.message.includes(aliasBackedId)
          && error.message.includes(aliasFreeId)
      );
      await client.query("rollback to savepoint migration_066");

      assert.equal((await client.query("select 1 from model_endpoints where id=any($1)", [[aliasBackedId, aliasFreeId]])).rowCount, 2);
      assert.equal((await client.query("select 1 from task_idempotency_records where operation='create'")).rowCount, 1);
      assert.deepEqual(
        (await client.query<{ column_name:string }>("select column_name from information_schema.columns where table_schema=current_schema() and table_name='model_endpoints' and column_name='api_key_secret_ref'")).rows,
        [{ column_name:"api_key_secret_ref" }]
      );
      assert.deepEqual(
        (await client.query<{ is_nullable:string }>("select is_nullable from information_schema.columns where table_schema=current_schema() and table_name='model_endpoints' and column_name='credential_id'")).rows,
        [{ is_nullable:"YES" }]
      );
      await client.query("rollback");
    });
  });

  it("applies pending migration 066 once and clears only Task storage", async () => {
    assert.ok(postgresUrl);
    await withPendingMigration066Database(postgresUrl, async ({ client, databaseUrl, dataRoot }) => {
      const first = await insertProjectFixture(client, "cutover_storage_first");
      const second = await insertProjectFixture(client, "cutover_storage_second");
      const firstLibraries = await insertFileLibraries(client, first, ["primary", "secondary"]);
      const secondLibraries = await insertFileLibraries(client, second, ["primary"]);
      const firstFiles = await createStorageCutoverFixture(dataRoot, first, firstLibraries);
      const secondFiles = await createStorageCutoverFixture(dataRoot, second, secondLibraries);

      const kubernetesLog = path.join(dataRoot, "kubernetes-requests.jsonl");
      const result = await spawnMigrationRunner(databaseUrl, dataRoot, {
        mode: "live",
        kubernetesLog,
        storageMarker: firstFiles.tasksRoot
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /applied migration 066_converge_task_turn_run_state\.sql/);
      assert.equal(await migration066LedgerCount(client), 1);
      const kubernetesRequests = await readKubernetesRequests(kubernetesLog);
      const deletes = kubernetesRequests.filter((request) => request.method === "DELETE");
      assert.deepEqual(
        deletes.map((request) => request.path).sort(),
        [
          "/api/v1/namespaces/agentsmith-migration-test/configmaps/schema-owned-configmap",
          "/api/v1/namespaces/agentsmith-migration-test/pods/schema-owned-pod",
          "/api/v1/namespaces/agentsmith-migration-test/secrets/schema-owned-secret",
          "/api/v1/namespaces/agentsmith-migration-test/serviceaccounts/schema-owned-serviceaccount",
          "/api/v1/namespaces/agentsmith-migration-test/services/schema-owned-service",
          "/apis/networking.k8s.io/v1/namespaces/agentsmith-migration-test/networkpolicies/schema-owned-networkpolicy"
        ].sort()
      );
      assert.equal(deletes.every((request) => request.storageMarkerExists), true);
      for (const request of deletes) {
        const deleteOptions = JSON.parse(request.body) as {
          preconditions?: { uid?: string };
        };
        assert.equal(deleteOptions.preconditions?.uid, `uid-${request.path.split("/").at(-1)}`);
      }
      assert.equal(
        kubernetesRequests.some((request) => request.path.endsWith("/pods/schema-incomplete-pod")),
        false
      );
      for (const fixture of [firstFiles, secondFiles]) {
        assert.equal(await pathExists(fixture.tasksRoot), false);
        assert.equal(await pathExists(fixture.projectFile), true);
        assert.equal(await pathExists(fixture.otherProjectDirectoryFile), true);
        for (const library of fixture.libraries) {
          assert.equal(await pathExists(library.artifactsRoot), false);
          assert.equal(await pathExists(library.workspaceFile), true);
          assert.equal(await pathExists(library.homeFile), true);
        }
      }
    });
  });

  it("leaves migration 066 storage untouched when its SQL fails", async () => {
    assert.ok(postgresUrl);
    await withPendingMigration066Database(postgresUrl, async ({ client, databaseUrl, dataRoot }) => {
      const project = await insertProjectFixture(client, "cutover_storage_sql_fail");
      const libraries = await insertFileLibraries(client, project, ["primary"]);
      const files = await createStorageCutoverFixture(dataRoot, project, libraries);
      const timestamp = new Date().toISOString();
      await client.query(
        `insert into model_endpoints (
           id,project_id,name,protocol,base_url,model,api_key_secret_ref,capabilities,
           request_timeout_secs,credential_id,created_at,updated_at
         ) values ($1,$2,'Unbound endpoint','openai_chat_completions','https://api.example.test','model',
           'legacy-alias','[]'::jsonb,30,null,$3,$3)`,
        [`endpoint_${project.suffix}`, project.projectId, timestamp]
      );

      const kubernetesLog = path.join(dataRoot, "kubernetes-requests.jsonl");
      const result = await spawnMigrationRunner(databaseUrl, dataRoot, {
        mode: "live",
        kubernetesLog,
        storageMarker: files.tasksRoot
      });

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /requires every model endpoint to bind credential_id/i);
      assert.equal(await migration066LedgerCount(client), 0);
      assert.equal((await client.query("select 1 from model_endpoints where id=$1", [`endpoint_${project.suffix}`])).rowCount, 1);
      assert.equal(await pathExists(kubernetesLog), false);
      await assertStorageCutoverFixtureUntouched(files);
    });
  });

  it("preflights every migration 066 path before removing any storage", async () => {
    assert.ok(postgresUrl);
    await withPendingMigration066Database(postgresUrl, async ({ client, databaseUrl, dataRoot }) => {
      const safeProject = await insertProjectFixture(client, "a_cutover_storage_safe");
      const unsafeProject = await insertProjectFixture(client, "z_cutover_storage_unsafe");
      const safeLibraries = await insertFileLibraries(client, safeProject, ["primary"]);
      await insertFileLibraries(client, unsafeProject, ["primary"]);
      const safeFiles = await createStorageCutoverFixture(dataRoot, safeProject, safeLibraries);

      const unsafeProjectRoot = path.resolve(dataRoot, projectRootPath(unsafeProject));
      const outsideRoot = await mkdtemp(path.join(tmpdir(), "agentsmith-lite-066-outside-"));
      try {
        await mkdir(path.dirname(unsafeProjectRoot), { recursive: true });
        await mkdir(path.join(outsideRoot, "tasks", "legacy-task"), { recursive: true });
        await writeFile(path.join(outsideRoot, "tasks", "legacy-task", "state.json"), "outside");
        await symlink(outsideRoot, unsafeProjectRoot, "dir");

        const result = await spawnMigrationRunner(databaseUrl, dataRoot);

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /symlink|symbolic link|unsafe.*path/i);
        assert.equal(await migration066LedgerCount(client), 0);
        assert.equal(await tableExists(client, "sandbox_runs"), false);
        await assertStorageCutoverFixtureUntouched(safeFiles);
        assert.equal(await pathExists(path.join(outsideRoot, "tasks", "legacy-task", "state.json")), true);
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  it("does not repeat migration 066 storage cleanup on an ordinary redeploy", async () => {
    assert.ok(postgresUrl);
    await withPendingMigration066Database(postgresUrl, async ({ client, databaseUrl, dataRoot, cutover }) => {
      const project = await insertProjectFixture(client, "cutover_storage_already_applied");
      const libraries = await insertFileLibraries(client, project, ["primary"]);
      await client.query("begin");
      await client.query(cutover.sql);
      await client.query(
        "insert into agentsmith_migrations (id,checksum) values ($1,$2)",
        [cutover.id, migrationChecksum(cutover.sql)]
      );
      await client.query("commit");
      const files = await createStorageCutoverFixture(dataRoot, project, libraries);

      const kubernetesLog = path.join(dataRoot, "kubernetes-requests.jsonl");
      const result = await spawnMigrationRunner(databaseUrl, dataRoot, {
        mode: "live",
        kubernetesLog,
        storageMarker: files.tasksRoot
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /skipped migration 066_converge_task_turn_run_state\.sql/);
      assert.equal(await migration066LedgerCount(client), 1);
      assert.equal(await pathExists(kubernetesLog), false);
      await assertStorageCutoverFixtureUntouched(files);
    });
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

async function withMigration066Database(
  sourceUrl: string,
  run: (client: pg.Client, cutoverSql: string) => Promise<void>
): Promise<void> {
  const migrations = await readPostgresMigrations();
  const cutoverIndex = migrations.findIndex((migration) => migration.id === "066_converge_task_turn_run_state");
  assert.ok(cutoverIndex > 0);

  const databaseName = `migration_066_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}_test`;
  const maintenanceUrl = new URL(sourceUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenanceClient = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await maintenanceClient.connect();
  let databaseCreated = false;

  try {
    try {
      await maintenanceClient.query(`create database ${quoteIdentifier(databaseName)}`);
      databaseCreated = true;
    } catch (error) {
      if (error instanceof Error && (error as { code?: string }).code === "42501") {
        throw new Error(
          "POSTGRES_TEST_URL must authenticate as a PostgreSQL role with CREATEDB for migration 066 isolation",
          { cause: error }
        );
      }
      throw error;
    }

    const isolatedUrl = new URL(sourceUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    const client = new pg.Client({ connectionString: isolatedUrl.toString() });
    let clientConnected = false;
    try {
      await client.connect();
      clientConnected = true;
      for (const migration of migrations.slice(0, cutoverIndex)) {
        await client.query(migration.sql);
      }
      await run(client, migrations[cutoverIndex]!.sql);
    } finally {
      if (clientConnected) {
        await client.end();
      }
    }
  } finally {
    try {
      if (databaseCreated) {
        await maintenanceClient.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
          [databaseName]
        );
        await maintenanceClient.query(`drop database ${quoteIdentifier(databaseName)}`);
      }
    } finally {
      await maintenanceClient.end();
    }
  }
}

interface Migration066ProjectFixture {
  suffix: string;
  userId: string;
  workspaceId: string;
  projectId: string;
}

interface StorageCutoverFixture {
  tasksRoot: string;
  projectFile: string;
  otherProjectDirectoryFile: string;
  libraries: Array<{
    artifactsRoot: string;
    workspaceFile: string;
    homeFile: string;
  }>;
}

async function withPendingMigration066Database(
  sourceUrl: string,
  run: (fixture: {
    client: pg.Client;
    databaseUrl: string;
    dataRoot: string;
    cutover: Awaited<ReturnType<typeof readPostgresMigrations>>[number];
  }) => Promise<void>
): Promise<void> {
  const migrations = await readPostgresMigrations();
  const cutoverIndex = migrations.findIndex((migration) => migration.id === "066_converge_task_turn_run_state");
  assert.ok(cutoverIndex > 0);
  const cutover = migrations[cutoverIndex]!;
  const databaseName = `migration_066_runner_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}_test`;
  const maintenanceUrl = new URL(sourceUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenanceClient = new pg.Client({ connectionString: maintenanceUrl.toString() });
  const dataRoot = await mkdtemp(path.join(tmpdir(), "agentsmith-lite-066-data-"));
  await maintenanceClient.connect();
  let databaseCreated = false;

  try {
    await maintenanceClient.query(`create database ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    const isolatedUrl = new URL(sourceUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    const databaseUrl = isolatedUrl.toString();
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("begin");
      await client.query(`
        create table agentsmith_migrations (
          id text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);
      for (const migration of migrations.slice(0, cutoverIndex)) {
        await client.query(migration.sql);
        await client.query(
          "insert into agentsmith_migrations (id,checksum) values ($1,$2)",
          [migration.id, migrationChecksum(migration.sql)]
        );
      }
      await client.query("commit");
      await run({ client, databaseUrl, dataRoot, cutover });
    } finally {
      await client.end();
    }
  } finally {
    try {
      if (databaseCreated) {
        await maintenanceClient.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()",
          [databaseName]
        );
        await maintenanceClient.query(`drop database ${quoteIdentifier(databaseName)}`);
      }
    } finally {
      await maintenanceClient.end();
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
}

async function insertFileLibraries(
  client: pg.Client,
  project: Migration066ProjectFixture,
  names: string[]
): Promise<Array<{ id: string; rootSubPath: string }>> {
  const timestamp = new Date().toISOString();
  const libraries = names.map((name) => ({
    id: `library_${name}_${project.suffix}`,
    rootSubPath: `libraries/library_${name}_${project.suffix}/home`
  }));
  for (const [index, library] of libraries.entries()) {
    await client.query(
      `insert into file_libraries (
         id,workspace_id,project_id,name,root_sub_path,created_by_user_id,created_at,updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [
        library.id,
        project.workspaceId,
        project.projectId,
        `Migration library ${index}`,
        library.rootSubPath,
        project.userId,
        timestamp
      ]
    );
  }
  return libraries;
}

async function createStorageCutoverFixture(
  dataRoot: string,
  project: Migration066ProjectFixture,
  libraries: Array<{ rootSubPath: string }>
): Promise<StorageCutoverFixture> {
  const projectRoot = path.resolve(dataRoot, projectRootPath(project));
  const tasksRoot = path.join(projectRoot, "tasks");
  const projectFile = path.join(projectRoot, "project-notes.txt");
  const otherProjectDirectoryFile = path.join(projectRoot, "exports", "keep.txt");
  await mkdir(path.join(tasksRoot, "legacy-task", "botified"), { recursive: true });
  await writeFile(path.join(tasksRoot, "legacy-task", "botified", "state.json"), "remove");
  await mkdir(path.dirname(otherProjectDirectoryFile), { recursive: true });
  await writeFile(projectFile, "keep");
  await writeFile(otherProjectDirectoryFile, "keep");

  const libraryFiles = [];
  for (const library of libraries) {
    const libraryHome = path.join(projectRoot, library.rootSubPath);
    const artifactsRoot = path.join(libraryHome, "workspace", ".artifacts");
    const workspaceFile = path.join(libraryHome, "workspace", "user-file.txt");
    const homeFile = path.join(libraryHome, "library-home.txt");
    await mkdir(path.join(artifactsRoot, "legacy-task"), { recursive: true });
    await writeFile(path.join(artifactsRoot, "legacy-task", "artifact.txt"), "remove");
    await writeFile(workspaceFile, "keep");
    await writeFile(homeFile, "keep");
    libraryFiles.push({ artifactsRoot, workspaceFile, homeFile });
  }
  return { tasksRoot, projectFile, otherProjectDirectoryFile, libraries: libraryFiles };
}

async function assertStorageCutoverFixtureUntouched(fixture: StorageCutoverFixture): Promise<void> {
  assert.equal(await pathExists(fixture.tasksRoot), true);
  assert.equal(await pathExists(fixture.projectFile), true);
  assert.equal(await pathExists(fixture.otherProjectDirectoryFile), true);
  for (const library of fixture.libraries) {
    assert.equal(await pathExists(library.artifactsRoot), true);
    assert.equal(await pathExists(library.workspaceFile), true);
    assert.equal(await pathExists(library.homeFile), true);
  }
}

function projectRootPath(project: Migration066ProjectFixture): string {
  return `workspaces/${project.workspaceId}/projects/${project.projectId}`;
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function migration066LedgerCount(client: pg.Client): Promise<number> {
  const result = await client.query<{ count: string }>(
    "select count(*) from agentsmith_migrations where id='066_converge_task_turn_run_state'"
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function tableExists(client: pg.Client, tableName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    "select to_regclass($1) is not null as exists",
    [`public.${tableName}`]
  );
  return result.rows[0]?.exists === true;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function spawnMigrationRunner(
  databaseUrl: string,
  dataRoot: string,
  options: {
    mode?: "dry-run" | "live";
    kubernetesLog?: string;
    storageMarker?: string;
  } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const preload = path.resolve("tests/integration/migration066-kubernetes-preload.cjs");
    const nodeOptions = [
      process.env.NODE_OPTIONS,
      options.kubernetesLog ? `--require=${preload}` : undefined
    ].filter((value): value is string => Boolean(value)).join(" ");
    const child = spawn(process.execPath, ["scripts/db/apply-migrations.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
        POSTGRES_TEST_URL: databaseUrl,
        POSTGRES_APP_URL: "",
        AGENTSMITH_LITE_DATA_DIR: dataRoot,
        AGENTSMITH_LITE_SANDBOX_MODE: options.mode ?? "dry-run",
        KUBE_NAMESPACE: "agentsmith-migration-test",
        ...(options.kubernetesLog
          ? {
              KUBERNETES_SERVICE_HOST: "kubernetes.test",
              KUBERNETES_SERVICE_PORT: "443",
              AGENTSMITH_LITE_MIGRATION_TEST_KUBERNETES_LOG: options.kubernetesLog,
              AGENTSMITH_LITE_MIGRATION_TEST_STORAGE_MARKER: options.storageMarker ?? dataRoot
            }
          : {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

interface RecordedKubernetesRequest {
  method: string;
  path: string;
  body: string;
  storageMarkerExists: boolean;
}

async function readKubernetesRequests(logPath: string): Promise<RecordedKubernetesRequest[]> {
  const contents = await readFile(logPath, "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordedKubernetesRequest);
}
