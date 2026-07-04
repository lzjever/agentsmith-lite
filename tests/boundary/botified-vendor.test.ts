import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("botified source pin", () => {
  it("chooses one offline-compatible Botified source pin and exposes only serve as product runtime", async () => {
    const pin = JSON.parse(await readFile("third_party/botified/PINNED_SOURCE.json", "utf8")) as {
      mode: string;
      runtimeEntrypoint: string;
      commit: string;
      checksum: string;
      productTuiExposed: boolean;
    };

    assert.equal(pin.mode, "vendored_source");
    assert.equal(pin.runtimeEntrypoint, "botified serve");
    assert.match(pin.commit, /^[0-9a-f]{40}$/);
    assert.match(pin.checksum, /^sha256:[0-9a-f]{64}$/);
    assert.equal(pin.productTuiExposed, false);
  });
});

