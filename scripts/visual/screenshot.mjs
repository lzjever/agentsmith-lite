import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "../../dist/packages/api-entry-node/src/server.js";

const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-visual-"));
const artifactBytes = new TextEncoder().encode("visual artifact");
const server = await createApiServer({
  port: 0,
  dataRoot,
  builtinAdminPassword: "admin-password",
  sessionSecret: "visual-session-secret",
  botifiedClient: fakeBotifiedClient(artifactBytes),
  botifiedServiceKeyFactory: () => "visual-service-key"
});

const executablePath = process.env.CHROME_PATH ?? (existsSync("/usr/bin/google-chrome-stable") ? "/usr/bin/google-chrome-stable" : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.request.post(server.baseUrl + "/api/auth/bootstrap", { data: { password: "admin-password" } });
  const login = await context.request.post(server.baseUrl + "/api/auth/login", {
    data: { email: "admin@agentsmith-lite.local", password: "admin-password" }
  });
  const csrfToken = (await login.json()).csrfToken;
  const workspace = await (await context.request.post(server.baseUrl + "/api/workspaces", {
    headers: { "x-csrf-token": csrfToken },
    data: { name: "Visual Workspace" }
  })).json();
  const project = await (await context.request.post(server.baseUrl + `/api/workspaces/${workspace.id}/projects`, {
    headers: { "x-csrf-token": csrfToken },
    data: { name: "Visual Project" }
  })).json();
  const endpoint = await (await context.request.post(server.baseUrl + `/api/projects/${project.id}/endpoints`, {
    headers: { "x-csrf-token": csrfToken },
    data: {
      name: "Visual Endpoint",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      apiKeySecretRef: "secret/visual",
      capabilities: ["text"],
      requestTimeoutSecs: 30
    }
  })).json();
  await context.request.post(server.baseUrl + `/api/projects/${project.id}/tasks`, {
    headers: { "x-csrf-token": csrfToken },
    data: { endpointId: endpoint.id, prompt: "Visual task" }
  });
  const page = await context.newPage();
  await page.goto(server.baseUrl + "/", { waitUntil: "networkidle" });
  await page.waitForSelector("#artifacts");
  const artifactText = await page.locator("#artifacts").textContent();
  assert(artifactText?.includes("visual-artifact.txt"), "dashboard artifact section missing seeded artifact");
  const overlaps = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".panel")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: element.textContent?.trim().slice(0, 40) ?? "",
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom
        };
      })
      .filter((box) => box.right > box.left && box.bottom > box.top);
    const hits = [];
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        const a = boxes[left];
        const b = boxes[right];
        const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (horizontal > 1 && vertical > 1) {
          hits.push(`${a.text} overlaps ${b.text}`);
        }
      }
    }
    return hits;
  });
  assert(overlaps.length === 0, `dashboard panels overlap: ${overlaps.join("; ")}`);
  await mkdir("out/visual", { recursive: true });
  await page.screenshot({ path: "out/visual/agentsmith-lite-dashboard.png", fullPage: true });
  console.log("Screenshot: out/visual/agentsmith-lite-dashboard.png");
} finally {
  await browser.close();
  await server.close();
  await rm(dataRoot, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fakeBotifiedClient(bytes) {
  const reads = [
    {
      status: "ok",
      events: [
        {
          cursor: "c1",
          seq: 1,
          session_id: "s1",
          type: "file.published",
          payload: {
            file_id: "visual_file_1",
            filename: "visual-artifact.txt",
            mime_type: "text/plain",
            size_bytes: bytes.byteLength,
            sha256: "d".repeat(64),
            download_url: "http://botified.internal/v1/files/visual_file_1?service_key=visual-service-key"
          }
        }
      ],
      nextCursor: "c1"
    }
  ];
  return {
    async health() {
      return { status: "ok" };
    },
    async postMessage() {
      return { accepted: true, messageId: "msg_1", cursor: "post-cursor" };
    },
    async readTimeline(_baseUrl, _serviceKey, cursor) {
      const next = reads.shift();
      if (next) return next;
      return cursor ? { status: "ok", events: [], nextCursor: cursor } : { status: "ok", events: [] };
    },
    async uploadFile() {
      return { files: [] };
    },
    async downloadFile(_baseUrl, _serviceKey, fileId) {
      assert(fileId === "visual_file_1", "unexpected Botified file id");
      return {
        bytes,
        filename: "visual-artifact.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.byteLength
      };
    },
    async abort() {
      return { aborted: true };
    }
  };
}
