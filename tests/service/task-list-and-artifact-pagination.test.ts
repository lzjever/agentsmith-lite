import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { Project, TaskArtifactListPage, TaskArtifactListQuery, TaskListQuery } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import { DryRunBotifiedRuntimeHttpClient } from "../../packages/ports/src/botified.js";
import type { PersistedAgentTask, PersistedSandboxRunState, PersistedTaskArtifact } from "../../packages/ports/src/store.js";

describe("Task list keyset pagination", () => {
  it("orders all three Task sort keys in both directions with deterministic ID ties", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("sorts");
    await setup.createTask(project, task("task_a", "Alpha", 1, 3));
    await setup.createTask(project, task("task_b", "Beta", 2, 2));
    await setup.createTask(project, task("task_c", "Beta", 2, 1));
    await setup.createTask(project, task("task_d", "Delta", 3, 3));

    const cases: Array<[NonNullable<TaskListQuery["sort"]>, NonNullable<TaskListQuery["direction"]>, string[]]> = [
      ["created_at", "asc", ["task_a", "task_b", "task_c", "task_d"]],
      ["created_at", "desc", ["task_d", "task_c", "task_b", "task_a"]],
      ["updated_at", "asc", ["task_c", "task_b", "task_a", "task_d"]],
      ["updated_at", "desc", ["task_d", "task_a", "task_b", "task_c"]],
      ["title", "asc", ["task_a", "task_b", "task_c", "task_d"]],
      ["title", "desc", ["task_d", "task_c", "task_b", "task_a"]]
    ];

    for (const [sort, direction, expected] of cases) {
      assert.deepEqual(
        await collectTaskIds(setup.services.tasks.listTasks.bind(setup.services.tasks), setup.userId, project.id, {
          archived: "exclude",
          sort,
          direction,
          limit: 2
        }),
        expected,
        `${sort} ${direction}`
      );
    }
  });

  it("does not duplicate or omit the original result set when a newer Task is inserted between pages", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("insert");
    for (const [id, offset] of [["task_a", 1], ["task_b", 2], ["task_c", 3], ["task_d", 4]] as const) {
      await setup.createTask(project, task(id, id, offset, offset));
    }

    const query = { archived: "exclude", sort: "created_at", direction: "desc", limit: 2 } as const;
    const first = await setup.services.tasks.listTasks(setup.userId, project.id, query);
    assert.deepEqual(first.items.map(({ task }) => task.id), ["task_d", "task_c"]);
    assert.ok(first.nextCursor);

    await setup.createTask(project, task("task_new", "Newest", 5, 5));
    const second = await setup.services.tasks.listTasks(setup.userId, project.id, { ...query, cursor: first.nextCursor! });

    assert.deepEqual(second.items.map(({ task }) => task.id), ["task_b", "task_a"]);
    assert.equal(second.nextCursor, null);
    assert.equal(second.total, 5);
  });

  it("binds cursors to Project and normalized query scope and rejects legacy or tampered values", async () => {
    const setup = await createSetup();
    const firstProject = await setup.createProject("scope-a");
    const secondProject = await setup.createProject("scope-b");
    await setup.createTask(firstProject, task("task_scope_a", "Needle one", 1, 1));
    await setup.createTask(firstProject, { ...task("task_scope_b", "Needle two", 2, 2), archivedAt: timestamp(8) });
    await setup.createTask(secondProject, task("task_scope_other", "Needle other", 1, 1));
    const query = {
      search: "needle",
      archived: "include",
      sort: "created_at",
      direction: "asc",
      limit: 1
    } as const;
    const first = await setup.services.tasks.listTasks(setup.userId, firstProject.id, query);
    assert.ok(first.nextCursor);

    await assertInputError(() => setup.services.tasks.listTasks(setup.userId, secondProject.id, { ...query, cursor: first.nextCursor! }));
    await assertInputError(() => setup.services.tasks.listTasks(setup.userId, firstProject.id, { ...query, search: "other", cursor: first.nextCursor! }));
    await assertInputError(() => setup.services.tasks.listTasks(setup.userId, firstProject.id, { ...query, archived: "only", cursor: first.nextCursor! }));
    await assertInputError(() => setup.services.tasks.listTasks(setup.userId, firstProject.id, { ...query, sort: "updated_at", cursor: first.nextCursor! }));
    await assertInputError(() => setup.services.tasks.listTasks(setup.userId, firstProject.id, { ...query, direction: "desc", cursor: first.nextCursor! }));

    const legacyOffsetCursor = Buffer.from(JSON.stringify({
      offset: 1,
      query: { search: "needle", archived: "include", sort: "created_at", direction: "asc" }
    }), "utf8").toString("base64url");
    await assertInputError(() => setup.services.tasks.listTasks(setup.userId, firstProject.id, { ...query, cursor: legacyOffsetCursor }));
    await assertInputError(() => setup.services.tasks.listTasks(setup.userId, firstProject.id, {
      ...query,
      cursor: corruptCursor(first.nextCursor!)
    }));
  });

  it("reports total for the complete filtered scope on every page", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("total");
    await setup.createTask(project, task("task_match_a", "Match A", 1, 1));
    await setup.createTask(project, task("task_match_b", "Match B", 2, 2));
    await setup.createTask(project, task("task_other", "Other", 3, 3));
    await setup.createTask(project, { ...task("task_match_archived", "Match archived", 4, 4), archivedAt: timestamp(9) });

    const query = { search: "match", archived: "exclude", sort: "created_at", direction: "asc", limit: 1 } as const;
    const first = await setup.services.tasks.listTasks(setup.userId, project.id, query);
    const second = await setup.services.tasks.listTasks(setup.userId, project.id, { ...query, cursor: first.nextCursor! });

    assert.equal(first.total, 2);
    assert.equal(second.total, 2);
  });

  it("treats search metacharacters literally and sorts titles by ordinal value", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("ordinal");
    for (const [id, title] of [
      ["task_zed", "Zulu"],
      ["task_underscore", "_under"],
      ["task_alpha", "alpha"],
      ["task_percent", "100%"],
      ["task_percent_wildcard", "100x"],
      ["task_backslash", String.raw`path\name`]
    ] as const) {
      await setup.createTask(project, task(id, title, 1, 1));
    }

    assert.deepEqual(
      (await setup.services.tasks.listTasks(setup.userId, project.id, {
        archived: "exclude",
        sort: "title",
        direction: "asc",
        limit: 20
      })).items.map(({ task: item }) => item.id),
      ["task_percent", "task_percent_wildcard", "task_zed", "task_underscore", "task_alpha", "task_backslash"]
    );
    assert.deepEqual(
      (await setup.services.tasks.listTasks(setup.userId, project.id, { search: "%", limit: 20 })).items.map(({ task: item }) => item.id),
      ["task_percent"]
    );
    assert.deepEqual(
      (await setup.services.tasks.listTasks(setup.userId, project.id, { search: "_", limit: 20 })).items.map(({ task: item }) => item.id),
      ["task_underscore"]
    );
    assert.deepEqual(
      (await setup.services.tasks.listTasks(setup.userId, project.id, { search: "\\", limit: 20 })).items.map(({ task: item }) => item.id),
      ["task_backslash"]
    );
  });

  it("rejects malformed and non-canonical ISO Task date cursors", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("task-date-cursor");
    await setup.createTask(project, task("task_date_a", "A", 1, 1));
    await setup.createTask(project, task("task_date_b", "B", 2, 2));
    const query = { archived: "exclude", sort: "created_at", direction: "asc", limit: 1 } as const;
    const first = await setup.services.tasks.listTasks(setup.userId, project.id, query);
    assert.ok(first.nextCursor);

    await assertInputError(() => setup.services.tasks.listTasks(setup.userId, project.id, {
      ...query,
      cursor: rewriteCursor(first.nextCursor!, (record) => {
        (record.after as Record<string, unknown>).value = "not-a-date";
      })
    }));
    await assertInputError(() => setup.services.tasks.listTasks(setup.userId, project.id, {
      ...query,
      cursor: rewriteCursor(first.nextCursor!, (record) => {
        (record.after as Record<string, unknown>).value = "2026-07-24T00:00:01Z";
      })
    }));
  });
});

