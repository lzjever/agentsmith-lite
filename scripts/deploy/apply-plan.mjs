import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseAppImagesLock, validateAppManifestImagesAgainstLock } from "../../dist/packages/sandbox-controller/src/appImageLock.js";
import { createAppDeployPlan, formatKubectlCommand } from "../../dist/packages/sandbox-controller/src/appDeployPlan.js";
import { readEnvOnlyContractFile } from "./env-contract.mjs";

const args = parseArgs(process.argv.slice(2));
const manifestOut = await resolveManifestOut(args.out);
const contract = args.env ? await readEnvOnlyContractFile(args.env) : { env: {} };
const env = { ...process.env, ...contract.env };
if (args.images_lock) {
  const imageRefs = parseAppImagesLock(await readFile(args.images_lock, "utf8"));
  validateAppManifestImagesAgainstLock(await readManifestText(manifestOut), imageRefs);
}
const appDeployPlan = createAppDeployPlan({ out: manifestOut, timeout: args.timeout, env });
const rolloutStatuses = appDeployPlan.slice(-2);
if (rolloutStatuses.length !== 2) {
  throw new Error("app deploy plan is missing workload rollout statuses");
}
const kubectlGlobalArgs = rolloutStatuses[0].args.slice(0, -4);
const plan = [
  ...appDeployPlan.slice(0, -2),
  { executable: "kubectl", args: [...kubectlGlobalArgs, "rollout", "restart", "deploy/agentsmith-lite-api"] },
  { executable: "kubectl", args: [...kubectlGlobalArgs, "rollout", "restart", "deploy/agentsmith-lite-web"] },
  ...rolloutStatuses
];

if (args.dry_run) {
  for (const command of plan) {
    console.log(formatKubectlCommand(command));
  }
} else {
  for (const command of plan) {
    const result = spawnSync(command.executable, command.args, { stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    if (result.signal) {
      throw new Error(`${command.executable} exited with signal ${result.signal}`);
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

function parseArgs(argv) {
  const parsed = {
    out: "out/manifests",
    timeout: "300s",
    dry_run: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env" || arg === "--out" || arg === "--timeout" || arg === "--images-lock") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      parsed[arg.slice(2).replace("-", "_")] = value;
      index += 1;
    } else if (arg === "--dry-run") {
      parsed.dry_run = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function readManifestText(out) {
  const outStat = await stat(out);
  if (outStat.isDirectory()) {
    return readFile(path.join(out, "all.yaml"), "utf8");
  }
  return readFile(out, "utf8");
}

async function resolveManifestOut(out) {
  const outStat = await stat(out);
  return outStat.isDirectory() ? path.join(out, "all.yaml") : out;
}
