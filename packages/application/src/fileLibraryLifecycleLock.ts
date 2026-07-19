const operations = new Map<string, Promise<void>>();

export async function withFileLibraryLifecycleLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
  const previous = operations.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  operations.set(projectId, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (operations.get(projectId) === current) operations.delete(projectId);
  }
}
