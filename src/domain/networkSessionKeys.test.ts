import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { isNetworkSessionKey, networkSessionKeys } from './networkSessionKeys';

test('every network connection a publisher stores is cleared on sign-out', () => {
  const dir = new URL('../connectors/publishing/', import.meta.url);
  const keys = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .flatMap((file) => [...readFileSync(new URL(file, dir), 'utf8').matchAll(/'(open-media\.network\.[a-z.]+)'/g)].map((match) => match[1]));
  assert.ok(keys.length >= 8);
  for (const key of keys) assert.ok((networkSessionKeys as readonly string[]).includes(key), `${key} must be in networkSessionKeys`);
  for (const id of ['x', 'threads', 'linkedin', 'instagram', 'facebook']) assert.ok(isNetworkSessionKey(`open-media.network.${id}`));
  assert.ok(isNetworkSessionKey('open-media.cross-posting.ledger'));
  assert.ok(!isNetworkSessionKey('open-media.appearance'));
});
