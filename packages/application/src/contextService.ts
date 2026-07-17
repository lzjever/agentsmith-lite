import type { ProjectContextContentType, ProjectContextEntry, ProjectContextScope } from "../../contracts/src/api.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";
import { WorkspaceService } from "./workspaceService.js";
import { runIdempotentMutation } from "./idempotentMutation.js";

export type ContextContentType = ProjectContextContentType;

export type ContextEntryView = ProjectContextEntry & { contentType: ContextContentType };

export interface ContextListResult {
  items: ContextEntryView[];
  canWrite: boolean;
}

export interface ContextRequestTarget {
  workspaceId: string;
  projectId?: string | null;
  scope: ProjectContextScope;
}

export interface UpsertContextEntryInput extends ContextRequestTarget {
  contextKey: string;
  previousContextKey?: string;
  expectedVersion?: number;
  content: string;
  contentType: ContextContentType;
}

const MAX_CONTEXT_BYTES = 30 * 1024;
const MAX_AGENT_CONTEXT_BYTES = 32 * 1024;
const MAX_CONTEXT_KEY_LENGTH = 160;
const contextScopes = new Set<ProjectContextScope>(["workspace_shared", "workspace_personal", "project_shared", "project_personal"]);
const contentTypes = new Set<ContextContentType>(["text", "json", "markdown", "yaml"]);

export class ContextService {
  constructor(private readonly store: ProductStore, private readonly workspaces: WorkspaceService) {}

  async list(userId: string, target: ContextRequestTarget): Promise<ContextListResult> {
    const normalized = normalizeTarget(target);
    const access = await this.authorize(userId, normalized, "view");
    const entries = await this.store.listProjectContextEntries(
      normalized.workspaceId,
      normalized.projectId,
      normalized.scope,
      personalOwner(normalized.scope, userId)
    );
    return { items: entries.map((entry) => toView(entry)), canWrite: access.canWrite };
  }

  async upsert(userId: string, input: UpsertContextEntryInput, idempotencyKey?: string): Promise<ContextEntryView> {
    const target = normalizeTarget(input);
    await this.authorize(userId, target, "write");
    const contextKey = requireContextKey(input.contextKey);
    const previousContextKey = input.previousContextKey === undefined ? contextKey : requireContextKey(input.previousContextKey);
    const content = requireContent(input.content);
    const contentType = requireContentType(input.contentType);
    if (contentType === "json") validateJson(content);
    const ownerUserId = personalOwner(target.scope, userId);
    const save = async (resourceId: string) => {
      const timestamp = nowIso();
      const entries = await this.store.listProjectContextEntries(target.workspaceId, target.projectId, target.scope, ownerUserId);
      const existing = entries.find((entry) => entry.contextKey === previousContextKey);
      if (existing && entries.some((entry) => entry.contextKey === contextKey && entry.id !== existing.id)) throw new ProductError("A context entry already uses that key", 409);
      if (existing) {
        if (!Number.isInteger(input.expectedVersion) || input.expectedVersion! < 1) throw new ProductError("expectedVersion is required to update context", 400);
        if (existing.version !== input.expectedVersion) throw new ProductError("Context changed elsewhere. Reload and try again.", 409);
        if (existing.contextKey === contextKey && existing.content === content && existing.contentType === contentType) return toView(existing, contentType);
      }
      const entry: ProjectContextEntry = {
        id: existing?.id ?? resourceId, workspaceId: target.workspaceId, projectId: target.projectId, ownerUserId, scope: target.scope,
        contextKey, content, contentType, version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp
      };
      if (!existing) return toView(await this.store.createProjectContextEntry(entry), contentType);
      const updated = await this.store.updateProjectContextEntry(entry, input.expectedVersion!);
      if (!updated) throw new ProductError("Context changed elsewhere. Reload and try again.", 409);
      return toView(updated, contentType);
    };
    if (!idempotencyKey) return save(newId("ctx"));
    return runIdempotentMutation({ store: this.store, actorId: userId, scopeId: target.projectId ?? target.workspaceId, operation: target.projectId ? "project.context.save" : "workspace.context.save", key: idempotencyKey, request: { ...target, contextKey, previousContextKey, expectedVersion: input.expectedVersion, content, contentType }, resourceId: newId("ctx"), failureMessage: "Context could not be saved", run: save });
  }

  async delete(userId: string, target: ContextRequestTarget & { contextKey: string; expectedVersion: number }, idempotencyKey?: string): Promise<{ deleted: true }> {
    const normalized = normalizeTarget(target);
    await this.authorize(userId, normalized, "write");
    const contextKey = requireContextKey(target.contextKey);
    const remove = async () => {
      const entries = await this.store.listProjectContextEntries(normalized.workspaceId, normalized.projectId, normalized.scope, personalOwner(normalized.scope, userId));
      const entry = entries.find((candidate) => candidate.contextKey === contextKey);
      if (!entry) throw new NotFoundError("Context entry not found");
      if (!Number.isInteger(target.expectedVersion) || target.expectedVersion < 1) throw new ProductError("expectedVersion is required to delete context", 400);
      if (entry.version !== target.expectedVersion || !(await this.store.deleteProjectContextEntry(entry))) throw new ProductError("Context changed elsewhere. Reload and try again.", 409);
      return { deleted: true as const };
    };
    if (!idempotencyKey) return remove();
    return runIdempotentMutation({ store: this.store, actorId: userId, scopeId: normalized.projectId ?? normalized.workspaceId, operation: normalized.projectId ? "project.context.delete" : "workspace.context.delete", key: idempotencyKey, request: { ...normalized, contextKey, expectedVersion: target.expectedVersion }, resourceId: contextKey, failureMessage: "Context could not be deleted", run: remove });
  }

