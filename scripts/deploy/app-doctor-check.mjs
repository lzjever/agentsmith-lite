import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseAppImagesLock, validateAppManifestImagesAgainstLock } from "../../dist/packages/sandbox-controller/src/appImageLock.js";

const REQUIRED_BUNDLE_FILES = ["manifest.yaml", "images.lock", "checksums.txt", "images/app.tar", "images/botified-runner.tar"];
const CHECKSUMMED_BUNDLE_FILES = ["manifest.yaml", "images.lock", "images/app.tar", "images/botified-runner.tar"];
const CHECKSUMMED_BUNDLE_FILE_SET = new Set(CHECKSUMMED_BUNDLE_FILES);
const IMAGE_ARCHIVES = ["images/app.tar", "images/botified-runner.tar"];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bundle && !args.images_lock) {
    return;
  }
  if (!args.out) {
    throw new Error("--out is required when validating an app bundle or images.lock");
  }

  const outStat = await statPath(args.out);
  if (!outStat) {
    throw new Error(`--out rendered manifests path does not exist: ${args.out}`);
  }

  let bundleRefs;
  if (args.bundle) {
    bundleRefs = await validateBundle(args.bundle);
  }

  let explicitRefs;
  if (args.images_lock) {
    explicitRefs = parseAppImagesLock(await readFile(args.images_lock, "utf8"));
  }

  if (bundleRefs && explicitRefs) {
    assertSameImageRefs(bundleRefs, explicitRefs);
  }

  const imageRefs = explicitRefs ?? bundleRefs;
  if (imageRefs) {
    validateAppManifestImagesAgainstLock(await readManifestText(args.out, outStat), imageRefs);
  }
}

async function validateBundle(bundleDir) {
  const bundleStat = await statPath(bundleDir);
  if (!bundleStat?.isDirectory()) {
    throw new Error(`app offline bundle directory does not exist: ${bundleDir}`);
  }

  for (const relativePath of REQUIRED_BUNDLE_FILES) {
    const fileStat = await statPath(path.join(bundleDir, relativePath));
    if (!fileStat?.isFile()) {
      throw new Error(`app offline bundle missing required file: ${relativePath}`);
    }
  }

  for (const relativePath of IMAGE_ARCHIVES) {
    const fileStat = await stat(path.join(bundleDir, relativePath));
    if (fileStat.size === 0) {
      throw new Error(`app offline bundle image archive is empty: ${relativePath}`);
    }
  }

  const checksums = parseChecksums(await readFile(path.join(bundleDir, "checksums.txt"), "utf8"));
  for (const relativePath of CHECKSUMMED_BUNDLE_FILES) {
    const expected = checksums.get(relativePath);
    if (!expected) {
      throw new Error(`app offline bundle missing checksum entry: ${relativePath}`);
    }
    const actual = await sha256File(path.join(bundleDir, relativePath));
    if (actual !== expected) {
      throw new Error(`app offline bundle checksum mismatch: ${relativePath}`);
    }
  }

  return parseAppImagesLock(await readFile(path.join(bundleDir, "images.lock"), "utf8"));
}

function assertSameImageRefs(bundleRefs, explicitRefs) {
  if (bundleRefs.app !== explicitRefs.app) {
    throw new Error("bundle images.lock does not match explicit --images-lock app digest ref");
  }
  if (bundleRefs.botifiedRunner !== explicitRefs.botifiedRunner) {
    throw new Error("bundle images.lock does not match explicit --images-lock botified runner digest ref");
  }
}

async function readManifestText(out, outStat) {
  if (outStat.isDirectory()) {
    return readFile(path.join(out, "all.yaml"), "utf8");
  }
  if (outStat.isFile()) {
    return readFile(out, "utf8");
  }
  throw new Error(`--out rendered manifests path must be a file or directory: ${out}`);
}

function parseChecksums(text) {
  const checksums = new Map();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const match = /^(?<sha>[a-fA-F0-9]{64})  (?<file>.+)$/.exec(line);
    if (!match?.groups) {
      throw new Error(`app offline bundle checksums.txt line ${index + 1} is invalid`);
    }
    const file = match.groups.file;
    if (!CHECKSUMMED_BUNDLE_FILE_SET.has(file)) {
      throw new Error(`app offline bundle checksums.txt contains unsupported entry: ${file}`);
    }
    if (checksums.has(file)) {
      throw new Error(`app offline bundle checksums.txt contains duplicate entry: ${file}`);
    }
    checksums.set(file, match.groups.sha.toLowerCase());
  }
  return checksums;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function statPath(file) {
  try {
    return await stat(file);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "--bundle" || arg === "--images-lock") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      parsed[arg.slice(2).replace("-", "_")] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
