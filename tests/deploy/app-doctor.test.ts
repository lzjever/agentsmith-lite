import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const appDigestRef = "agentsmith-lite/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const runnerDigestRef = "agentsmith-lite/botified-runner@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const otherAppDigestRef = "agentsmith-lite/app@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

describe("deploy app doctor artifact checks", () => {
  it("passes --bundle by using the bundle images.lock against rendered manifests", () => {
    const fixture = writeDoctorFixture();

    const result = runDoctor(fixture, ["--bundle", fixture.bundleDir]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /App doctor passed/);
  });

  it("passes standalone --images-lock validation against rendered manifests", () => {
    const fixture = writeDoctorFixture();
    const lockFile = path.join(fixture.tempDir, "standalone-images.lock");
    writeFileSync(lockFile, `${appDigestRef}\n${runnerDigestRef}\n`);

    const result = runDoctor(fixture, ["--images-lock", lockFile]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /App doctor passed/);
  });

  it("requires an existing --out path when validating a bundle or images.lock", () => {
    const fixture = writeDoctorFixture();
    const missingOut = path.join(fixture.tempDir, "missing-manifests");

    const result = runDoctor({ ...fixture, outDir: missingOut }, ["--bundle", fixture.bundleDir]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--out|rendered manifests path does not exist/i);
  });

  it("fails bundle validation for checksum and archive problems", () => {
    const cases: Array<{
      name: string;
      mutate: (fixture: DoctorFixture) => void;
      error: RegExp;
    }> = [
      {
        name: "checksum mismatch",
        mutate: (fixture) => writeFileSync(path.join(fixture.bundleDir, "manifest.yaml"), "tampered: true\n"),
        error: /checksum/i
      },
      {
        name: "missing archive",
        mutate: (fixture) => rmSync(path.join(fixture.bundleDir, "images/app.tar")),
        error: /archive|images\/app\.tar|missing/i
      },
      {
        name: "empty archive",
        mutate: (fixture) => writeFileSync(path.join(fixture.bundleDir, "images/app.tar"), ""),
        error: /archive|empty/i
      },
      {
        name: "missing checksum entry",
        mutate: (fixture) => {
          const checksums = readFileSync(path.join(fixture.bundleDir, "checksums.txt"), "utf8")
            .split("\n")
            .filter((line) => !line.includes("images/app.tar"))
            .join("\n");
          writeFileSync(path.join(fixture.bundleDir, "checksums.txt"), checksums);
        },
        error: /checksum|images\/app\.tar/i
      }
    ];

    for (const candidate of cases) {
      const fixture = writeDoctorFixture();
      candidate.mutate(fixture);

      const result = runDoctor(fixture, ["--bundle", fixture.bundleDir]);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, candidate.error, candidate.name);
    }
  });

  it("fails when bundle images.lock and explicit --images-lock disagree", () => {
    const fixture = writeDoctorFixture();
    const lockFile = path.join(fixture.tempDir, "standalone-images.lock");
    writeFileSync(lockFile, `${otherAppDigestRef}\n${runnerDigestRef}\n`);

    const result = runDoctor(fixture, ["--bundle", fixture.bundleDir, "--images-lock", lockFile]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /images\.lock|bundle|digest|match/i);
  });

  it("fails when rendered manifests use mutable or digestless app image refs", () => {
    const cases = [
      {
        name: "mutable app",
        appImage: "agentsmith-lite/app:dev",
        runnerImage: runnerDigestRef
      },
      {
        name: "mutable runner",
        appImage: appDigestRef,
        runnerImage: "agentsmith-lite/botified-runner:dev"
      },
      {
        name: "digestless app",
        appImage: "agentsmith-lite/app",
        runnerImage: runnerDigestRef
      }
    ];

    for (const candidate of cases) {
      const fixture = writeDoctorFixture({ appImage: candidate.appImage, runnerImage: candidate.runnerImage });

      const result = runDoctor(fixture, ["--bundle", fixture.bundleDir]);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, /manifest|images\.lock|mutable|missing/i, candidate.name);
    }
  });

  it("fails substrate-only secret references without leaking the secret value", () => {
    const secretValue = "NEVER_PRINT_THIS_SUBSTRATE_SECRET_VALUE";
    const fixture = writeDoctorFixture({
      extraManifest: `apiVersion: v1
kind: Secret
metadata:
  name: substrate-leak
stringData:
  S3_SECRET_KEY: ${secretValue}
`
    });

    const result = runDoctor(fixture, []);
    const report = existsSync("out/app-doctor-report.json") ? readFileSync("out/app-doctor-report.json", "utf8") : "";
    const diagnosticText = `${result.stdout}\n${result.stderr}\n${report}`;

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /substrate-only secrets/i);
    assert.doesNotMatch(diagnosticText, new RegExp(secretValue));
  });
});

