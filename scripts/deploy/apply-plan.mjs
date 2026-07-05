import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createAppDeployPlan, formatKubectlCommand } from "../../dist/packages/sandbox-controller/src/appDeployPlan.js";

const args = parseArgs(process.argv.slice(2));
const envFileValues = args.env ? await readEnvFile(args.env) : {};
const env = { ...process.env, ...envFileValues };
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
    if (arg === "--env" || arg === "--out" || arg === "--timeout") {
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

async function readEnvFile(file) {
  const text = await readFile(file, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const equals = assignment.indexOf("=");
    if (equals === -1) continue;
    const key = assignment.slice(0, equals).trim();
    const rawValue = assignment.slice(equals + 1).trim();
    values[key] = stripMatchingQuotes(rawValue);
  }
  return values;
}

function stripMatchingQuotes(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
