import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer } from "../../packages/api-entry-node/src/server.js";
import type { ProductStore } from "../../packages/ports/src/store.js";

describe("API Kubernetes health routes", () => {
  let available = true;
  let baseUrl = "";
  let close: (() => Promise<void>) | undefined;
  let dataRoot = "";

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-readiness-"));
    const baseStore = createInMemoryProductStore();
    const store = new Proxy(baseStore, {
      get(target, property, receiver) {
        if (property === "countUsers") {
          return async () => {
            if (!available) throw new Error("database unavailable");
            return target.countUsers();
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as ProductStore;
    const server = await createTestApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      store
    });
    baseUrl = server.baseUrl;
    close = server.close;
  });

  after(async () => {
    await close?.();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("keeps liveness independent while readiness follows the database", async () => {
    assert.equal((await fetch(baseUrl + "/api/v1/health")).status, 200);
    assert.equal((await fetch(baseUrl + "/api/v1/ready")).status, 200);

    available = false;

    assert.equal((await fetch(baseUrl + "/api/v1/health")).status, 200);
    assert.equal((await fetch(baseUrl + "/api/v1/ready")).status, 500);
  });
});