describe("Task Artifact keyset pagination", () => {
  it("returns newest-first pages with deterministic ID ties and limit-plus-one cursors", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("artifact-order");
    await setup.createTask(project, task("task_artifacts", "Artifacts", 1, 1));
    await setup.store.appendTaskArtifacts([
      artifact("artifact_a", "task_artifacts", 1),
      artifact("artifact_b", "task_artifacts", 2),
      artifact("artifact_c", "task_artifacts", 2),
      artifact("artifact_d", "task_artifacts", 3)
    ]);

    const first = await listArtifacts(setup, "task_artifacts", { limit: 2 });
    assert.deepEqual(first.items.map((item) => item.id), ["artifact_d", "artifact_c"]);
    assert.ok(first.nextCursor);
    const second = await listArtifacts(setup, "task_artifacts", { limit: 2, cursor: first.nextCursor! });
    assert.deepEqual(second.items.map((item) => item.id), ["artifact_b", "artifact_a"]);
    assert.equal(second.nextCursor, null);
  });

  it("keeps the original Artifact traversal stable when a newer item is inserted", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("artifact-insert");
    await setup.createTask(project, task("task_artifact_insert", "Artifacts", 1, 1));
    await setup.store.appendTaskArtifacts([
      artifact("artifact_a", "task_artifact_insert", 1),
      artifact("artifact_b", "task_artifact_insert", 2),
      artifact("artifact_c", "task_artifact_insert", 3),
      artifact("artifact_d", "task_artifact_insert", 4)
    ]);

    const first = await listArtifacts(setup, "task_artifact_insert", { limit: 2 });
    await setup.store.appendTaskArtifacts([artifact("artifact_new", "task_artifact_insert", 5)]);
    const second = await listArtifacts(setup, "task_artifact_insert", { limit: 2, cursor: first.nextCursor! });

    assert.deepEqual(first.items.map((item) => item.id), ["artifact_d", "artifact_c"]);
    assert.deepEqual(second.items.map((item) => item.id), ["artifact_b", "artifact_a"]);
    assert.equal(second.nextCursor, null);
  });

  it("applies filters before limiting and binds cursors to Task and filter scope", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("artifact-filter");
    await setup.createTask(project, task("task_filtered", "Filtered", 1, 1));
    await setup.createTask(project, task("task_other", "Other", 2, 2));
    await setup.store.appendTaskArtifacts([
      artifact("artifact_text_a", "task_filtered", 1, { mediaType: "text/plain", previewText: "a" }),
      artifact("artifact_text_b", "task_filtered", 2, { mediaType: "text/plain", previewText: "b" }),
      artifact("artifact_binary_new", "task_filtered", 4, { mediaType: "application/octet-stream", previewText: null }),
      artifact("artifact_image_new", "task_filtered", 5, { mediaType: "image/png", previewText: null }),
      artifact("artifact_other", "task_other", 1, { mediaType: "text/plain", previewText: "other" })
    ]);
    const query = { kind: "text", mediaType: "text/plain", previewOnly: true, limit: 1 } as const;
    const first = await listArtifacts(setup, "task_filtered", query);

    assert.deepEqual(first.items.map((item) => item.id), ["artifact_text_b"]);
    assert.ok(first.nextCursor);
    assert.deepEqual(
      (await listArtifacts(setup, "task_filtered", { ...query, cursor: first.nextCursor! })).items.map((item) => item.id),
      ["artifact_text_a"]
    );

    await assertInputError(() => listArtifacts(setup, "task_other", { ...query, cursor: first.nextCursor! }));
    await assertInputError(() => listArtifacts(setup, "task_filtered", { ...query, kind: "file", cursor: first.nextCursor! }));
    await assertInputError(() => listArtifacts(setup, "task_filtered", { ...query, mediaType: "text/markdown", cursor: first.nextCursor! }));
    await assertInputError(() => listArtifacts(setup, "task_filtered", { ...query, previewOnly: false, cursor: first.nextCursor! }));
    await assertInputError(() => listArtifacts(setup, "task_filtered", { ...query, cursor: corruptCursor(first.nextCursor!) }));
  });

  it("uses the shared safe-preview classification for the Images filter", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("artifact-images");
    await setup.createTask(project, task("task_images", "Images", 1, 1));
    await setup.store.appendTaskArtifacts([
      artifact("artifact_png", "task_images", 1, { mediaType: "IMAGE/PNG; charset=binary" }),
      artifact("artifact_svg", "task_images", 2, { mediaType: "image/svg+xml" }),
      artifact("artifact_avif", "task_images", 3, { mediaType: "image/avif" })
    ]);

    assert.deepEqual(
      (await listArtifacts(setup, "task_images", { kind: "image", limit: 20 })).items.map((item) => item.id),
      ["artifact_png"]
    );
    assert.deepEqual(
      (await listArtifacts(setup, "task_images", { kind: "file", limit: 20 })).items.map((item) => item.id),
      ["artifact_avif", "artifact_svg"]
    );
  });

  it("rejects malformed and non-canonical ISO Artifact cursors", async () => {
    const setup = await createSetup();
    const project = await setup.createProject("artifact-date-cursor");
    await setup.createTask(project, task("task_artifact_dates", "Artifacts", 1, 1));
    await setup.store.appendTaskArtifacts([
      artifact("artifact_date_a", "task_artifact_dates", 1),
      artifact("artifact_date_b", "task_artifact_dates", 2)
    ]);
    const first = await listArtifacts(setup, "task_artifact_dates", { limit: 1 });
    assert.ok(first.nextCursor);

    await assertInputError(() => listArtifacts(setup, "task_artifact_dates", {
      limit: 1,
      cursor: rewriteCursor(first.nextCursor!, (record) => {
        (record.after as Record<string, unknown>).createdAt = "not-a-date";
      })
    }));
    await assertInputError(() => listArtifacts(setup, "task_artifact_dates", {
      limit: 1,
      cursor: rewriteCursor(first.nextCursor!, (record) => {
        (record.after as Record<string, unknown>).createdAt = "2026-07-24T00:00:02Z";
      })
    }));
  });

  it("reads Artifact lists and missing downloads from the store without syncing Botified", async () => {
    const botified = new TimelineCountingBotifiedClient();
    const setup = await createSetup(botified);
    const project = await setup.createProject("artifact-read-only");
    await setup.createTask(project, task("task_read_only", "Read only", 1, 1));
    const storedTask = await setup.store.findTask("task_read_only");
    assert.ok(storedTask);

    assert.deepEqual((await listArtifacts(setup, storedTask.id, { limit: 20 })).items, []);
    await assert.rejects(
      setup.services.tasks.downloadTaskArtifact(setup.userId, storedTask.id, "artifact_missing"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 404
    );
    assert.equal(botified.timelineReads, 0);
  });
});