function writeDoctorFixture(options: Partial<DoctorFixtureOptions> = {}): DoctorFixture {
  const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-app-doctor-"));
  const envFile = path.join(tempDir, "substrate.env");
  const secretsFile = path.join(tempDir, "substrate.secrets.env");
  const outDir = path.join(tempDir, "manifests");
  const bundleDir = path.join(tempDir, "bundle");

  writeFileSync(envFile, "KUBE_NAMESPACE=agentsmith\n");
  writeFileSync(secretsFile, "POSTGRES_APP_URL=postgres://app\nAPP_SESSION_SECRET=app-session-secret\n");
  writeManifests(outDir, {
    appImage: options.appImage ?? appDigestRef,
    runnerImage: options.runnerImage ?? runnerDigestRef,
    extraManifest: options.extraManifest
  });
  writeBundle(bundleDir, appDigestRef, runnerDigestRef);

  return { tempDir, envFile, secretsFile, outDir, bundleDir };
}

function writeManifests(outDir: string, options: DoctorFixtureOptions): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "all.yaml"),
    `apiVersion: apps/v1
kind: Deployment
metadata:
  name: agentsmith-lite-api
spec:
  template:
    spec:
      containers:
        - name: api
          image: ${options.appImage}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: agentsmith-lite-schema-bootstrap
spec:
  template:
    spec:
      containers:
        - name: schema-bootstrap
          image: ${options.appImage}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: agentsmith-lite-config
data:
  BOTIFIED_RUNNER_IMAGE: ${options.runnerImage}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: agentsmith-lite-api-sandbox
rules:
  - resources:
      - pods
    verbs:
      - create
      - get
      - list
${options.extraManifest ? `---\n${options.extraManifest}` : ""}`
  );
}

function writeBundle(bundleDir: string, appImage: string, runnerImage: string): void {
  const files: Record<string, string> = {
    "manifest.yaml": `schema: agentsmith-lite.app-offline-bundle/v1
images:
  - name: agentsmith-lite/app
    ref: ${appImage}
    archive: images/app.tar
  - name: agentsmith-lite/botified-runner
    ref: ${runnerImage}
    archive: images/botified-runner.tar
`,
    "images.lock": `${appImage}\n${runnerImage}\n`,
    "images/app.tar": "app archive\n",
    "images/botified-runner.tar": "runner archive\n"
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const file = path.join(bundleDir, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }

  const checksums = Object.keys(files)
    .map((relativePath) => `${sha256File(path.join(bundleDir, relativePath))}  ${relativePath}`)
    .join("\n");
  writeFileSync(path.join(bundleDir, "checksums.txt"), `${checksums}\n`);
}

function runDoctor(fixture: DoctorFixture, args: string[]) {
  return spawnSync("bash", ["scripts/deploy/doctor.sh", "--env", fixture.envFile, "--secrets", fixture.secretsFile, "--out", fixture.outDir, ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

interface DoctorFixture {
  tempDir: string;
  envFile: string;
  secretsFile: string;
  outDir: string;
  bundleDir: string;
}

interface DoctorFixtureOptions {
  appImage: string;
  runnerImage: string;
  extraManifest?: string | undefined;
}
