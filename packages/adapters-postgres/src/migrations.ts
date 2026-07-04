import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface PostgresMigration {
  id: string;
  filename: string;
  sql: string;
}

const MIGRATION_FILENAME = /^([0-9]{3}_[a-z0-9_]+)\.sql$/;

export function resolvePostgresMigrationsDir(): string {
  return path.resolve(process.cwd(), "infra/db/migrations");
}

export async function readPostgresMigrations(migrationsDir = resolvePostgresMigrationsDir()): Promise<PostgresMigration[]> {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  if (files.length === 0) {
    throw new Error(`No Postgres migrations found in ${migrationsDir}`);
  }

  const migrations = await Promise.all(files.map(async (filename) => {
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match?.[1]) {
      throw new Error(`Invalid Postgres migration filename: ${filename}`);
    }
    const sql = await readFile(path.join(migrationsDir, filename), "utf8");
    if (sql.trim().length === 0) {
      throw new Error(`Postgres migration is empty: ${filename}`);
    }
    return {
      id: match[1],
      filename,
      sql
    };
  }));

  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) {
      throw new Error(`Duplicate Postgres migration id: ${migration.id}`);
    }
    ids.add(migration.id);
  }

  return migrations;
}