async function createSetup(botifiedClient?: DryRunBotifiedRuntimeHttpClient) {
  const store = createLocalInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot: "/tmp/agentsmith-lite-pagination-test",
    builtinAdminPassword: "admin-password",
    ...(botifiedClient ? { botifiedClient } : {})
  });
  const session = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(session.user.id, { name: "Pagination" });
  let projectNumber = 0;
  return {
    store,
    services,
    userId: session.user.id,
    async createProject(suffix: string): Promise<Project> {
      projectNumber += 1;
      return services.workspaces.createProject(session.user.id, workspace.id, {
        name: `Project ${projectNumber} ${suffix}`
      });
    },
    async createTask(project: Project, value: PersistedAgentTask): Promise<void> {
      const libraryId = `library_${value.id}`;
      const created = await store.createTaskAtomically({
        task: { ...value, workspaceId: project.workspaceId, projectId: project.id, fileLibraryId: libraryId },
        reserveActive: false, admission:{namespace:"agentsmith",namespaceLimit:100},
        newFileLibrary: {
          id: libraryId,
          workspaceId: project.workspaceId,
          projectId: project.id,
          name: `Library ${value.id}`,
          rootSubPath: `libraries/${libraryId}/home`,
          createdByUserId: session.user.id,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt
        }
      });
      assert.equal(created.kind, "created");
    }
  };
}

