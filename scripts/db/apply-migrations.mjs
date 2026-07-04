import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const connectionString = process.env.POSTGRES_APP_URL;
if (!connectionString) {
  throw new Error("POSTGRES_APP_URL is required for schema bootstrap");
}

const dir = path.resolve("infra/db/migrations");
const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
if (files.length === 0) {
  throw new Error(`No Postgres migrations found in ${dir}`);
}

const migrations = await Promise.all(files.map(async (filename) => {
  const id = migrationId(filename);
  const sql = await readFile(path.join(dir, filename), "utf8");
  if (sql.trim().length === 0) {
    throw new Error(`Postgres migration is empty: ${filename}`);
  }
  return {
    id,
    filename,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex")
  };
}));

const client = await connectWhenReady(connectionString);
try {
  await client.query("begin");
  await client.query(`
    create table if not exists agentsmith_migrations (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  for (const migration of migrations) {
    const existing = await client.query(
      "select checksum from agentsmith_migrations where id = $1 for update",
      [migration.id]
    );
    const checksum = existing.rows[0]?.checksum;
    if (checksum) {
      if (checksum !== migration.checksum) {
        throw new Error(`Postgres migration checksum changed after apply: ${migration.filename}`);
      }
      console.log(`skipped migration ${migration.filename}`);
      continue;
    }

    await client.query(migration.sql);
    await client.query(
      "insert into agentsmith_migrations (id, checksum) values ($1, $2)",
      [migration.id, migration.checksum]
    );
    console.log(`applied migration ${migration.filename}`);
  }

  await client.query("commit");
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

function migrationId(filename) {
  const match = /^([0-9]{3}_[a-z0-9_]+)\.sql$/.exec(filename);
  if (!match?.[1]) {
    throw new Error(`Invalid Postgres migration filename: ${filename}`);
  }
  return match[1];
}

async function connectWhenReady(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() <= deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("select 1");
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await sleep(500);
    }
  }
  throw lastError ?? new Error("Timed out waiting for Postgres");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
