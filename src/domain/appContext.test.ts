import assert from 'node:assert/strict';
import test from 'node:test';

import { appChip, appContextOf, isAppUrl, parseAppContext } from './appContext';

test('a Manifest context with an idea, a title and a link on Manifest is accepted as sent', () => {
  const context = { app: 'manifest', idea_id: 'idea_42', title: 'Solar kiosks', url: 'https://manifeststartup.com/ideas/42' };
  assert.deepEqual(parseAppContext(context), { ok: true, context });
  assert.deepEqual(parseAppContext({ app: 'manifest' }), { ok: true, context: { app: 'manifest' } });
});

test('unknown apps, extra keys, foreign links and oversized values are refused', () => {
  for (const value of [
    null, 'manifest', [], {},
    { app: 'other' },
    { app: 'manifest', idea_id: 'x', secret: 'y' },
    { app: 'manifest', idea_id: '' },
    { app: 'manifest', idea_id: 42 },
    { app: 'manifest', idea_id: 'a'.repeat(201) },
    { app: 'manifest', title: 'two\nlines' },
    { app: 'manifest', title: 'a'.repeat(301) },
    { app: 'manifest', url: 'https://evil.test/manifeststartup.com' },
    { app: 'manifest', url: 'https://manifeststartup.com.evil.test/' },
    { app: 'manifest', url: 'http://manifeststartup.com/ideas/1' },
    { app: 'manifest', url: 'https://user:pass@manifeststartup.com/' },
    { app: 'manifest', url: 'javascript:alert(1)' },
  ]) {
    assert.equal(parseAppContext(value).ok, false, JSON.stringify(value));
  }
  assert.equal(isAppUrl('manifest', 'https://www.manifeststartup.com/x'), true, 'subdomains of the app are its own site');
  const big = { app: 'manifest', idea_id: 'i'.repeat(200), title: 't'.repeat(300), url: `https://manifeststartup.com/${'p'.repeat(1900)}` };
  assert.equal(parseAppContext(big).ok, false, 'the whole context is at most 2 KB');
});

test('the chip names the app and only links to its own site', () => {
  assert.deepEqual(appChip({ app: 'manifest', title: 'Solar kiosks', url: 'https://manifeststartup.com/ideas/42' }), {
    label: 'From Manifest', url: 'https://manifeststartup.com/ideas/42', accessibilityLabel: 'From Manifest: Solar kiosks. Opens Manifest.',
  });
  assert.deepEqual(appChip({ app: 'manifest' }), { label: 'From Manifest', accessibilityLabel: 'From Manifest' });
  assert.equal(appChip(null), null);
  assert.equal(appChip({ app: 'manifest', url: 'https://evil.test' }), null, 'a context the server would refuse shows nothing');
  assert.equal(appContextOf(undefined), null);
});

test('posts keep an app context only when it is one the server would accept', async () => {
  const { socialPostFromPublic } = await import('./publicPosts');
  const record = { id: 'p1', body: 'Pitch', createdAt: '2026-11-15T12:00:00Z', author: { id: 'u1', handle: 'ana', displayName: 'Ana', avatarUrl: null } };
  assert.deepEqual(socialPostFromPublic({ ...record, context: { app: 'manifest', idea_id: '42' } }).appContext, { app: 'manifest', idea_id: '42' });
  assert.equal(socialPostFromPublic({ ...record, context: { app: 'manifest', url: 'https://evil.test' } }).appContext, undefined);
  assert.equal(socialPostFromPublic(record).appContext, undefined);
});
