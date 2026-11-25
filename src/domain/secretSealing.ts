/**
 * Sealing device secrets with AES-GCM before they reach browser storage (see
 * src/auth/networkSecretStorage.ts). Pure Web Crypto, so it runs in tests as well as browsers.
 */
export interface SecretStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const prefix = 'omenc1:';

const toBase64 = (bytes: Uint8Array) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export async function sealSecret(key: CryptoKey, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)));
  return `${prefix}${toBase64(iv)}:${toBase64(sealed)}`;
}

export async function openSecret(key: CryptoKey, stored: string): Promise<string | null> {
  const [iv, sealed] = stored.slice(prefix.length).split(':');
  if (!iv || !sealed) return null;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(sealed)));
  } catch {
    return null; // Sealed by a key this browser no longer has: treat as not connected.
  }
}

/** Encrypts values with `key()` before they reach `storage`. Exported for tests. */
export function encryptedStore(storage: SecretStore, key: () => Promise<CryptoKey | undefined>): SecretStore {
  return {
    async getItem(name) {
      const stored = await storage.getItem(name);
      if (stored === null) return null;
      const cryptoKey = await key();
      if (!stored.startsWith(prefix)) {
        // Saved before encryption existed: seal it now so no plain copy stays behind.
        if (cryptoKey) await storage.setItem(name, await sealSecret(cryptoKey, stored));
        return stored;
      }
      return cryptoKey ? openSecret(cryptoKey, stored) : null;
    },
    async setItem(name, value) {
      const cryptoKey = await key();
      if (!cryptoKey) throw new Error('This browser can’t keep the connection safely. Try another browser.');
      await storage.setItem(name, await sealSecret(cryptoKey, value));
    },
    removeItem: (name) => storage.removeItem(name),
  };
}
