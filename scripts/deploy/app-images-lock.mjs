#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const parserPath = path.join(repoRoot, "dist/packages/sandbox-controller/src/appImageLock.js");
const lockFile = process.argv[2];

if (!lockFile) {
  console.error("usage: app-images-lock.mjs <images.lock>");
  process.exit(2);
}

if (!existsSync(parserPath)) {
  console.error(`missing built app images.lock parser: ${parserPath}`);
  console.error("Run npm run build:api before using scripts that validate app images.lock files.");
  process.exit(1);
}

try {
  const { parseAppImagesLock } = await import(pathToFileURL(parserPath).href);
  const refs = parseAppImagesLock(readFileSync(lockFile, "utf8"));
  console.log(refs.app);
  console.log(refs.botifiedRunner);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
