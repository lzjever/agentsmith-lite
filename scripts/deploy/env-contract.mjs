#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const substrateEnvKeys = new Set([
  "KUBE_NAMESPACE",
  "KUBECONFIG_PATH",
  "KUBE_CONTEXT",
  "APP_PUBLIC_BASE_URL",
  "APP_INGRESS_CLASS",
  "APP_TLS_SECRET_NAME",
  "JUICEFS_PVC_NAME",
  "AUTH_MODE"
]);

const appEnvKeys = new Set([
  "BOTIFIED_RUNNER_IMAGE",
  "AGENTSMITH_LITE_DATA_DIR",
  "AGENTSMITH_LITE_SANDBOX_MODE",
  "AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT",
  "AGENTSMITH_LITE_RUNTIME_TICK_MS"
]);

const smokeEnvKeys = new Set([
  "SMOKE_ENDPOINT_BASE_URL",
  "SMOKE_ENDPOINT_MODEL",
  "SMOKE_ENDPOINT_SECRET_REF",
  "SMOKE_TASK",
  "SMOKE_TASK_RECLAIM",
  "SMOKE_TASK_RECLAIM_REAP_APPLY",
  "SMOKE_TASK_TIMEOUT_SECS"
]);

const productSecretKeys = new Set([
  "POSTGRES_APP_URL",
  "APP_SESSION_SECRET",
  "BUILTIN_ADMIN_INITIAL_PASSWORD",
  "OIDC_CLIENT_SECRET"
]);

const generatedSubstrateOnlyKeys = new Set([
  "SUBSTRATE_SCHEMA_VERSION",
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "REGISTRY_URL",
  "IMAGE_PULL_SECRET_NAME"
]);

export async function readContractFiles(options = {}) {
  const envEntries = options.envFile
    ? await readContractFile(options.envFile, "env", { profile: options.profile })
    : [];
  const secretEntries = options.secretsFile
    ? await readContractFile(options.secretsFile, "secrets", { profile: options.profile })
    : [];
  const appEnvEntries = options.appEnvFile
    ? await readContractFile(options.appEnvFile, "app-env", { profile: options.profile })
    : [];
  const appSecretEntries = options.appSecretsFile
    ? await readContractFile(options.appSecretsFile, "app-secrets", { profile: options.profile })
    : [];
  const env = [...envEntries, ...appEnvEntries];
  const secrets = [...secretEntries, ...appSecretEntries];

  return {
    entries: [...envEntries, ...secretEntries, ...appEnvEntries, ...appSecretEntries],
    env: Object.fromEntries(env),
    secrets: Object.fromEntries(secrets),
    values: Object.fromEntries([...env, ...secrets])
  };
}

export async function readContractFile(file, kind, options = {}) {
  const text = await readFile(file, "utf8");
  return parseContractText(text, { ...options, file, kind });
}

export function parseContractText(text, options = {}) {
  const kind = options.kind;
  if (kind !== "env" && kind !== "secrets" && kind !== "app-env" && kind !== "app-secrets") {
    throw new EnvContractError("env contract parser requires kind env, secrets, app-env, or app-secrets");
  }

  const profile = options.profile ?? "default";
  const file = options.file ?? "<inline>";
  const entries = new Map();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseLine(lines[index], { file, lineNumber: index + 1 });
    if (!parsed) {
      continue;
    }
    const { key, value } = parsed;
    const disposition = classifyKey(key, kind, profile);
    if (disposition === "allow") {
      entries.set(key, value);
      continue;
    }
    if (disposition === "ignore") {
      continue;
    }
    throw new EnvContractError(formatKeyError(disposition, key, file, index + 1));
  }
  return [...entries.entries()];
}

export class EnvContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvContractError";
  }
}

function parseLine(line, context) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  let assignment = trimmed;
  if (/^export(\s|$)/.test(assignment)) {
    assignment = assignment.slice("export".length).trimStart();
  }

  const equals = assignment.indexOf("=");
  if (equals === -1) {
    throw new EnvContractError(`invalid env contract assignment at ${describeLocation(context)}`);
  }

  const key = assignment.slice(0, equals).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new EnvContractError(`invalid env contract key at ${describeLocation(context)}`);
  }

  const rawValue = assignment.slice(equals + 1).trim();
  return { key, value: parseValue(rawValue, key, context) };
}

function parseValue(rawValue, key, context) {
  if (!rawValue) {
    return "";
  }
  const quote = rawValue[0];
  if (quote !== "\"" && quote !== "'") {
    return rawValue;
  }
  if (rawValue.length < 2 || rawValue[rawValue.length - 1] !== quote) {
    throw new EnvContractError(`invalid quoted value for ${key} at ${describeLocation(context)}`);
  }
  return rawValue.slice(1, -1);
}

