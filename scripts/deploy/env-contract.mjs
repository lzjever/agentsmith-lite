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
  "APP_INGRESS_TRAEFIK_ENTRYPOINTS",
  "APP_TLS_SECRET_NAME",
  "JUICEFS_PVC_NAME"
]);

const appEnvKeys = new Set([
  "BOTIFIED_RUNNER_IMAGE",
  "AGENTSMITH_LITE_DATA_DIR",
  "AGENTSMITH_LITE_SANDBOX_MODE",
  "AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT",
  "AGENTSMITH_LITE_SANDBOX_IDLE_TTL_MS",
  "AGENTSMITH_LITE_SANDBOX_MAX_LIFETIME_MS",
  "AGENTSMITH_LITE_RUNTIME_TICK_MS",
  "AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP",
  "AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY"
]);

const appSecretKeys = new Set([
  "APP_CREDENTIAL_ENCRYPTION_KEY",
  "APP_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS"
]);

const productSecretKeys = new Set([
  "POSTGRES_APP_URL",
  "APP_SESSION_SECRET"
]);

const oidcCoreSubstrateEnvKeys = [
  "OIDC_ISSUER_URL",
  "OIDC_BACKCHANNEL_BASE_URL",
  "OIDC_CLIENT_ID"
];
const oidcCoreSubstrateEnvKeySet = new Set(oidcCoreSubstrateEnvKeys);

const generatedSubstrateOnlyKeys = new Set([
  "SUBSTRATE_SCHEMA_VERSION",
  "SUBSTRATE_NAMESPACE",
  "REGISTRY_URL",
  "IMAGE_PULL_SECRET_NAME",
  "KUBERNETES_SKIP_K3S",
  "OIDC_BOOTSTRAP_USERNAME",
  "OIDC_BOOTSTRAP_EMAIL",
  "OIDC_BOOTSTRAP_PASSWORD",
  "KEYCLOAK_DB_USER",
  "KEYCLOAK_DB_PASSWORD",
  "KEYCLOAK_DB_DATABASE",
  "KEYCLOAK_ADMIN_USERNAME",
  "KEYCLOAK_ADMIN_PASSWORD"
]);

export async function readContractFiles(options = {}) {
  const envEntries = options.envFile
    ? await readContractFile(options.envFile, "env")
    : [];
  const secretEntries = options.secretsFile
    ? await readContractFile(options.secretsFile, "secrets")
    : [];
  const appEnvEntries = options.appEnvFile
    ? await readContractFile(options.appEnvFile, "app-env")
    : [];
  const appSecretEntries = options.appSecretsFile
    ? await readContractFile(options.appSecretsFile, "app-secrets")
    : [];
  const env = [...envEntries, ...appEnvEntries];
  const secrets = [...secretEntries, ...appSecretEntries];
  validateAuthContract(Object.fromEntries(env), Object.fromEntries(secrets));
  validateModelCaContract(Object.fromEntries(env));

  return {
    entries: [...envEntries, ...secretEntries, ...appEnvEntries, ...appSecretEntries],
    env: Object.fromEntries(env),
    secrets: Object.fromEntries(secrets),
    values: Object.fromEntries([...env, ...secrets])
  };
}

