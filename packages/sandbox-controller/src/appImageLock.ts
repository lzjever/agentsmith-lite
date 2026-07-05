export interface AppImageRefs {
  app: string;
  botifiedRunner: string;
}

const REQUIRED_IMAGES = {
  app: "agentsmith-lite/app",
  botifiedRunner: "agentsmith-lite/botified-runner"
} as const;

const SHA256_DIGEST = /^sha256:[a-fA-F0-9]{64}$/;

export function parseAppImagesLock(text: string): AppImageRefs {
  const refs: Partial<AppImageRefs> = {};

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/\s/.test(line)) {
      throw new Error(`images.lock line ${index + 1} must contain a single image ref`);
    }

    const imageName = imageNameFromRef(line);
    const key = imageName === REQUIRED_IMAGES.app ? "app" : imageName === REQUIRED_IMAGES.botifiedRunner ? "botifiedRunner" : undefined;
    if (!key) {
      throw new Error(`images.lock line ${index + 1} contains unsupported image ref: ${line}`);
    }
    if (refs[key]) {
      throw new Error(`images.lock contains duplicate ${imageName} ref`);
    }
    if (!line.includes("@")) {
      throw new Error(`images.lock ${imageName} ref must be digest-pinned, not a mutable tag`);
    }

    const [nameAndTag, digest, extra] = line.split("@");
    if (!nameAndTag || !digest || extra !== undefined || !SHA256_DIGEST.test(digest)) {
      throw new Error(`images.lock ${imageName} ref has an invalid sha256 digest`);
    }

    refs[key] = line;
  }

  if (!refs.app) {
    throw new Error(`images.lock missing ${REQUIRED_IMAGES.app} digest ref`);
  }
  if (!refs.botifiedRunner) {
    throw new Error(`images.lock missing ${REQUIRED_IMAGES.botifiedRunner} digest ref`);
  }

  return {
    app: refs.app,
    botifiedRunner: refs.botifiedRunner
  };
}

export function validateAppManifestImagesAgainstLock(manifestText: string, imageRefs: AppImageRefs): void {
  if (!manifestText.includes(imageRefs.app)) {
    throw new Error(`manifest does not match images.lock: missing app image ${imageRefs.app}`);
  }
  if (!manifestText.includes(imageRefs.botifiedRunner)) {
    throw new Error(`manifest does not match images.lock: missing botified runner image ${imageRefs.botifiedRunner}`);
  }

  assertNoMutableTag(manifestText, REQUIRED_IMAGES.app);
  assertNoMutableTag(manifestText, REQUIRED_IMAGES.botifiedRunner);
}

function imageNameFromRef(ref: string): string {
  const imagePart = ref.split("@")[0] ?? ref;
  const lastSlash = imagePart.lastIndexOf("/");
  const lastColon = imagePart.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return imagePart.slice(0, lastColon);
  }
  return imagePart;
}

function assertNoMutableTag(manifestText: string, imageName: string): void {
  const mutableTag = new RegExp(`${escapeRegExp(imageName)}:[A-Za-z0-9_.-]+(?![A-Za-z0-9_.-]|@)`);
  if (mutableTag.test(manifestText)) {
    throw new Error(`manifest does not match images.lock: found mutable ${imageName} image tag`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
