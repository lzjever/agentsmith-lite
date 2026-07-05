import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { readPostgresMigrations } from "../../packages/adapters-postgres/src/migrations.js";

const postgresUrl = process.env.POSTGRES_APP_URL;
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
            'model_endpoints',
            'agent_tasks',
            'agent_task_events',
            'agent_task_artifacts',
            'postgres_json_docs',
            'runtime_leases'
          )
        order by table_name
      `);
      assert.deepEqual(tables.rows.map((row) => row.table_name), [
        "agent_task_artifacts",
        "agent_task_events",
        "agent_tasks",
        "auth_sessions",
        "model_endpoints",
        "postgres_json_docs",
        "projects",
        "runtime_leases",
        "users",
        "workspaces"
      ]);

      const eventUniqueConstraints = await client.query<{ conname: string; definition: string }>(`
        select c.conname, pg_get_constraintdef(c.oid) as definition
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        where t.relname = 'agent_task_events'
          and c.contype = 'u'
        order by c.conname
      `);
      assert.equal(
        eventUniqueConstraints.rows.some((row) => /UNIQUE \(task_id, cursor\)/i.test(row.definition)),
        true
      );
      assert.equal(
        eventUniqueConstraints.rows.some((row) => /botified_seq/i.test(row.definition)),
        false
      );
    } finally {
      await client.end();
    }
  });
});