function classifyKey(key, kind, profile) {
  if (kind === "env") {
    if (isSubstrateEnvKey(key)) {
      return "allow";
    }
    if (isSubstrateOnlyKey(key)) {
      return "ignore";
    }
    if (isProductSecretKey(key) || isAppSecretKey(key)) {
      return "secret-in-env";
    }
    if (isAnyAppEnvKey(key)) {
      return "app-only-in-substrate";
    }
    return "unknown-env";
  }

  if (kind === "secrets") {
    if (isProductSecretKey(key)) {
      return "allow";
    }
    if (isSubstrateOnlyKey(key)) {
      return "ignore";
    }
    if (isSubstrateEnvKey(key) || isAnyAppEnvKey(key)) {
      return "config-in-secrets";
    }
    if (isAppSecretKey(key)) {
      return "app-only-in-substrate";
    }
    return "unknown-secrets";
  }

  if (kind === "app-env") {
    if (isAppEnvKey(key, profile)) {
      return "allow";
    }
    if (smokeEnvKeys.has(key)) {
      return "smoke-profile-required";
    }
    if (isProductSecretKey(key) || isAppSecretKey(key)) {
      return "secret-in-env";
    }
    return "unknown-env";
  }

  if (isAppSecretKey(key)) {
    return "allow";
  }
  if (isProductSecretKey(key)) {
    return "product-secret-in-app-secrets";
  }
  if (isSubstrateEnvKey(key) || isAnyAppEnvKey(key)) {
    return "config-in-secrets";
  }
  return "unknown-secrets";
}

function isSubstrateEnvKey(key) {
  return substrateEnvKeys.has(key);
}

function isAppEnvKey(key, profile) {
  return appEnvKeys.has(key) || key.startsWith("AGENTSMITH_LITE_MODEL_BASE_URL_") || (profile === "smoke" && smokeEnvKeys.has(key));
}

function isAnyAppEnvKey(key) {
  return appEnvKeys.has(key) || key.startsWith("AGENTSMITH_LITE_MODEL_BASE_URL_") || smokeEnvKeys.has(key);
}

function isProductSecretKey(key) {
  return productSecretKeys.has(key);
}

function isAppSecretKey(key) {
  return key.startsWith("AGENTSMITH_LITE_MODEL_API_KEY_");
}

function isSubstrateOnlyKey(key) {
  return generatedSubstrateOnlyKeys.has(key) || key.startsWith("S3_") || (key.startsWith("JUICEFS_") && key !== "JUICEFS_PVC_NAME");
}

function formatKeyError(disposition, key, file, lineNumber) {
  const location = describeLocation({ file, lineNumber });
  switch (disposition) {
    case "secret-in-env":
      return `secret key ${key} is not allowed in env at ${location}`;
    case "config-in-secrets":
      return `non-secret config key ${key} is not allowed in secrets at ${location}`;
    case "unknown-env":
      return `unknown env key ${key} at ${location}`;
    case "unknown-secrets":
      return `unknown secrets key ${key} at ${location}`;
    case "app-only-in-substrate":
      return `app overlay key ${key} is not allowed in substrate contract at ${location}`;
    case "smoke-profile-required":
      return `smoke overlay key ${key} requires --profile smoke at ${location}`;
    case "product-secret-in-app-secrets":
      return `product secret key ${key} must come from substrate secrets at ${location}`;
    default:
      return `invalid env contract key ${key} at ${location}`;
  }
}

function describeLocation(context) {
  return `${context.file}:${context.lineNumber}`;
}

function parseCliArgs(argv) {
  const command = argv[0];
  if (command !== "export") {
    throw new EnvContractError("usage: env-contract.mjs export [--env file] [--secrets file] [--app-env file] [--app-secrets file] [--profile smoke]");
  }

  const parsed = { profile: "default" };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env" || arg === "--secrets" || arg === "--app-env" || arg === "--app-secrets" || arg === "--profile") {
      const value = argv[index + 1];
      if (!value) {
        throw new EnvContractError(`${arg} requires a value`);
      }
      parsed[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else {
      throw new EnvContractError(`unknown env-contract argument: ${arg}`);
    }
  }
  if (parsed.profile !== "default" && parsed.profile !== "smoke") {
    throw new EnvContractError(`unknown env contract profile: ${parsed.profile}`);
  }
  return parsed;
}

async function runCli(argv) {
  const args = parseCliArgs(argv);
  const { entries } = await readContractFiles({
    envFile: args.env,
    secretsFile: args.secrets,
    appEnvFile: args.appEnv,
    appSecretsFile: args.appSecrets,
    profile: args.profile
  });
  for (const [key, value] of entries) {
    process.stdout.write(`${key}=${value}\n`);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(2);
  }
}