  async resolveForAgent(userId: string, projectId: string): Promise<string> {
    const project = await this.workspaces.requireProjectForUser(userId, projectId, "view");
    const workspaceId = project.workspaceId;
    const effective = new Map<string, ProjectContextEntry>();
    for (const [scope, scopedProjectId, ownerUserId] of [
      ["workspace_shared", null, null],
      ["workspace_personal", null, userId],
      ["project_shared", projectId, null],
      ["project_personal", projectId, userId]
    ] as const) {
      for (const entry of await this.store.listProjectContextEntries(workspaceId, scopedProjectId, scope, ownerUserId)) {
        effective.set(entry.contextKey, entry);
      }
    }
    if (effective.size === 0) return "";
    const rendered = [
      "# AgentSmith Context",
      "",
      "These entries are reusable workspace and project guidance. Project entries override workspace defaults with the same key; personal entries override shared entries at the same scope. Direct instructions in the current request take priority.",
      "",
      ...[...effective.values()].sort((left, right) => left.contextKey.localeCompare(right.contextKey)).flatMap((entry) => [
        `## ${entry.contextKey}`,
        `Scope: ${entry.scope}`,
        "",
        entry.content,
        ""
      ])
    ].join("\n").trimEnd() + "\n";
    if (Buffer.byteLength(rendered, "utf8") > MAX_AGENT_CONTEXT_BYTES) {
      throw new ProductError("Effective agent context exceeds the 32 KiB execution limit", 413);
    }
    return rendered;
  }

  private async authorize(userId: string, target: Required<ContextRequestTarget>, action: "view" | "write"): Promise<{ canWrite: boolean }> {
    if (target.scope === "project_shared" || target.scope === "project_personal") {
      const projectId = target.projectId!;
      const project = await this.workspaces.requireProjectForUser(userId, projectId, action === "write" && target.scope === "project_shared" ? "admin" : "view");
      if (project.workspaceId !== target.workspaceId) throw new NotFoundError("Project not found");
      if (target.scope === "project_personal" && action === "write") {
        await this.workspaces.requireProjectForUser(userId, projectId, "view");
      }
      const membership = await this.store.findProjectMembership(projectId, userId);
      return { canWrite: target.scope === "project_personal" || membership?.role === "owner" || membership?.role === "admin" };
    }

    await this.workspaces.requireWorkspaceForUser(userId, target.workspaceId, action === "write" && target.scope === "workspace_shared" ? "admin" : "view");
    const membership = await this.store.findWorkspaceMembership(target.workspaceId, userId);
    const isWorkspaceAdmin = membership?.role === "owner" || membership?.role === "admin";
    return { canWrite: target.scope === "workspace_personal" || isWorkspaceAdmin };
  }
}

function normalizeTarget(target: ContextRequestTarget): Required<ContextRequestTarget> {
  if (!contextScopes.has(target.scope)) throw new ProductError("Invalid context scope");
  const workspaceId = requireIdentifier(target.workspaceId, "workspaceId");
  const projectScope = target.scope === "project_shared" || target.scope === "project_personal";
  if (projectScope) return { workspaceId, projectId: requireIdentifier(target.projectId, "projectId"), scope: target.scope };
  if (target.projectId) throw new ProductError("Workspace context must not include a projectId");
  return { workspaceId, projectId: null, scope: target.scope };
}

function personalOwner(scope: ProjectContextScope, userId: string): string | null {
  return scope === "workspace_personal" || scope === "project_personal" ? userId : null;
}

function requireIdentifier(value: string | null | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProductError(`${name} is required`);
  return value;
}

function requireContextKey(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_CONTEXT_KEY_LENGTH) {
    throw new ProductError(`contextKey must be between 1 and ${MAX_CONTEXT_KEY_LENGTH} characters`);
  }
  return value.trim();
}

function requireContent(value: string): string {
  if (typeof value !== "string") throw new ProductError("Context content must be text");
  if (Buffer.byteLength(value, "utf8") > MAX_CONTEXT_BYTES) throw new ProductError("Context content exceeds the 30 KiB limit", 413);
  return value;
}

function requireContentType(value: string): ContextContentType {
  if (!contentTypes.has(value as ContextContentType)) throw new ProductError("Invalid context content type");
  return value as ContextContentType;
}

function validateJson(content: string): void {
  try {
    JSON.parse(content);
  } catch {
    throw new ProductError("JSON context content must be valid JSON");
  }
}

function toView(entry: ProjectContextEntry, contentType?: ContextContentType): ContextEntryView {
  return { ...entry, contentType: contentType ?? entry.contentType ?? inferredContentType(entry.content) };
}

function inferredContentType(content: string): ContextContentType {
  try {
    JSON.parse(content);
    return "json";
  } catch {
    return "text";
  }
}
