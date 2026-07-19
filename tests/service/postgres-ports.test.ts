import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
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

  it("reports PostgreSQL task binding lookup as unavailable until Phase 2", async () => {
    const store = Object.create(PostgresProductStore.prototype) as PostgresProductStore;
    assert.deepEqual(await store.findTaskBoundToFileLibrary("library_one"), { kind: "unavailable" });
  });
});
