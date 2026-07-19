import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { readPostgresMigrations } from "../../packages/adapters-postgres/src/migrations.js";

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

  it("defines only the Phase 1 file library persistence model in migration 060", async () => {
    const migration = (await readPostgresMigrations()).find((item) => item.id === "060_file_libraries");
    assert.ok(migration);
    assert.match(migration.sql, /create table file_libraries/i);
    assert.match(migration.sql, /unique.*project_id.*root_sub_path/is);
    assert.match(migration.sql, /lower\(btrim\(name\)\)/i);
    assert.doesNotMatch(migration.sql, /file_library_id.*agent_tasks|sandbox/i);
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
    assert.match(migration.sql,/unique index agent_tasks_file_library_active_unique[\s\S]*where deleted_at is null/i);
    assert.match(migration.sql,/drop column if exists input_paths/i);
    assert.match(migration.sql,/drop column if exists source_task_id/i);
    assert.doesNotMatch(migration.sql,/\btask_follow_ups\b/i);
    assert.doesNotMatch(migration.sql,/\bagent_task_events\b/i);
  });
});
