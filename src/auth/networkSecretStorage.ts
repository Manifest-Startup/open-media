import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { encryptedStore, SecretStore } from '../domain/secretSealing';
import { deviceSecretStorage } from './supabase';

export type { SecretStore };

/**
 * Where network access tokens (LinkedIn, X, Threads, Instagram, Facebook) are kept on this device.
 *
 * Phones: the Keychain/Keystore, as for every other device secret.
 * Web: browser storage, encrypted with AES-GCM under a key that is generated in this browser,
 * marked non-extractable and kept in IndexedDB. The token is never written to storage in plain
 * text, and the key itself can't be read out or copied to another browser. (LinkedIn's
 * secure-applications guidance and API Terms §7.1; docs/compliance/linkedin.md, LI-08.)
 */
const databaseName = 'open-media-keys';
const storeName = 'keys';
const keyName = 'network-secrets';

let keyPromise: Promise<CryptoKey | undefined> | undefined;

function webCryptoAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && Boolean(crypto.subtle);
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
}

async function openDatabase(): Promise<IDBDatabase> {
  const opening = indexedDB.open(databaseName, 1);
  opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains(storeName)) opening.result.createObjectStore(storeName); };
  return request(opening);
}

async function encryptionKey(): Promise<CryptoKey | undefined> {
  if (!webCryptoAvailable()) return undefined;
  keyPromise ??= (async () => {
    const database = await openDatabase();
    const existing = await request(database.transaction(storeName, 'readonly').objectStore(storeName).get(keyName)) as CryptoKey | undefined;
    if (existing) return existing;
    const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await request(database.transaction(storeName, 'readwrite').objectStore(storeName).put(created, keyName));
    return created;
  })().catch(() => { keyPromise = undefined; return undefined; });
  return keyPromise;
}

let webStore: SecretStore | undefined;

export function networkSecretStorage(): SecretStore {
  if (Platform.OS !== 'web') {
    const native = deviceSecretStorage();
    return {
      getItem: async (name) => native.getItem(name),
      setItem: async (name, value) => { await native.setItem(name, value); },
      removeItem: async (name) => { await native.removeItem(name); },
    };
  }
  return webStore ??= encryptedStore(AsyncStorage, encryptionKey);
}
