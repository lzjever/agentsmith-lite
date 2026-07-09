import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "../../dist/packages/api-entry-node/src/server.js";

const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-web-product-oidc-"));
const artifactBytes = Buffer.from("oidc web product artifact", "utf8");
const oidcCalls = [];
const server = await createApiServer({
  port: 0,
  dataRoot,
  authMode: "oidc",
  builtinAdminPassword: "builtin-password-must-not-work",
  sessionSecret: "web-product-oidc-session-secret-at-least-32-chars",
  oidcClient: fakeOidcClient(oidcCalls),
  botifiedClient: fakeBotifiedClient(artifactBytes),
  botifiedServiceKeyFactory: () => "web-product-oidc-service-key"
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
  const operatorRequests = [];
  const oidcFlow = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/operator/")) {
      operatorRequests.push(`${request.method()} ${pathname}`);
    }
  });
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (["/api/auth/oidc/start", "/api/auth/oidc/callback", "/api/dashboard"].includes(pathname)) {
      oidcFlow.push(pathname);
    }
  });

  await page.goto(server.baseUrl + "/", { waitUntil: "networkidle" });
  await page.locator("#login").waitFor({ state: "visible" });
  await assertText(page, "#login-title", "Sign in");
  oidcFlow.length = 0;

  const startResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/auth/oidc/start";
  });
  const callbackResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/auth/oidc/callback";
  });
  await page.locator("#login-form button[type='submit']").click();
  const startResponse = await startResponsePromise;
  const callbackResponse = await callbackResponsePromise;
  assert.equal(startResponse.status(), 302, "OIDC start did not redirect");
  assert.equal(callbackResponse.status(), 302, "OIDC callback did not redirect to the app");
  await page.locator("#dashboard").waitFor({ state: "visible" });
  assert.deepEqual(oidcFlow.slice(0, 3), ["/api/auth/oidc/start", "/api/auth/oidc/callback", "/api/dashboard"]);
  assert.equal(oidcCalls[0]?.step, "start");
  assert.equal(oidcCalls[1]?.step, "callback");

  await page.locator("#workspace-project-form input[name='workspaceName']").fill("OIDC Browser Workspace");
  await page.locator("#workspace-project-form input[name='projectName']").fill("OIDC Browser Project");
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
  await assertText(page, "#current-project", "OIDC Browser Workspace / OIDC Browser Project");

  await page.locator("#endpoint-form input[name='name']").fill("OIDC Browser Endpoint");
  await page.locator("#endpoint-form input[name='model']").fill("gpt-compatible");
  await page.locator("#endpoint-form input[name='baseUrl']").fill("https://models.example.com/v1");
  await page.locator("#endpoint-form input[name='secretRef']").fill("secret/oidc-browser");
  await page.locator("#endpoint-form input[name='requestTimeoutSecs']").fill("30");
  const endpointResponse = await submitAndWait(page, "#endpoint-form button[type='submit']", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/endpoints$/.test(url.pathname) && response.request().method() === "POST";
  });
  assert(endpointResponse.ok(), "endpoint creation failed");
  await assertText(page, "#endpoints", "OIDC Browser Endpoint");

  await page.locator("#task-form textarea[name='prompt']").fill("Create an OIDC browser artifact");
  const taskResponse = await submitAndWait(page, "#task-form button[type='submit']", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/tasks$/.test(url.pathname) && response.request().method() === "POST";
  });
  assert(taskResponse.ok(), "task creation failed");
  await assertText(page, "#tasks", "Create an OIDC browser artifact");
  await assertText(page, "#artifacts", "oidc-browser-artifact.txt");

  const artifactDownload = await clickDownload(page, "#artifacts .download-link");
  const artifactPath = await artifactDownload.path();
  assert(artifactPath, "artifact download did not produce a local file");
  assert.equal(await readFile(artifactPath, "utf8"), "oidc web product artifact");

  await page.locator("#project-file-form input[name='path']").fill("files/oidc-browser.txt");
  await page.locator("#project-file-form textarea[name='content']").fill("hello from oidc browser e2e");
  const uploadResponse = await submitAndWait(page, "#project-file-form button[type='submit']", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/files$/.test(url.pathname) && response.request().method() === "POST";
  });
  assert(uploadResponse.ok(), "project file upload failed");
  await assertText(page, "#files", "files/oidc-browser.txt");

  const fileDownload = await clickDownload(page, "#files .download-link");
  const filePath = await fileDownload.path();
  assert(filePath, "project file download did not produce a local file");
  assert((await readFile(filePath, "utf8")).includes("hello from oidc browser e2e"), "project file download missing uploaded content");

  const deleteResponse = await submitAndWait(page, "#files .danger-button", (response) => {
    const url = new URL(response.url());
    return /\/api\/projects\/[^/]+\/files$/.test(url.pathname) && response.request().method() === "DELETE";
  });
  assert(deleteResponse.ok(), "project file delete failed");
  await page.waitForFunction(() => !document.querySelector("#files")?.textContent?.includes("files/oidc-browser.txt"));

  const logoutResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/logout") && response.request().method() === "POST"
  );
  await page.locator("#logout-button").click();
  const logoutResponse = await logoutResponsePromise;
  assert(logoutResponse.ok(), "logout failed");
  await page.locator("#login").waitFor({ state: "visible" });
  await page.locator("#dashboard").waitFor({ state: "hidden" });
  await assertText(page, "#login-title", "Sign in");

  const oldSessionDashboard = await page.evaluate(async () => {
    const response = await fetch("/api/dashboard");
    return response.status;
  });
  assert.equal(oldSessionDashboard, 401, "logout left an authenticated browser session");
  assert.deepEqual(operatorRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log("e2e:web-product-oidc passed");
} finally {
  await browser.close();
  await server.close();
  await rm(dataRoot, { recursive: true, force: true });
}

