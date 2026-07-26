export interface FileStateScope {
  readonly key: string;
}

export interface FileStateReadToken {
  readonly owner: symbol;
  readonly scope: FileStateScope;
  readonly sequence: number;
}

export interface FileStateMutationIntent {
  readonly owner: symbol;
  readonly scopes: readonly FileStateScope[];
  readonly sequence: number;
  readonly attemptGroup: string | undefined;
}

export interface FileStateReadSettlement {
  readonly apply: boolean;
  readonly loadingReadRemains: boolean;
}

export interface FileStateAttemptSettlement {
  readonly released: boolean;
  readonly attemptsRemain: boolean;
}

interface ScopeState {
  revision: number;
  loadingRead: number | undefined;
  currentMutation: number | undefined;
}

interface MutationState {
  scopeKeys: readonly string[];
}

export interface FileStateOwnership {
  beginRead(scope: FileStateScope): FileStateReadToken;
  finishRead(token: FileStateReadToken): FileStateReadSettlement;
  beginMutation(
    scopes: readonly FileStateScope[],
    attemptGroup?: string
  ): FileStateMutationIntent;
  finishMutation(intent: FileStateMutationIntent): boolean;
  finishAttempt(intent: FileStateMutationIntent): FileStateAttemptSettlement;
  invalidateReads(scopes: readonly FileStateScope[]): void;
  isLoading(scope: FileStateScope): boolean;
}

export function fileLibraryCollectionScope(projectId: string): FileStateScope {
  return { key: scopeKey("libraries", projectId) };
}

export function fileDirectoryScope(
  projectId: string,
  libraryId: string,
  path: string
): FileStateScope {
  return {
    key: scopeKey("directory", projectId, libraryId, normalizeFileStatePath(path))
  };
}

export function fileDetailScope(
  projectId: string,
  libraryId: string,
  path: string
): FileStateScope {
  return {
    key: scopeKey("detail", projectId, libraryId, normalizeFileStatePath(path))
  };
}

export function createFileStateOwnership(): FileStateOwnership {
  const owner = Symbol("FileStateOwnership");
  const states = new Map<string, ScopeState>();
  const mutations = new Map<number, MutationState>();
  const attempts = new Map<string, Set<number>>();
  let sequence = 0;

  function nextSequence(): number {
    sequence += 1;
    return sequence;
  }

  function stateFor(scope: FileStateScope): ScopeState {
    const existing = states.get(scope.key);
    if (existing) return existing;
    const state: ScopeState = {
      revision: 0,
      loadingRead: undefined,
      currentMutation: undefined
    };
    states.set(scope.key, state);
    return state;
  }

  function supersedeMutation(mutationSequence: number): void {
    const mutation = mutations.get(mutationSequence);
    if (!mutation) return;
    for (const key of mutation.scopeKeys) {
      const state = states.get(key);
      if (!state || state.currentMutation !== mutationSequence) continue;
      state.currentMutation = undefined;
      state.loadingRead = undefined;
      state.revision = nextSequence();
    }
    mutations.delete(mutationSequence);
  }

  return {
    beginRead(scope) {
      const readSequence = nextSequence();
      const state = stateFor(scope);
      state.revision = readSequence;
      state.loadingRead = readSequence;
      return { owner, scope, sequence: readSequence };
    },

    finishRead(token) {
      if (token.owner !== owner) {
        return { apply: false, loadingReadRemains: false };
      }
      const state = stateFor(token.scope);
      if (state.loadingRead === token.sequence) {
        state.loadingRead = undefined;
      }
      return {
        apply: state.revision === token.sequence && state.currentMutation === undefined,
        loadingReadRemains: state.loadingRead !== undefined
      };
    },

    beginMutation(scopes, attemptGroup) {
      const uniqueScopes = [...new Map(scopes.map((scope) => [scope.key, scope])).values()];
      if (uniqueScopes.length === 0) {
        throw new Error("A Files mutation intent requires at least one scope");
      }
      const superseded = new Set<number>();
      for (const scope of uniqueScopes) {
        const currentMutation = stateFor(scope).currentMutation;
        if (currentMutation !== undefined) superseded.add(currentMutation);
      }
      for (const mutationSequence of superseded) {
        supersedeMutation(mutationSequence);
      }

      const mutationSequence = nextSequence();
      for (const scope of uniqueScopes) {
        const state = stateFor(scope);
        state.revision = mutationSequence;
        state.loadingRead = undefined;
        state.currentMutation = mutationSequence;
      }
      mutations.set(mutationSequence, {
        scopeKeys: uniqueScopes.map((scope) => scope.key)
      });
      if (attemptGroup) {
        const activeAttempts = attempts.get(attemptGroup) ?? new Set<number>();
        activeAttempts.add(mutationSequence);
        attempts.set(attemptGroup, activeAttempts);
      }
      return {
        owner,
        scopes: uniqueScopes,
        sequence: mutationSequence,
        attemptGroup
      };
    },

    finishMutation(intent) {
      if (intent.owner !== owner) return false;
      const mutation = mutations.get(intent.sequence);
      if (!mutation) return false;
      if (!mutation.scopeKeys.every((key) => states.get(key)?.currentMutation === intent.sequence)) {
        mutations.delete(intent.sequence);
        return false;
      }

      const completionSequence = nextSequence();
      for (const key of mutation.scopeKeys) {
        const state = states.get(key);
        if (!state) continue;
        state.currentMutation = undefined;
        state.loadingRead = undefined;
        state.revision = completionSequence;
      }
      mutations.delete(intent.sequence);
      return true;
    },

    finishAttempt(intent) {
      if (intent.owner !== owner || !intent.attemptGroup) {
        return { released: false, attemptsRemain: false };
      }
      const activeAttempts = attempts.get(intent.attemptGroup);
      if (!activeAttempts) {
        return { released: false, attemptsRemain: false };
      }
      const released = activeAttempts.delete(intent.sequence);
      const attemptsRemain = activeAttempts.size > 0;
      if (!attemptsRemain) attempts.delete(intent.attemptGroup);
      return { released, attemptsRemain };
    },

    invalidateReads(scopes) {
      const invalidationSequence = nextSequence();
      for (const scope of scopes) {
        const state = stateFor(scope);
        state.revision = invalidationSequence;
        state.loadingRead = undefined;
      }
    },

    isLoading(scope) {
      return stateFor(scope).loadingRead !== undefined;
    }
  };
}

function normalizeFileStatePath(path: string): string {
  if (!path || path.includes("\\")) return "";
  const segments = path.split("/");
  if (segments.includes("..")) return "";
  return segments.filter((segment) => segment && segment !== ".").join("/");
}

function scopeKey(kind: string, ...parts: string[]): string {
  return JSON.stringify([kind, ...parts]);
}
