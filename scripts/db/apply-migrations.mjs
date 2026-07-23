import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const STORAGE_CUTOVER_MIGRATION_ID = "066_converge_task_turn_run_state";
const testConnectionString = process.env.POSTGRES_TEST_URL;
const connectionString = testConnectionString ?? process.env.POSTGRES_APP_URL;
if (!connectionString) {
  throw new Error("POSTGRES_APP_URL or POSTGRES_TEST_URL is required for schema bootstrap");
}
if (testConnectionString) {
  const databaseName = decodeURIComponent(new URL(testConnectionString).pathname.slice(1));
  if (!databaseName.endsWith("_test")) {
    throw new Error("POSTGRES_TEST_URL must select a database whose name ends with _test");
  }
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
    if (migration.id === STORAGE_CUTOVER_MIGRATION_ID) {
      const cleanupTargets = await planStorageCutover(client);
      await preflightStorageCutover(cleanupTargets);
      await cleanupSandboxResources();
      for (const target of cleanupTargets.paths) {
        await rm(target.absolutePath, { recursive: true, force: true });
      }
    }
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

async function planStorageCutover(client) {
  const dataRoot = resolveDataRoot();
  const projectsResult = await client.query(
    "select id,root_path from projects order by id"
  );
  const librariesResult = await client.query(
    "select id,project_id,root_sub_path from file_libraries order by project_id,id"
  );
  const projects = new Map();
  for (const row of projectsResult.rows) {
    const projectRoot = resolveOwnedRoot(dataRoot, row.root_path, `Project ${bounded(row.id)} root_path`);
    if ([...projects.values()].some((project) => project.absolutePath === projectRoot)) {
      throw unsafePathError(`duplicate Project root ${projectRoot}`);
    }
    projects.set(row.id, {
      id: row.id,
      absolutePath: projectRoot
    });
  }

  const libraries = [];
  const libraryRoots = new Set();
  for (const row of librariesResult.rows) {
    const project = projects.get(row.project_id);
    if (!project) {
      throw unsafePathError(`File Library ${bounded(row.id)} has no Project root`);
    }
    const libraryRoot = resolveOwnedRoot(
      project.absolutePath,
      row.root_sub_path,
      `File Library ${bounded(row.id)} root_sub_path`
    );
    assertStrictlyInside(dataRoot, libraryRoot, `File Library ${bounded(row.id)} root`);
    if (libraryRoots.has(libraryRoot)) {
      throw unsafePathError(`duplicate File Library root ${libraryRoot}`);
    }
    libraryRoots.add(libraryRoot);
    libraries.push({
      id: row.id,
      projectId: row.project_id,
      absolutePath: libraryRoot
    });
  }

  const paths = [
    ...[...projects.values()].map((project) => ({
      kind: "project_tasks",
      projectId: project.id,
      absolutePath: path.join(project.absolutePath, "tasks")
    })),
    ...libraries.map((library) => ({
      kind: "library_artifacts",
      projectId: library.projectId,
      libraryId: library.id,
      absolutePath: path.join(library.absolutePath, "workspace", ".artifacts")
    }))
  ];
  validateCleanupTargetOwnership(paths, [...projects.values()], libraries);
  return { dataRoot, paths };
}

function resolveDataRoot() {
  const configured = process.env.AGENTSMITH_LITE_DATA_DIR;
  const dataRoot = configured === undefined ? path.resolve(".data") : configured;
  if (!dataRoot || dataRoot !== dataRoot.trim() || !path.isAbsolute(dataRoot) || dataRoot.includes("\0")) {
    throw unsafePathError("AGENTSMITH_LITE_DATA_DIR must be a non-empty absolute path");
  }
  const normalized = path.resolve(dataRoot);
  if (normalized === path.parse(normalized).root) {
    throw unsafePathError("AGENTSMITH_LITE_DATA_DIR cannot be the filesystem root");
  }
  return normalized;
}

function resolveOwnedRoot(parent, value, label) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.includes("\\") || value.includes("\0")) {
    throw unsafePathError(`${label} must be a non-empty relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw unsafePathError(`${label} contains traversal or an invalid segment`);
  }
  const absolutePath = path.resolve(parent, ...segments);
  assertStrictlyInside(parent, absolutePath, label);
  return absolutePath;
}

function assertStrictlyInside(parent, candidate, label) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw unsafePathError(`${label} resolves outside its owning root`);
  }
}

function validateCleanupTargetOwnership(targets, projects, libraries) {
  const seenTargets = new Set();
  for (const target of targets) {
    if (seenTargets.has(target.absolutePath)) {
      throw unsafePathError(`duplicate cleanup target ${target.absolutePath}`);
    }
    seenTargets.add(target.absolutePath);
    for (const project of projects) {
      if (project.id !== target.projectId && pathsOverlap(target.absolutePath, project.absolutePath)) {
        throw unsafePathError(`cleanup target overlaps Project ${bounded(project.id)} root`);
      }
    }
    for (const library of libraries) {
      const ownArtifacts = target.kind === "library_artifacts" && target.libraryId === library.id;
      if (!ownArtifacts && pathsOverlap(target.absolutePath, library.absolutePath)) {
        throw unsafePathError(`cleanup target overlaps File Library ${bounded(library.id)} root`);
      }
    }
  }
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      if (pathsOverlap(targets[left].absolutePath, targets[right].absolutePath)) {
        throw unsafePathError("cleanup targets overlap");
      }
    }
  }
}

function pathsOverlap(left, right) {
  return left === right || isInside(left, right) || isInside(right, left);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function preflightStorageCutover(cleanupTargets) {
  await assertNoExistingSymlinkPrefix(cleanupTargets.dataRoot);
  for (const target of cleanupTargets.paths) {
    assertStrictlyInside(cleanupTargets.dataRoot, target.absolutePath, "cleanup target");
    await assertNoExistingSymlinkPrefix(target.absolutePath);
  }
}

async function assertNoExistingSymlinkPrefix(absolutePath) {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  const segments = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw unsafePathError(`existing path prefix is a symbolic link: ${current}`);
    }
    if (!entry.isDirectory()) {
      throw unsafePathError(`existing path prefix is not a directory: ${current}`);
    }
  }
}

async function cleanupSandboxResources() {
  const sandboxMode = (process.env.AGENTSMITH_LITE_SANDBOX_MODE ?? "dry-run").trim();
  if (sandboxMode !== "dry-run" && sandboxMode !== "live") {
    throw new Error("AGENTSMITH_LITE_SANDBOX_MODE must be either dry-run or live");
  }
  if (sandboxMode !== "live") {
    return;
  }
  const namespace = process.env.KUBE_NAMESPACE ?? "agentsmith";
  if (!namespace || namespace !== namespace.trim()) {
    throw new Error("KUBE_NAMESPACE must be non-empty for migration 066 live cleanup");
  }

  const kubernetesModule = await import("../../dist/packages/sandbox-controller/src/kubernetesPort.js");
  const reconcilerModule = await import("../../dist/packages/sandbox-controller/src/reconciler.js");
  const port = new kubernetesModule.SandboxKubernetesPort();
  const observedResources = await port.listManagedResources(namespace);
  const plan = reconcilerModule.reconcileSandboxRuns({
    namespace,
    desiredRuns: [],
    persistedRunIds: [],
    observedResources,
    now: new Date()
  });
  assertReconcilePlan(plan, "initial");
  await kubernetesModule.applySandboxReconcileActionsToKubernetes(port, plan.actions);

  const remainingResources = await port.listManagedResources(namespace);
  const confirmation = reconcilerModule.reconcileSandboxRuns({
    namespace,
    desiredRuns: [],
    persistedRunIds: [],
    observedResources: remainingResources,
    now: new Date()
  });
  assertReconcilePlan(confirmation, "confirmation");
  if (confirmation.actions.some((action) => action.type === "delete_resource")) {
    throw new Error("Migration 066 Kubernetes cleanup was not confirmed by a fresh list");
  }
}

function assertReconcilePlan(plan, phase) {
  if (plan.errors.length > 0) {
    throw new Error(`Migration 066 Kubernetes ${phase} reconcile failed: ${plan.errors.join("; ")}`);
  }
  const unsupported = plan.actions.find((action) => action.type !== "delete_resource");
  if (unsupported) {
    throw new Error(`Migration 066 Kubernetes ${phase} reconcile produced unsupported action ${unsupported.type}`);
  }
}

function unsafePathError(message) {
  return new Error(`Unsafe migration 066 cleanup path: ${message}`);
}

function bounded(value) {
  return String(value).slice(0, 80);
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