export async function readEnvOnlyContractFile(envFile) {
  const entries = await readContractFile(envFile, "env");
  const env = Object.fromEntries(entries);
  return {
    entries,
    env,
    values: env
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

  const file = options.file ?? "<inline>";
  const entries = new Map();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseLine(lines[index], { file, lineNumber: index + 1 });
    if (!parsed) {
      continue;
    }
    const { key, value } = parsed;
    const disposition = classifyKey(key, kind, value);
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

function classifyKey(key, kind, value) {
  const authMetadataDisposition = classifyAuthMetadataKey(key, kind, value);
  if (authMetadataDisposition) {
    return authMetadataDisposition;
  }

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
    if (isAppEnvKey(key)) {
      return "allow";
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

function classifyAuthMetadataKey(key, kind, value) {
  if (key === "AUTH_MODE") {
    if (kind === "env" && value.trim() === "oidc") {
      return "allow";
    }
    return "invalid-auth-mode";
  }
  if (key === "OIDC_CLIENT_SECRET") {
    if (kind === "secrets" && value.trim() !== "") {
      return "allow";
    }
    if (kind === "secrets") {
      return "ignore";
    }
    return "oidc-secret-in-env";
  }
  if (oidcCoreSubstrateEnvKeySet.has(key)) {
    if (kind === "env" && value.trim() !== "") {
      return "allow";
    }
    if (kind === "env") {
      return "ignore";
    }
    if (kind === "app-env") {
      return "oidc-core-metadata-in-app-env";
    }
    return "oidc-public-metadata-in-secrets";
  }
  return null;
}

function validateAuthContract(env, secrets) {
  if (env.AUTH_MODE?.trim() !== "oidc") {
    throw new EnvContractError("AUTH_MODE must be explicitly set to oidc in substrate env");
  }

  for (const key of ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID"]) {
    if (!env[key]?.trim()) {
      throw new EnvContractError(`${key} is required in substrate env when AUTH_MODE=oidc`);
    }
  }
  if (!secrets.OIDC_CLIENT_SECRET?.trim()) {
    throw new EnvContractError("OIDC_CLIENT_SECRET is required in substrate secrets when AUTH_MODE=oidc");
  }
}

function validateModelCaContract(env) {
  if (env.AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY?.trim() && !env.AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP?.trim()) {
    throw new EnvContractError("AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP is required when AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY is set");
  }
}

function isSubstrateEnvKey(key) {
  return substrateEnvKeys.has(key);
}

function isAppEnvKey(key) {
  return appEnvKeys.has(key) || key.startsWith("AGENTSMITH_LITE_MODEL_BASE_URL_");
}

function isAnyAppEnvKey(key) {
  return isAppEnvKey(key);
}

function isProductSecretKey(key) {
  return productSecretKeys.has(key);
}

function isAppSecretKey(key) {
  return appSecretKeys.has(key) || key.startsWith("AGENTSMITH_LITE_MODEL_API_KEY_");
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
    case "product-secret-in-app-secrets":
      return `product secret key ${key} must come from substrate secrets at ${location}`;
    case "invalid-auth-mode":
      return `auth key ${key} must be set to oidc in substrate env at ${location}`;
    case "oidc-secret-in-env":
      return `secret key ${key} is not allowed in env at ${location}`;
    case "oidc-core-metadata-in-app-env":
      return `OIDC core metadata key ${key} must come from substrate env at ${location}`;
    case "oidc-public-metadata-in-secrets":
      return `non-secret config key ${key} is not allowed in secrets at ${location}`;
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
    throw new EnvContractError("usage: env-contract.mjs export [--env-only] [--env file] [--secrets file] [--app-env file] [--app-secrets file]");
  }

  const parsed = { envOnly: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-only") {
      parsed.envOnly = true;
    } else if (arg === "--env" || arg === "--secrets" || arg === "--app-env" || arg === "--app-secrets") {
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
  return parsed;
}

async function runCli(argv) {
  const args = parseCliArgs(argv);
  const { entries } = args.envOnly
    ? await readEnvOnlyCliArgs(args)
    : await readContractFiles({
        envFile: args.env,
        secretsFile: args.secrets,
        appEnvFile: args.appEnv,
        appSecretsFile: args.appSecrets
      });
  for (const [key, value] of entries) {
    process.stdout.write(`${key}=${value}\n`);
  }
}

async function readEnvOnlyCliArgs(args) {
  if (!args.env) {
    throw new EnvContractError("--env-only requires --env");
  }
  if (args.secrets || args.appEnv || args.appSecrets) {
    throw new EnvContractError("--env-only cannot be combined with --secrets, --app-env, or --app-secrets");
  }
  return readEnvOnlyContractFile(args.env);
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