async function assertText(page, selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent?.includes(expected),
    { selector, expected }
  );
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

function fakeOidcClient(calls) {
  return {
    async createAuthorizationRequest(input) {
      calls.push({ step: "start", redirectUri: input.redirectUri });
      const authorizationUrl = new URL(input.redirectUri);
      authorizationUrl.searchParams.set("code", "browser-oidc-code");
      authorizationUrl.searchParams.set("state", "browser-oidc-state");
      return {
        authorizationUrl: authorizationUrl.toString(),
        state: "browser-oidc-state",
        codeVerifier: "browser-oidc-code-verifier",
        nonce: "browser-oidc-nonce"
      };
    },
    async completeAuthorizationCallback(input) {
      calls.push({
        step: "callback",
        callbackUrl: input.callbackUrl,
        redirectUri: input.redirectUri,
        state: input.state,
        codeVerifier: input.codeVerifier,
        nonce: input.nonce
      });
      assert.match(input.callbackUrl, /code=browser-oidc-code/);
      assert.equal(input.state, "browser-oidc-state");
      assert.equal(input.codeVerifier, "browser-oidc-code-verifier");
      assert.equal(input.nonce, "browser-oidc-nonce");
      return {
        issuer: "https://keycloak.example.test/realms/agentsmith",
        subject: "browser-oidc-subject",
        email: "browser.oidc@example.test"
      };
    }
  };
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
                file_id: "oidc_browser_file_1",
                filename: "oidc-browser-artifact.txt",
                mime_type: "text/plain",
                size_bytes: bytes.byteLength,
                sha256: "f".repeat(64),
                download_url: "http://botified.internal/v1/files/oidc_browser_file_1?service_key=web-product-oidc-service-key"
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
      assert.equal(fileId, "oidc_browser_file_1", "unexpected Botified file id");
      return {
        bytes,
        filename: "oidc-browser-artifact.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.byteLength
      };
    },
    async abort() {
      return { aborted: true };
    }
  };
}
