import type { ProductStore } from "../../ports/src/store.js";
import { createLocalInMemoryProductStore } from "./inMemoryProductStore.js";
import { createPostgresProductStore } from "./postgresProductStore.js";

export function createProductStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ProductStore {
  const connectionString = env.POSTGRES_APP_URL;
  if (connectionString && connectionString.trim().length > 0) {
    return createPostgresProductStore(connectionString);
  }
  return createLocalInMemoryProductStore();
}
