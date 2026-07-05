import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../packages/domain/src/sandboxDefaults.js";

const appDigestRef = "agentsmith-lite/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const runnerDigestRef = "agentsmith-lite/botified-runner@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const otherAppDigestRef = "agentsmith-lite/app@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const defaultSandboxNamespaceLimit = String(DEFAULT_SANDBOX_NAMESPACE_LIMIT);
const validAppSessionSecret = "app-session-secret-at-least-32-chars";

describe("deploy app doctor artifact checks", () => {
  it("passes rendered local-default manifests without requiring an Ingress", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-app-doctor-local-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const outDir = path.join(tempDir, "manifests");
    writeFileSync(envFile, "KUBE_NAMESPACE=agentsmith\n");
    writeFileSync(
      secretsFile,
      `POSTGRES_APP_URL=postgres://app\nAPP_SESSION_SECRET=${validAppSessionSecret}\nBUILTIN_ADMIN_INITIAL_PASSWORD=admin-password\n`
    );

    const render = spawnSync("bash", ["scripts/deploy/render.sh", "--env", envFile, "--secrets", secretsFile, "--out", outDir, "--tag", "dev"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(render.status, 0, render.stderr);
    assert.doesNotMatch(readFileSync(path.join(outDir, "all.yaml"), "utf8"), /kind: Ingress/);

    const doctor = spawnSync("bash", ["scripts/deploy/doctor.sh", "--env", envFile, "--secrets", secretsFile, "--out", outDir], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /App doctor passed/);
  });

  it("passes static rendered manifest checks when the app Ingress is present", () => {
    const fixture = writeDoctorFixture();

    const result = runDoctor(fixture, []);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /App doctor passed/);
  });

  it("does not run K8s fact checks when the substrate env omits kube connection settings", () => {
    const fixture = writeDoctorFixture();
    const fakeKubectl = writeFakeKubectl(fixture.tempDir);

    const result = runDoctor(fixture, [], {
      PATH: `${fixture.tempDir}:${process.env.PATH ?? ""}`,
      FAKE_KUBECTL_CALLS: fakeKubectl.callsFile
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(fakeKubectl.callsFile), false);
  });

  it("runs K8s deployment fact checks when kube connection settings are present", () => {
    const fixture = writeDoctorFixture({
      extraEnv: [
        "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
        "KUBE_CONTEXT=kind-agentsmith",
        "JUICEFS_PVC_NAME=agentsmith-lite-juicefs"
      ]
    });
    const fakeKubectl = writeFakeKubectl(fixture.tempDir);

    const result = runDoctor(fixture, [], {
      PATH: `${fixture.tempDir}:${process.env.PATH ?? ""}`,
      FAKE_KUBECTL_CALLS: fakeKubectl.callsFile
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /App doctor passed/);

    const calls = readFileSync(fakeKubectl.callsFile, "utf8").trim().split("\n");
    assert.ok(
      calls.some((call) =>
        call.includes(
          "--kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith wait --for=condition=complete job/agentsmith-lite-schema-bootstrap"
        )
      ),
      "schema bootstrap wait must run"
    );
    assert.ok(
      calls.some((call) =>
        call.includes("--kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout status deploy/agentsmith-lite-api")
      ),
      "API rollout status must run"
    );
    assert.ok(
      calls.some((call) => call.includes("--kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith get pvc agentsmith-lite-juicefs")),
      "JuiceFS PVC lookup must run"
    );

    for (const resource of ["pods", "services", "secrets", "configmaps", "serviceaccounts", "networkpolicies"]) {
      for (const verb of ["create", "get", "list", "delete"]) {
        assert.ok(
          calls.some(
            (call) =>
              call.includes(` auth can-i ${verb} ${resource} `) &&
              call.includes("--as=system:serviceaccount:agentsmith:agentsmith-lite-api")
          ),
          `API service account must be checked for ${verb} ${resource}`
        );
      }
    }

    for (const resource of ["pods/exec", "persistentvolumes", "persistentvolumeclaims", "clusterroles"]) {
      assert.ok(
        calls.some(
          (call) =>
            call.includes(` auth can-i create ${resource} `) &&
            call.includes("--as=system:serviceaccount:agentsmith:agentsmith-lite-api")
        ),
        `API service account must be checked against forbidden ${resource}`
      );
    }
  });

  it("fails K8s fact checks without leaking deploy secrets when a required allow is denied", () => {
    const fixture = writeDoctorFixture({
      extraEnv: [
        "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
        "KUBE_CONTEXT=kind-agentsmith",
        "JUICEFS_PVC_NAME=agentsmith-lite-juicefs"
      ],
      postgresUrl: "postgres://DO_NOT_PRINT_APP_URL",
      appSessionSecret: "DO_NOT_PRINT_APP_SESSION_SECRET_VALUE",
      adminPassword: "DO_NOT_PRINT_INITIAL_PASSWORD"
    });
    const fakeKubectl = writeFakeKubectl(fixture.tempDir);

    const result = runDoctor(fixture, [], {
      PATH: `${fixture.tempDir}:${process.env.PATH ?? ""}`,
      FAKE_KUBECTL_CALLS: fakeKubectl.callsFile,
      FAKE_KUBECTL_DENY_CHECKS: "create:pods"
    });
    const report = existsSync("out/app-doctor-report.json") ? readFileSync("out/app-doctor-report.json", "utf8") : "";
    const diagnosticText = `${result.stdout}\n${result.stderr}\n${report}`;

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /create pods/i);
    assert.doesNotMatch(diagnosticText, /DO_NOT_PRINT_APP_URL/);
    assert.doesNotMatch(diagnosticText, /DO_NOT_PRINT_APP_SESSION_SECRET/);
    assert.doesNotMatch(diagnosticText, /DO_NOT_PRINT_INITIAL_PASSWORD/);
  });

  it("fails K8s fact checks when a forbidden API service account surface is allowed", () => {
    const fixture = writeDoctorFixture({
      extraEnv: [
        "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
        "KUBE_CONTEXT=kind-agentsmith",
        "JUICEFS_PVC_NAME=agentsmith-lite-juicefs"
      ]
    });
    const fakeKubectl = writeFakeKubectl(fixture.tempDir);

    const result = runDoctor(fixture, [], {
      PATH: `${fixture.tempDir}:${process.env.PATH ?? ""}`,
      FAKE_KUBECTL_CALLS: fakeKubectl.callsFile,
      FAKE_KUBECTL_ALLOW_FORBIDDEN_CHECKS: "create:persistentvolumes"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /persistentvolumes/i);
  });

  it("fails static rendered manifest checks for non-local public URLs when the app Ingress is missing", () => {
    const fixture = writeDoctorFixture({ omitIngress: true, publicBaseUrl: "https://agentsmith.example.com" });

    const result = runDoctor(fixture, []);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Ingress/i);
  });

  it("fails when the deploy package omits the built-in admin password", () => {
    const fixture = writeDoctorFixture({ adminPassword: null });

    const result = runDoctor(fixture, []);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BUILTIN_ADMIN_INITIAL_PASSWORD is required/i);
  });

  it("fails when the app session secret is shorter than 32 characters without leaking the value", () => {
    const weakSecret = "DO_NOT_PRINT_WEAK_SECRET";
    const fixture = writeDoctorFixture({ appSessionSecret: weakSecret });

    const result = runDoctor(fixture, []);
    const report = existsSync("out/app-doctor-report.json") ? readFileSync("out/app-doctor-report.json", "utf8") : "";
    const diagnosticText = `${result.stdout}\n${result.stderr}\n${report}`;

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APP_SESSION_SECRET must be at least 32 characters/i);
    assert.doesNotMatch(diagnosticText, new RegExp(weakSecret));
  });

  it("fails when live sandbox deploy uses the default built-in admin password", () => {
    const fixture = writeDoctorFixture({
      sandboxMode: "live",
      adminPassword: "admin-password"
    });

    const result = runDoctor(fixture, []);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BUILTIN_ADMIN_INITIAL_PASSWORD must be non-default/i);
  });

  it("fails when sandbox mode has a typo", () => {
    const fixture = writeDoctorFixture({ sandboxMode: "liv" });

    const result = runDoctor(fixture, []);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGENTSMITH_LITE_SANDBOX_MODE must be either dry-run or live/);
  });

  it("fails when the namespace sandbox limit is invalid", () => {
    for (const sandboxNamespaceLimit of ["0", "9007199254740992"]) {
      const fixture = writeDoctorFixture({ sandboxNamespaceLimit });

      const result = runDoctor(fixture, []);

      assert.notEqual(result.status, 0, sandboxNamespaceLimit);
      assert.match(result.stderr, /AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT must be a positive integer/, sandboxNamespaceLimit);
    }
  });

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

  const adminPassword = options.adminPassword === undefined ? "admin-secret" : options.adminPassword;
  writeFileSync(
    envFile,
    [
      "KUBE_NAMESPACE=agentsmith",
      ...(options.publicBaseUrl ? [`APP_PUBLIC_BASE_URL=${options.publicBaseUrl}`] : []),
      ...(options.sandboxMode ? [`AGENTSMITH_LITE_SANDBOX_MODE=${options.sandboxMode}`] : []),
      ...(options.sandboxNamespaceLimit ? [`AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT=${options.sandboxNamespaceLimit}`] : []),
      ...(options.extraEnv ?? []),
      ""
    ].join("\n")
  );
  writeFileSync(
    secretsFile,
    [
      `POSTGRES_APP_URL=${options.postgresUrl ?? "postgres://app"}`,
      `APP_SESSION_SECRET=${options.appSessionSecret ?? validAppSessionSecret}`,
      ...(adminPassword === null ? [] : [`BUILTIN_ADMIN_INITIAL_PASSWORD=${adminPassword}`]),
      ""
    ].join("\n")
  );
  writeManifests(outDir, {
    appImage: options.appImage ?? appDigestRef,
    runnerImage: options.runnerImage ?? runnerDigestRef,
    adminPassword,
    sandboxMode: options.sandboxMode,
    sandboxNamespaceLimit: options.sandboxNamespaceLimit,
    extraManifest: options.extraManifest,
    omitIngress: options.omitIngress
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
  AGENTSMITH_LITE_SANDBOX_MODE: ${options.sandboxMode ?? "dry-run"}
  AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT: ${options.sandboxNamespaceLimit ?? defaultSandboxNamespaceLimit}
  BOTIFIED_RUNNER_IMAGE: ${options.runnerImage}
---
apiVersion: v1
kind: Secret
metadata:
  name: agentsmith-lite-app-secrets
stringData:
${options.adminPassword === null ? "" : `  BUILTIN_ADMIN_INITIAL_PASSWORD: ${options.adminPassword}
`}
${options.omitIngress ? "" : `---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: agentsmith-lite-api
spec:
  rules:
    - host: agentsmith.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: agentsmith-lite-api
                port:
                  name: http
`}
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

function runDoctor(fixture: DoctorFixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["scripts/deploy/doctor.sh", "--env", fixture.envFile, "--secrets", fixture.secretsFile, "--out", fixture.outDir, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      KUBECONFIG_PATH: "",
      KUBE_CONTEXT: "",
      ...env
    }
  });
}

