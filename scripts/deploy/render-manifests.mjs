import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderAppManifests } from "../../dist/packages/sandbox-controller/src/appManifestRenderer.js";

const args = parseArgs(process.argv.slice(2));
if (!args.env || !args.out) {
  throw new Error("usage: render.sh --env substrate.env [--secrets substrate.secrets.env] --tag dev --out out/manifests");
}

const env = await readEnvFile(args.env);
const secrets = args.secrets ? await readEnvFile(args.secrets) : {};
const namespace = env.KUBE_NAMESPACE ?? "agentsmith";
const tag = args.tag ?? "dev";
const manifests = renderAppManifests({ namespace, imageTag: tag, env, secrets });
await mkdir(args.out, { recursive: true });

const documents = manifests.map(toYaml).join("---\n");
await writeFile(path.join(args.out, "all.yaml"), documents);
for (const [index, resource] of manifests.entries()) {
  const filename = `${String(index + 1).padStart(2, "0")}-${resource.kind.toLowerCase()}-${resource.metadata.name}.yaml`;
  await writeFile(path.join(args.out, filename), toYaml(resource));
}
console.log(`Rendered ${manifests.length} app manifests to ${args.out}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env" || arg === "--secrets" || arg === "--tag" || arg === "--out" || arg === "--images-lock") {
      parsed[arg.slice(2).replace("-", "_")] = argv[index + 1];
      index += 1;
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
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    values[trimmed.slice(0, equals)] = trimmed.slice(equals + 1).replace(/^"|"$/g, "");
  }
  return values;
}

function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value.map((item) => `${pad}- ${formatYamlItem(item, indent + 2)}`).join("\n") + "\n";
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, item]) => {
      if (item && typeof item === "object") {
        return `${pad}${key}:\n${toYaml(item, indent + 2).trimEnd()}`;
      }
      return `${pad}${key}: ${scalar(item)}`;
    }).join("\n") + "\n";
  }
  return `${pad}${scalar(value)}\n`;
}

function formatYamlItem(item, indent) {
  if (item && typeof item === "object") {
    return `\n${toYaml(item, indent).trimEnd()}`;
  }
  return scalar(item);
}

function scalar(value) {
  if (value === null || value === undefined) return "\"\"";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9_.:/@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

