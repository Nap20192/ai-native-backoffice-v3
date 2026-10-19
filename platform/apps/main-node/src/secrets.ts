// Secrets component: hands out a cipher per purpose. The default derives
// every purpose key from PLATFORM_ROOT_SECRET with AES-GCM; a deployment
// can pass a KMS-backed implementation instead.

import { WebCryptoAesGcm, type PurposeCipher } from "./lib/web-crypto-aes-gcm.js";

export type { PurposeCipher };

export interface NodeSecrets {
  /**
   * A cipher whose ciphertexts can only be read back by the same purpose.
   * Purposes are stable strings such as "managed.vault.credentials"; the
   * same purpose must return an equivalent cipher for the lifetime of the
   * data it sealed.
   */
  cipherFor(purpose: string): PurposeCipher;
}

export function createNodeSecrets(rootSecret: string): NodeSecrets {
  const ciphers = new Map<string, PurposeCipher>();
  return {
    cipherFor(purpose) {
      let cipher = ciphers.get(purpose);
      if (cipher === undefined) {
        cipher = new WebCryptoAesGcm(rootSecret, purpose);
        ciphers.set(purpose, cipher);
      }
      return cipher;
    },
  };
}
