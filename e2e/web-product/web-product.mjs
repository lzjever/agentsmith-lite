import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "../../dist/packages/api-entry-node/src/server.js";

const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-web-product-"));
const artifactBytes = Buffer.from("web product artifact", "utf8");
const server = await createApiServer({
  port: 0,
  dataRoot,
  builtinAdminPassword: "admin-password",
  sessionSecret: "web-product-session-secret",
  botifiedClient: fakeBotifiedClient(artifactBytes),
  botifiedServiceKeyFactory: () => "web-product-service-key"
});

const executablePath = process.env.CHROME_PATH ?? (existsSync("/usr/bin/google-chrome-stable") ? "/usr/bin/google-chrome-stable" : undefined);
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(server.baseUrl + "/", { waitUntil: "networkidle" });
  await page.locator("#login").waitFor({ state: "visible" });
  const [, loginResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/bootstrap") && response.request().method() === "POST"),
    page.waitForResponse((response) => response.url().endsWith("/api/auth/login") && response.request().method() === "POST"),
    page.locator("#login-form button[type='submit']").click()
  ]);
  assert(loginResponse.ok(), "login failed");
  await page.locator("#dashboard").waitFor({ state: "visible" });

  await page.locator("#workspace-project-form input[name='workspaceName']").fill("Web Product Workspace");
  await page.locator("#workspace-project-form input[name='projectName']").fill("Web Product Project");
  const [, projectResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/workspaces") && response.request().method() === "POST"
    ),
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return /\/api\/workspaces\/[^/]+\/projects$/.test(url.pathname) && response.request().method() === "POST";
    }),
    page.locator("#workspace-project-form button[type='submit']").click()
  ]);
  assert(projectResponse.ok(), "project creation failed");
  await waitForText(page, "#current-project", "Web Product Workspace / Web Product Project");

  await page.locator("#endpoint-form input[name='name']").fill("Web Product Endpoint");
  await page.locator("#endpoint-form input[name='model']").fill("gpt-compatible");
  await page.locator("#endpoint-form input[name='baseUrl']").fill("https://models.example.com/v1");
  await page.locator("#endpoint-form input[name='secretRef']").fill("secret/web-product");
  await page.locator("#endpoint-form input[name='requestTimeoutSecs']").fill("30");
  const endpointResponse = await submitAndWait(page, "#endpoint-form button[type='submit']", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/endpoints$/.test(url.pathname) && response.request().method() === "POST";
  });
  assert(endpointResponse.ok(), "endpoint creation failed");
  await waitForText(page, "#endpoints", "Web Product Endpoint");

  await page.locator("#task-form textarea[name='prompt']").fill("Create a tiny artifact");
  const taskResponse = await submitAndWait(page, "#task-form button[type='submit']", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/tasks$/.test(url.pathname) && response.request().method() === "POST";
  });
  assert(taskResponse.ok(), "task creation failed");
  await waitForText(page, "#tasks", "Create a tiny artifact");
  await waitForText(page, "#artifacts", "web-product-artifact.txt");

  const artifactDownload = await clickDownload(page, "#artifacts .download-link");
  const artifactPath = await artifactDownload.path();
  assert(artifactPath, "artifact download did not produce a local file");
  assert.equal(await readFile(artifactPath, "utf8"), "web product artifact");

  await page.locator("#project-file-form input[name='path']").fill("files/web-product.txt");
  await page.locator("#project-file-form textarea[name='content']").fill("hello from web product e2e");
  const uploadResponse = await submitAndWait(page, "#project-file-form button[type='submit']", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/files$/.test(url.pathname) && response.request().method() === "POST";
  });
  assert(uploadResponse.ok(), "project file upload failed");
  await waitForText(page, "#files", "files/web-product.txt");

  const fileDownload = await clickDownload(page, "#files .download-link");
  const filePath = await fileDownload.path();
  assert(filePath, "project file download did not produce a local file");
  assert((await readFile(filePath, "utf8")).includes("hello from web product e2e"), "project file download missing uploaded content");

  const deleteResponse = await submitAndWait(page, "#files .danger-button", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/files$/.test(url.pathname) && response.request().method() === "DELETE";
  });
  assert(deleteResponse.ok(), "project file delete failed");
  await page.waitForFunction(() => !document.querySelector("#files")?.textContent?.includes("files/web-product.txt"));

  assert.deepEqual(pageErrors, []);
  console.log("e2e:web-product passed");
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
  return response;
}

async function clickDownload(page, selector) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(selector).first().click()
  ]);
  return download;
}

async function waitForText(page, selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent?.includes(expected),
    { selector, expected }
  );
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
                file_id: "web_product_file_1",
                filename: "web-product-artifact.txt",
                mime_type: "text/plain",
                size_bytes: bytes.byteLength,
                sha256: "e".repeat(64),
                download_url: "http://botified.internal/v1/files/web_product_file_1?service_key=web-product-service-key"
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
      assert(fileId === "web_product_file_1", "unexpected Botified file id");
      return {
        bytes,
        filename: "web-product-artifact.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.byteLength
      };
    },
    async abort() {
      return { aborted: true };
    }
  };
}
