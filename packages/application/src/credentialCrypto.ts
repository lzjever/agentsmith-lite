import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface CredentialAadInput {
  credentialId: string;
  projectId: string;
  type: "api_key";
  version: number;
}

export interface EncryptedCredentialValue {
  algorithm: typeof ALGORITHM;
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export interface CredentialCrypto {
  encrypt(value: string, aad: Buffer): EncryptedCredentialValue;
  decrypt(value: EncryptedCredentialValue, aad: Buffer): string;
}

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

interface EncryptionKey {
  id: string;
  value: Buffer;
}

export interface CredentialEncryptionConfig {
  readonly primary: EncryptionKey;
  readonly previous: readonly EncryptionKey[];
}

export function parseCredentialEncryptionConfig(env: Record<string, string | undefined>): CredentialEncryptionConfig {
  const primary = parseEncryptionKey(env.APP_CREDENTIAL_ENCRYPTION_KEY, "APP_CREDENTIAL_ENCRYPTION_KEY");
  const previous = (env.APP_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value, index) => parseEncryptionKey(value, `APP_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS[${index}]`));
  const ids = new Set<string>();
  for (const key of [primary, ...previous]) {
    if (ids.has(key.id)) {
      throw new CredentialCryptoError("Credential encryption keys must not be duplicated");
    }
    ids.add(key.id);
  }
  return { primary, previous };
}

export function createCredentialCrypto(config: CredentialEncryptionConfig): CredentialCrypto {
  const keys = new Map<string, Buffer>([
    [config.primary.id, config.primary.value],
    ...config.previous.map((key) => [key.id, key.value] as const)
  ]);

  return {
    encrypt(value, aad) {
      const plaintext = Buffer.from(value, "utf8");
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, config.primary.value, nonce, { authTagLength: 16 });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        algorithm: ALGORITHM,
        keyId: config.primary.id,
        nonce,
        ciphertext,
        authTag: cipher.getAuthTag()
      };
    },
    decrypt(value, aad) {
      if (value.algorithm !== ALGORITHM) {
        throw new CredentialCryptoError("Credential ciphertext algorithm is not supported");
      }
      const key = keys.get(value.keyId);
      if (!key) {
        throw new CredentialCryptoError("Credential encryption key is unavailable");
      }
      if (value.nonce.length !== NONCE_BYTES || value.authTag.length !== 16) {
        throw new CredentialCryptoError("Credential ciphertext is invalid");
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key, value.nonce, { authTagLength: 16 });
        decipher.setAAD(aad);
        decipher.setAuthTag(value.authTag);
        return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8");
      } catch {
        throw new CredentialCryptoError("Credential ciphertext could not be authenticated");
      }
    }
  };
}

export function credentialAad(input: CredentialAadInput): Buffer {
  if (!input.credentialId || !input.projectId || input.type !== "api_key" || !Number.isSafeInteger(input.version) || input.version < 1) {
    throw new CredentialCryptoError("Credential encryption context is invalid");
  }
  return Buffer.from(JSON.stringify(["agentsmith-lite:credential:v1", input.credentialId, input.projectId, input.type, input.version]), "utf8");
}

function parseEncryptionKey(value: string | undefined, name: string): EncryptionKey {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new CredentialCryptoError(`${name} must be a base64url-encoded 32-byte key`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new CredentialCryptoError(`${name} must be a base64url-encoded 32-byte key`);
  }
  const key = Buffer.from(trimmed, "base64url");
  if (key.length !== KEY_BYTES || key.toString("base64url") !== trimmed) {
    throw new CredentialCryptoError(`${name} must be a base64url-encoded 32-byte key`);
  }
  return {
    id: `credkey_${createHash("sha256").update(key).digest("base64url").slice(0, 16)}`,
    value: key
  };
}
