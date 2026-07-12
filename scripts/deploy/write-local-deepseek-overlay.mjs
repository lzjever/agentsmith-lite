import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const key = required("DEEPSEEK_API_KEY");
const baseUrl = required("DEEPSEEK_OPENAI_BASE_URL").replace(/\/+$/, "");
const model = process.env.DEEPSEEK_DEFAULT_MODEL?.trim() || process.env.DEEPSEEK_PRO_MODEL?.trim();
if (!model) throw new Error("DEEPSEEK_DEFAULT_MODEL or DEEPSEEK_PRO_MODEL is required");

const directory = path.resolve(".dev");
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(path.join(directory, "app.env"), [
  `AGENTSMITH_LITE_MODEL_BASE_URL_DEEPSEEK=${baseUrl}`,
  "AGENTSMITH_LITE_SANDBOX_MODE=live",
  "AGENTSMITH_LITE_RUNTIME_TICK_MS=1000"
].join("\n") + "\n", { mode: 0o600 });
const secretsPath = path.join(directory, "app.secrets.env");
const existingSecrets = await readExistingSecrets(secretsPath);
const credentialEncryptionKey = existingSecrets.APP_CREDENTIAL_ENCRYPTION_KEY ?? randomBytes(32).toString("base64url");
await writeFile(secretsPath, [
  `AGENTSMITH_LITE_MODEL_API_KEY_DEEPSEEK=${key}`,
  `APP_CREDENTIAL_ENCRYPTION_KEY=${credentialEncryptionKey}`
].join("\n") + "\n", { mode: 0o600 });
console.log(`DeepSeek overlay written; base=${fingerprint(baseUrl)} key=${fingerprint(key)} model=${fingerprint(model)}`);

function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function fingerprint(value) { return createHash("sha256").update(value).digest("hex").slice(0, 12); }

async function readExistingSecrets(file) {
  try {
    const values = {};
    for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match) values[match[1]] = match[2];
    }
    return values;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}
