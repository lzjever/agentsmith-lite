import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseAppImagesLock, validateAppManifestImagesAgainstLock } from "../../dist/packages/sandbox-controller/src/appImageLock.js";
import { createAppDeployPlan, formatKubectlCommand } from "../../dist/packages/sandbox-controller/src/appDeployPlan.js";
import { readContractFiles } from "./env-contract.mjs";

const args = parseArgs(process.argv.slice(2));
const contract = args.env ? await readContractFiles({ envFile: args.env }) : { env: {} };
const env = { ...process.env, ...contract.env };
if (args.images_lock) {
  const imageRefs = parseAppImagesLock(await readFile(args.images_lock, "utf8"));
  validateAppManifestImagesAgainstLock(await readManifestText(args.out), imageRefs);
}
const plan = createAppDeployPlan({ out: args.out, timeout: args.timeout, env });

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
