import assert from 'node:assert/strict';
import test from 'node:test';

import { encryptedStore, SecretStore } from './secretSealing';

function memory(): SecretStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return { raw, getItem: async (key) => raw.get(key) ?? null, setItem: async (key, value) => { raw.set(key, value); }, removeItem: async (key) => { raw.delete(key); } };
}

const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

test('network tokens are never stored in plain text and read back intact', async () => {
  const storage = memory(); const key = await newKey();
  const store = encryptedStore(storage, async () => key);
  await store.setItem('open-media.network.linkedin', '{"token":"secret-token"}');
  const raw = storage.raw.get('open-media.network.linkedin')!;
  assert.match(raw, /^omenc1:/);
  assert.ok(!raw.includes('secret-token'));
  assert.equal(await store.getItem('open-media.network.linkedin'), '{"token":"secret-token"}');
});

test('a plain value saved before encryption is sealed on first read', async () => {
  const storage = memory(); const key = await newKey();
  storage.raw.set('k', 'old-plain');
  const store = encryptedStore(storage, async () => key);
  assert.equal(await store.getItem('k'), 'old-plain');
  assert.match(storage.raw.get('k')!, /^omenc1:/);
});

test('another browser’s key can’t open it, and no key means no saving', async () => {
  const storage = memory();
  await encryptedStore(storage, async () => await newKey()).setItem('k', 'v');
  assert.equal(await encryptedStore(storage, async () => await newKey()).getItem('k'), null);
  await assert.rejects(encryptedStore(memory(), async () => undefined).setItem('k', 'v'), /can’t keep the connection safely/);
});
