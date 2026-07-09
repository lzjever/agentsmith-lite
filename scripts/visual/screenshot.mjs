import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "../../dist/packages/api-entry-node/src/server.js";

const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-visual-"));
const appBasePath = "/app";
const artifactBytes = Buffer.from("visual artifact", "utf8");
const server = await createApiServer({
  port: 0,
  dataRoot,
  builtinAdminPassword: "admin-password",
  sessionSecret: "visual-session-secret",
  publicBasePath: appBasePath,
  botifiedClient: fakeBotifiedClient(artifactBytes),
  botifiedServiceKeyFactory: () => "visual-service-key"
});

const executablePath = process.env.CHROME_PATH ?? (existsSync("/usr/bin/google-chrome-stable") ? "/usr/bin/google-chrome-stable" : undefined);
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(server.baseUrl + `${appBasePath}/`, { waitUntil: "networkidle" });

  await page.locator("#login").waitFor({ state: "visible" });
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/login") && response.request().method() === "POST"),
    page.locator("#login-form button[type='submit']").click()
  ]);
  await page.locator("#dashboard").waitFor({ state: "visible" });

  await page.locator("#workspace-project-form input[name='workspaceName']").fill("Visual Workspace");
  await page.locator("#workspace-project-form input[name='projectName']").fill("Visual Project");
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/workspaces") && response.request().method() === "POST"
    ),
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return /\/api\/workspaces\/[^/]+\/projects$/.test(url.pathname) && response.request().method() === "POST";
    }),
    page.locator("#workspace-project-form button[type='submit']").click()
  ]);
  await waitForText(page, "#current-project", "Visual Workspace / Visual Project");

  await page.locator("#endpoint-form input[name='name']").fill("Visual Endpoint");
  await page.locator("#endpoint-form input[name='model']").fill("gpt-compatible");
  await page.locator("#endpoint-form input[name='baseUrl']").fill("https://models.example.com/v1");
  await page.locator("#endpoint-form input[name='secretRef']").fill("secret/visual");
  await page.locator("#endpoint-form input[name='requestTimeoutSecs']").fill("30");
  await submitAndWait(page, "#endpoint-form button[type='submit']", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/endpoints$/.test(url.pathname) && response.request().method() === "POST";
  });
  await waitForText(page, "#endpoints", "Visual Endpoint");

  await page.locator("#task-form textarea[name='prompt']").fill("Visual task");
  await submitAndWait(page, "#task-form button[type='submit']", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/tasks$/.test(url.pathname) && response.request().method() === "POST";
  });
  await waitForText(page, "#artifacts", "visual-artifact.txt");
  await waitForText(page, "#tasks", "completed");
  await waitForText(page, "#timeline-count", "completed");
  await waitForText(page, "#timeline", "turn completed");
  const artifactHref = await page.locator("#artifacts .download-link").first().getAttribute("href");
  assert.match(artifactHref ?? "", /^\/app\/api\/tasks\/[^/]+\/artifacts\/[^/]+\/download$/);

  const visualFilePath = "files/visual/nested/visual-note.txt";
  await page.locator("#project-file-form input[name='path']").fill(visualFilePath);
  await page.locator("#project-file-form textarea[name='content']").fill("hello from visual screenshot");
  await submitAndWait(page, "#project-file-form button[type='submit']", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/files$/.test(url.pathname) && response.request().method() === "POST";
  });
  await waitForText(page, "#files-count", "files · 1 entry");
  await waitForText(page, "#files", "files/visual");
  await openProjectDirectory(page, "files/visual");
  await waitForText(page, "#files-count", "files/visual · 1 entry");
  await waitForText(page, "#files", "Parent directory");
  await waitForText(page, "#files", "files/visual/nested");
  await openProjectDirectory(page, "files/visual/nested");
  await waitForText(page, "#files-count", "files/visual/nested · 1 entry");
  await waitForText(page, "#files", "Parent directory");
  await waitForText(page, "#files", visualFilePath);
  await assertProjectFileNestedControls(page, visualFilePath);
  const fileHref = await page.locator("#files .item", { hasText: visualFilePath }).locator(".download-link").getAttribute("href");
  assert.match(fileHref ?? "", /^\/app\/api\/projects\/[^/]+\/files\/download\?path=files%2Fvisual%2Fnested%2Fvisual-note\.txt$/);
  assert.doesNotMatch(fileHref ?? "", /(?:https?:\/\/|provider|botified|internal)/i);

  await assertNoPanelOverlap(page);
  await mkdir("out/visual", { recursive: true });
  await page.screenshot({ path: "out/visual/agentsmith-lite-dashboard.png", fullPage: true });
  console.log("Screenshot: out/visual/agentsmith-lite-dashboard.png");

  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(100);
  await assertNoPanelOverlap(page);
  await page.screenshot({ path: "out/visual/agentsmith-lite-dashboard-mobile.png", fullPage: true });
  console.log("Screenshot: out/visual/agentsmith-lite-dashboard-mobile.png");
} finally {
  await browser.close();
  await server.close();
  await rm(dataRoot, { recursive: true, force: true });
}

async function submitAndWait(page, selector, predicate) {
  const [response] = await Promise.all([
    page.waitForResponse(predicate),
    page.locator(selector).click()
  ]);
  assert(response.ok(), `${selector} request failed with ${response.status()}`);
  return response;
}

async function waitForText(page, selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent?.includes(expected),
    { selector, expected }
  );
}

async function openProjectDirectory(page, directoryPath) {
  await page.locator("#files .item", { hasText: directoryPath }).first().locator("button", { hasText: "Open" }).click();
}

async function assertProjectFileNestedControls(page, filePath) {
  const parentRow = page.locator("#files .item", { hasText: "Parent directory" }).first();
  await expectVisible(parentRow.locator("button", { hasText: "Up" }));
  const fileRow = page.locator("#files .item", { hasText: filePath }).first();
  await expectVisible(fileRow.locator(".download-link", { hasText: "Download" }));
  await expectVisible(fileRow.locator("button", { hasText: "Delete" }));
}

async function expectVisible(locator) {
  assert.equal(await locator.isVisible(), true);
}

async function assertNoPanelOverlap(page) {
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
  assert.deepEqual(overlaps, [], `dashboard panels overlap: ${overlaps.join("; ")}`);
}

function fakeBotifiedClient(bytes) {
  let published = false;
  return {
    async health() {
      return { status: "ok" };
    },
    async postMessage() {
      return { accepted: true, messageId: "msg_1", cursor: "post-cursor" };
    },
    async readTimeline(_baseUrl, _serviceKey, cursor) {
      if (!published) {
        published = true;
        return {
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
            },
            {
              cursor: "c2",
              seq: 2,
              session_id: "s1",
              type: "turn.completed",
              payload: {
                status: "completed"
              }
            }
          ],
          nextCursor: "c2"
        };
      }
      return cursor ? { status: "ok", events: [], nextCursor: cursor } : { status: "ok", events: [] };
    },
    async uploadFile() {
      return { files: [] };
    },
    async downloadFile(_baseUrl, _serviceKey, fileId) {
      assert.equal(fileId, "visual_file_1", "unexpected Botified file id");
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