function task(id: string, title: string, createdOffset: number, updatedOffset: number): PersistedAgentTask {
  return {
    id,
    workspaceId: "",
    projectId: "",
    endpointId: "endpoint_unused",
    fileLibraryId: null,
    title,
    prompt: title,
    currentRunId: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: timestamp(createdOffset),
    updatedAt: timestamp(updatedOffset)
  };
}

function artifact(
  id: string,
  taskId: string,
  createdOffset: number,
  overrides: Partial<Pick<PersistedTaskArtifact, "mediaType" | "previewText">> = {}
): PersistedTaskArtifact {
  return {
    id,
    taskId,
    fileId: `file_${id}`,
    name: `${id}.dat`,
    bytes: 1,
    mediaType: "application/octet-stream",
    previewText: null,
    createdAt: timestamp(createdOffset),
    ...overrides
  };
}

async function collectTaskIds(
  list: (userId: string, projectId: string, query: TaskListQuery) => ReturnType<ReturnType<typeof createApplicationServices>["tasks"]["listTasks"]>,
  userId: string,
  projectId: string,
  query: TaskListQuery
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(userId, projectId, { ...query, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map(({ task }) => task.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

async function listArtifacts(
  setup: Awaited<ReturnType<typeof createSetup>>,
  taskId: string,
  query: TaskArtifactListQuery
): Promise<TaskArtifactListPage> {
  return setup.services.tasks.listTaskArtifacts(setup.userId,taskId,query);
}

async function assertInputError(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof ProductError && error.statusCode === 400
  );
}

function corruptCursor(cursor: string): string {
  const last = cursor.at(-1);
  return `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

function rewriteCursor(cursor: string, update: (record: Record<string, unknown>) => void): string {
  const record = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  update(record);
  return Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
}

function timestamp(offset: number): string {
  return new Date(Date.UTC(2026, 6, 24, 0, 0, offset)).toISOString();
}

class TimelineCountingBotifiedClient extends DryRunBotifiedRuntimeHttpClient {
  timelineReads = 0;

  override async readTimeline() {
    this.timelineReads += 1;
    return super.readTimeline();
  }
}

function activeSandboxRun(task: PersistedAgentTask, project: Project, userId: string): PersistedSandboxRunState {
  const runId = task.currentRunId!;
  return {
    workspaceId: project.workspaceId,
    projectId: project.id,
    taskId: task.id,
    runId,
    namespace: "agentsmith",
    state: "active",
    image: "botified:test",
    pvcName: "files",
    projectSubPath: project.rootPath,
    fileLibraryRootSubPath: `libraries/${task.fileLibraryId}/home`,
    fileLibraryId: task.fileLibraryId!,
    startedByUserId: userId,
    startedAt: task.createdAt,
    startupReadyAt: task.createdAt,
    startupActionDeadlineAt: null,
    botifiedPort: 3099,
    resourceNames: {
      pod: `pod-${runId}`,
      service: `service-${runId}`,
      configMap: `config-${runId}`,
      secret: `secret-${runId}`,
      serviceAccount: `account-${runId}`,
      networkPolicy: `policy-${runId}`
    },
    serviceKeySecretRef: { name: `secret-${runId}`, key: "BOTIFIED_SERVICE_KEY" },
    directories: { libraryHome: "/workspace/library", botified: "/workspace/botified" },
    resourceLimits: { cpuRequest: "250m", memoryRequest: "512Mi", cpuLimit: "1", memoryLimit: "1Gi" },
    resourceSnapshot: {
      cpuRequestMillis: "250",
      memoryRequestBytes: "536870912",
      cpuLimitMillis: "1000",
      memoryLimitBytes: "1073741824"
    },
    failureCode: null,
    failureCause: null,
    fencingToken: 1,
    releaseRequestedAt: null,
    failedAt: null,
    releasedAt: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}