function writeFakeKubectl(tempDir: string): { callsFile: string } {
  const fakeKubectl = path.join(tempDir, "kubectl");
  const callsFile = path.join(tempDir, "kubectl-calls.txt");
  writeFileSync(
    fakeKubectl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_KUBECTL_CALLS"

if [ "$#" -lt 1 ]; then
  exit 64
fi

joined=" $* "
if [[ "$joined" == *" wait --for=condition=complete job/agentsmith-lite-schema-bootstrap "* ]]; then
  exit 0
fi
if [[ "$joined" == *" rollout status deploy/agentsmith-lite-api "* ]]; then
  exit 0
fi
if [[ "$joined" == *" get pvc agentsmith-lite-juicefs "* ]]; then
  exit 0
fi

if [[ "$joined" == *" auth can-i "* ]]; then
  found_can_i=0
  verb=""
  resource=""
  for arg in "$@"; do
    if [ "$found_can_i" = "1" ]; then
      verb="$arg"
      found_can_i=2
      continue
    fi
    if [ "$found_can_i" = "2" ]; then
      resource="$arg"
      break
    fi
    if [ "$arg" = "can-i" ]; then
      found_can_i=1
    fi
  done

  check="$verb:$resource"
  case " \${FAKE_KUBECTL_DENY_CHECKS:-} " in
    *" $check "*) exit 1 ;;
  esac
  case " \${FAKE_KUBECTL_ALLOW_FORBIDDEN_CHECKS:-} " in
    *" $check "*) exit 0 ;;
  esac

  case "$resource" in
    pods|services|secrets|configmaps|serviceaccounts|networkpolicies)
      case "$verb" in
        create|get|list|delete) exit 0 ;;
      esac
      ;;
    pods/exec|persistentvolumes|persistentvolumeclaims|clusterroles)
      exit 1
      ;;
  esac
fi

exit 64
`
  );
  chmodSync(fakeKubectl, 0o755);
  return { callsFile };
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
  omitIngress?: boolean | undefined;
  publicBaseUrl?: string | undefined;
  sandboxMode?: string | undefined;
  sandboxNamespaceLimit?: string | undefined;
  extraEnv?: string[] | undefined;
  postgresUrl?: string | undefined;
  appSessionSecret?: string | undefined;
  adminPassword: string | null;
}
