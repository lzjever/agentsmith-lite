import { cp, stat } from "node:fs/promises";

const standaloneDir = ".next/standalone";

await copyRequired(".next/static", `${standaloneDir}/.next/static`);
if (await exists("public")) {
  await cp("public", `${standaloneDir}/public`, { recursive: true });
}

async function copyRequired(from, to) {
  if (!await exists(from)) {
    throw new Error(`Next build output is missing ${from}`);
  }
  await cp(from, to, { recursive: true });
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
