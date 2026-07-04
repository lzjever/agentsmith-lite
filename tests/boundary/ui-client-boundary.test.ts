import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

describe("web ui client boundary", () => {
  it("keeps the browser client as an AgentSmith Lite API consumer only", async () => {
    const files = await listFiles(path.resolve("src/web"));
    const checked = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const));
    const forbidden = [
      "openai.chat",
      "api.openai.com",
      "botified",
      "kubernetes",
      "k8s",
      "pg.",
      "postgres",
      "fs.",
      "/v1/messages",
      "/v1/timeline",
      "chat/completions",
      "authorization: bearer",
      "authorization",
      "bearer ",
      "apikeysecretref",
      "secret/"
    ];

    const hits = checked.flatMap(([file, text]) =>
      forbidden.filter((needle) => text.toLowerCase().includes(needle)).map((needle) => `${file}: ${needle}`)
    );
    assert.deepEqual(hits, []);

    const fetchTargets = checked
      .flatMap(([, text]) => [...text.matchAll(/fetch\(["'`]([^"'`]+)["'`]/g)].map((match) => match[1]))
      .filter(Boolean);
    assert.ok(fetchTargets.length > 0);
    assert.ok(fetchTargets.every((target) => target?.startsWith("/api/")));
    assert.ok(
      checked.some(([, text]) => text.includes("/api/tasks/") && text.includes("/artifacts")),
      "browser UI must load task artifacts through the AgentSmith Lite API"
    );
    assert.ok(
      checked.some(([, text]) => text.includes("/download") && text.includes("download")),
      "browser UI must expose product artifact download links"
    );
  });
});

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const next = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(next) : [next];
  }));
  return files.flat();
}
