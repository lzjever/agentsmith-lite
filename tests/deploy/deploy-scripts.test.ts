import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

describe("deploy status/down scripts", () => {
  it("status.sh queries Ingress with the app-owned label scope", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-status-"));
    const envFile = path.join(tempDir, "deploy.env");
    const fakeKubectl = path.join(tempDir, "kubectl");
    writeFileSync(envFile, "KUBE_NAMESPACE=agentsmith-preview\n");
    writeFileSync(fakeKubectl, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\n");
    chmodSync(fakeKubectl, 0o755);

    const result = spawnSync("bash", ["scripts/deploy/status.sh", "--env", envFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const args = result.stdout.trim().split("\n");
    const getIndex = args.indexOf("get");
    assert.notEqual(getIndex, -1, result.stdout);
    assert.equal(args[getIndex + 1]?.includes("ingress"), true, result.stdout);
    assert.equal(args.includes("-n"), true, result.stdout);
    assert.equal(args.includes("agentsmith-preview"), true, result.stdout);
    assert.equal(args.includes("-l"), true, result.stdout);
    assert.equal(args.includes("agentsmith-lite/managed-by=agentsmith-lite"), true, result.stdout);
  });

  it("down.sh dry-run deletes Ingress with the app-owned label scope", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-down-"));
    const envFile = path.join(tempDir, "deploy.env");
    writeFileSync(envFile, "KUBE_NAMESPACE=agentsmith-preview\n");

    const result = spawnSync("bash", ["scripts/deploy/down.sh", "--env", envFile, "--dry-run"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /kubectl/);
    assert.match(result.stdout, /agentsmith-preview/);
    assert.match(result.stdout, /delete/);
    assert.match(result.stdout, /ingress/);
    assert.match(result.stdout, /-l agentsmith-lite\/managed-by=agentsmith-lite/);
  });
});
