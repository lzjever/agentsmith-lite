import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

interface ApiContractSnapshot {
  schema: string;
  surface: string;
  routes: string[];
  clientBoundary: string;
}

interface RouteContext {
  blockDepth: number;
  exactPath?: string;
  methods?: string[];
  segments: Map<number, string>;
}

describe("api contract snapshot", () => {
  it("keeps docs, snapshot, and server route guards aligned", async () => {
    const [snapshot, docs, serverSource] = await Promise.all([
      readSnapshot(),
      readFile(path.resolve("docs/api-contract.md"), "utf8"),
      readFile(path.resolve("packages/api-entry-node/src/server.ts"), "utf8")
    ]);

    assert.equal(snapshot.schema, "agentsmith-lite.api-contract/v1");
    assert.equal(snapshot.surface, "product-and-operator-api");
    assert.match(snapshot.clientBoundary, /operator scripts/);
    assertUniqueRoutes("snapshot", snapshot.routes);

    const docsRoutes = extractDocsRoutes(docs);
    assertUniqueRoutes("docs", docsRoutes);
    assert.deepEqual(docsRoutes, snapshot.routes);

    const serverRoutes = extractServerRoutes(serverSource);
    assertUniqueRoutes("server", serverRoutes);
    assert.deepEqual(serverRoutes, sorted(snapshot.routes));
  });
});

async function readSnapshot(): Promise<ApiContractSnapshot> {
  return JSON.parse(
    await readFile(path.resolve("packages/contracts/api-contract.snapshot.json"), "utf8")
  ) as ApiContractSnapshot;
}

function extractDocsRoutes(docs: string): string[] {
  return [...docs.matchAll(/^- `([A-Z]+ \/api\/[^`]+)`$/gm)].map((match) => requiredMatch(match[1]));
}

function extractServerRoutes(source: string): string[] {
  const start = source.indexOf("async function routeApi");
  const end = source.indexOf("async function serveWeb", start);
  assert.notEqual(start, -1, "routeApi must exist in server source");
  assert.notEqual(end, -1, "serveWeb must follow routeApi in server source");

  const routeApiSource = source.slice(start, end);
  const root: RouteContext = {
    blockDepth: 0,
    segments: new Map()
  };
  const stack: RouteContext[] = [root];
  const routes: string[] = [];
  let depth = 0;

  for (const line of routeApiSource.split(/\r?\n/)) {
    const activeContext = stack[stack.length - 1] ?? root;
    if (/\breturn\s+(?:sendJson|sendArtifactDownload|sendProjectFileDownload|sendRedirect)\(/.test(line)) {
      routes.push(...routesForContext(activeContext));
    }

    const condition = line.match(/\bif \((.*)\) \{/);
    if (condition) {
      stack.push(extendContext(activeContext, requiredMatch(condition[1]), depth + 1));
    }

    depth += count(line, "{") - count(line, "}");
    while (stack.length > 1 && (stack[stack.length - 1]?.blockDepth ?? 0) > depth) {
      stack.pop();
    }
  }

  return sorted(routes);
}

function extendContext(base: RouteContext, condition: string, blockDepth: number): RouteContext {
  const segments = new Map(base.segments);

  for (const match of condition.matchAll(/segments\[(\d+)] === "([^"]+)"/g)) {
    segments.set(Number(requiredMatch(match[1])), requiredMatch(match[2]));
  }

  for (const match of condition.matchAll(/segments\[(\d+)]/g)) {
    const index = Number(requiredMatch(match[1]));
    const before = condition.slice(Math.max(0, (match.index ?? 0) - 1), match.index ?? 0);
    const after = condition.slice((match.index ?? 0) + requiredMatch(match[0]).length).trimStart();
    if (before === "!" || after.startsWith("===")) {
      continue;
    }
    segments.set(index, paramName(index, segments));
  }

  const methods = [...condition.matchAll(/method === "([A-Z]+)"/g)].map((match) => requiredMatch(match[1]));
  const exactPath = condition.match(/url\.pathname === "([^"]+)"/)?.[1];

  return {
    blockDepth,
    segments,
    ...(base.exactPath || exactPath ? { exactPath: exactPath ?? base.exactPath } : {}),
    ...(methods.length > 0 || base.methods ? { methods: methods.length > 0 ? methods : base.methods } : {})
  };
}

function routesForContext(context: RouteContext): string[] {
  const methods = context.methods ?? [];
  assert.ok(methods.length > 0, `route return had no method: ${routePath(context)}`);
  return methods.map((method) => `${method} ${routePath(context)}`);
}

function routePath(context: RouteContext): string {
  if (context.exactPath) {
    return context.exactPath;
  }
  const maxIndex = Math.max(...context.segments.keys());
  const segments: string[] = [];
  for (let index = 0; index <= maxIndex; index += 1) {
    const segment = context.segments.get(index);
    assert.ok(segment, `route context is missing segment ${index}`);
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function paramName(index: number, segments: Map<number, string>): string {
  if (index === 2 && segments.get(1) === "workspaces") {
    return "{workspaceId}";
  }
  if (index === 2 && segments.get(1) === "projects") {
    return "{projectId}";
  }
  if (index === 2 && segments.get(1) === "tasks") {
    return "{taskId}";
  }
  if (index === 4 && segments.get(3) === "artifacts") {
    return "{artifactId}";
  }
  return `{segment${index}}`;
}

function assertUniqueRoutes(sourceName: string, routes: string[]): void {
  const duplicates = routes.filter((route, index) => routes.indexOf(route) !== index);
  assert.deepEqual(duplicates, [], `${sourceName} API routes must be unique`);
}

function sorted(routes: string[]): string[] {
  return [...routes].sort((left, right) => left.localeCompare(right));
}

function count(input: string, needle: string): number {
  return input.split(needle).length - 1;
}

function requiredMatch(value: string | undefined): string {
  assert.ok(value);
  return value;
}
