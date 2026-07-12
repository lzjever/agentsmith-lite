import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  CredentialCryptoError,
  createCredentialCrypto,
  credentialAad,
  parseCredentialEncryptionConfig
} from "../../packages/application/src/credentialCrypto.js";

function key(): string {
  return randomBytes(32).toString("base64url");
}

test("credential crypto encrypts with primary key and authenticates its immutable context", () => {
  const crypto = createCredentialCrypto(parseCredentialEncryptionConfig({ APP_CREDENTIAL_ENCRYPTION_KEY: key() }));
  const aad = credentialAad({ credentialId: "cred_1", projectId: "proj_1", type: "api_key", version: 1 });
  const encrypted = crypto.encrypt("provider-key", aad);

  assert.equal(encrypted.algorithm, "aes-256-gcm");
  assert.match(encrypted.keyId, /^credkey_/);
  assert.notEqual(encrypted.ciphertext.toString("utf8"), "provider-key");
  assert.equal(crypto.decrypt(encrypted, aad), "provider-key");
  assert.throws(
    () => crypto.decrypt(encrypted, credentialAad({ credentialId: "cred_1", projectId: "proj_2", type: "api_key", version: 1 })),
    CredentialCryptoError
  );
});

test("credential crypto decrypts previous-key ciphertext and fails closed for unknown or modified ciphertext", () => {
  const previousKey = key();
  const oldCrypto = createCredentialCrypto(parseCredentialEncryptionConfig({ APP_CREDENTIAL_ENCRYPTION_KEY: previousKey }));
  const aad = credentialAad({ credentialId: "cred_1", projectId: "proj_1", type: "api_key", version: 1 });
  const encrypted = oldCrypto.encrypt("provider-key", aad);
  const rotatingCrypto = createCredentialCrypto(parseCredentialEncryptionConfig({
    APP_CREDENTIAL_ENCRYPTION_KEY: key(),
    APP_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: previousKey
  }));

  assert.equal(rotatingCrypto.decrypt(encrypted, aad), "provider-key");
  assert.throws(
    () => rotatingCrypto.decrypt({ ...encrypted, ciphertext: Buffer.from("modified") }, aad),
    (error: unknown) => error instanceof CredentialCryptoError && !String(error.message).includes("provider-key")
  );
  assert.throws(
    () => rotatingCrypto.decrypt({ ...encrypted, keyId: "credkey_missing" }, aad),
    CredentialCryptoError
  );
});

test("credential encryption config accepts only unique base64url 32-byte keys", () => {
  const primary = key();
  assert.throws(
    () => parseCredentialEncryptionConfig({ APP_CREDENTIAL_ENCRYPTION_KEY: "not-a-key" }),
    /APP_CREDENTIAL_ENCRYPTION_KEY/
  );
  assert.throws(
    () => parseCredentialEncryptionConfig({ APP_CREDENTIAL_ENCRYPTION_KEY: primary, APP_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: primary }),
    /must not be duplicated/
  );
});
