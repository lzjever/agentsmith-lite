import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { describe, it } from "node:test";

interface NextBuildConfig {
  config?: { basePath?: string };
}

describe("Next standalone static assets", () => {
  it("serves emitted CSS and JavaScript under the compiled basePath", async () => {
    const requiredFiles = JSON.parse(readFileSync(path.join(process.cwd(), ".next/required-server-files.json"), "utf8")) as NextBuildConfig;
    const basePath = requiredFiles.config?.basePath ?? "";
    const port = 33000 + (process.pid % 1000);
    const server = spawn("node", [".next/standalone/server.js"], {
      cwd: process.cwd(),
      env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port) },
      stdio: "ignore"
    });

    try {
      const page = await fetchWhenReady(`http://127.0.0.1:${port}${basePath || "/"}`);
      assert.equal(page.status, 200);
      const html = await page.text();
      const cssPath = assetPath(html, "css");
      const jsPath = assetPath(html, "js");

      for (const assetPathname of [cssPath, jsPath]) {
        const asset = await fetch(`http://127.0.0.1:${port}${assetPathname}`);
        assert.equal(asset.status, 200, `${assetPathname} must be served by the standalone server`);
      }
    } finally {
      server.kill();
      await once(server, "exit");
    }
  });
});

async function fetchWhenReady(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function assetPath(html: string, extension: "css" | "js"): string {
  const match = html.match(new RegExp(`(?:href|src)="([^\"]*?_next/static/[^\"]+\\.${extension})"`));
  assert.ok(match?.[1], `page must reference a ${extension} chunk`);
  return match[1];
}
