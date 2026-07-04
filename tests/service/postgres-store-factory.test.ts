import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore, InMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import { createProductStoreFromEnv } from "../../packages/adapters-postgres/src/productStoreFactory.js";

describe("postgres product store factory", () => {
  it("uses in-memory fallback for local/test when POSTGRES_APP_URL is absent", () => {
    const store = createProductStoreFromEnv({
      JUICEFS_META_URL: "postgresql://substrate:secret@db/juicefs"
    });

    assert.equal(store instanceof InMemoryProductStore, true);
  });

  it("uses Postgres when POSTGRES_APP_URL is configured", () => {
    const store = createProductStoreFromEnv({
      POSTGRES_APP_URL: "postgresql://app:secret@db/agentsmith",
      JUICEFS_META_URL: "postgresql://substrate:secret@db/juicefs"
    });

    assert.equal(store instanceof PostgresProductStore, true);
  });

  it("keeps the legacy API store import environment controlled", async () => {
    const previous = process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL = "postgresql://app:secret@db/agentsmith";
    try {
      const store = createInMemoryProductStore();
      assert.equal(store instanceof PostgresProductStore, true);
      await (store as PostgresProductStore).close();
    } finally {
      if (previous === undefined) {
        delete process.env.POSTGRES_APP_URL;
      } else {
        process.env.POSTGRES_APP_URL = previous;
      }
    }
  });
});
