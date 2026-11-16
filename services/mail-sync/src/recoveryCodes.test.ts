import assert from 'node:assert/strict';
import test from 'node:test';

import { RecoveryError, useRecoveryCode } from './recoveryCodes.js';

const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'secret' };
const request = () => new Request('https://api.test/v1/auth/recovery', { method: 'POST', headers: { authorization: 'Bearer aal1-token' } });
const verify = async () => ({ token: 'aal1-token', userId: 'u1', aal: 'aal1' });

function backend(answer: string) {
  const calls: Array<{ method: string; url: string; body?: string; key?: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? String(init.body) : undefined, key: new Headers(init?.headers).get('apikey') });
    if (url.endsWith('/rpc/open_media_use_recovery_code')) return Response.json(answer);
    if (url.endsWith('/admin/users/u1/factors')) return Response.json([{ id: 'f1' }, { id: 'f2' }]);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('a recovery code is used up, then the person’s second-step factors are removed with the admin key', async () => {
  const { calls, fetchImpl } = backend('ok');
  assert.deepEqual(await useRecoveryCode(request(), env, { code: 'abcd-efgh-jkmn-pqrs' }, fetchImpl, verify), { recovered: true, removed_factors: 2 });
  assert.deepEqual(JSON.parse(calls[0].body!), { p_user: 'u1', p_code: 'abcd-efgh-jkmn-pqrs' }, 'the code is checked for the session’s own person');
  assert.ok(calls.every((call) => call.key === 'secret'));
  assert.deepEqual(calls.filter((call) => call.method === 'DELETE').map((call) => call.url), ['https://db.test/auth/v1/admin/users/u1/factors/f1', 'https://db.test/auth/v1/admin/users/u1/factors/f2']);
});

test('wrong codes, too many tries, no session and malformed input remove nothing', async () => {
  for (const [answer, status] of [['invalid', 400], ['rate_limited', 429]] as const) {
    const { calls, fetchImpl } = backend(answer);
    await assert.rejects(useRecoveryCode(request(), env, { code: 'abcd-efgh-jkmn-pqrs' }, fetchImpl, verify), (error: unknown) => error instanceof RecoveryError && error.status === status);
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
  }
  const { calls, fetchImpl } = backend('ok');
  await assert.rejects(useRecoveryCode(request(), env, { code: 'abcd-efgh-jkmn-pqrs' }, fetchImpl, async () => { throw new Error('bad signature'); }), (error: unknown) => error instanceof RecoveryError && error.status === 401);
  await assert.rejects(useRecoveryCode(request(), env, { code: '<script>' }, fetchImpl, verify), (error: unknown) => error instanceof RecoveryError && error.status === 400);
  await assert.rejects(useRecoveryCode(request(), { SUPABASE_URL: 'https://db.test' }, { code: 'abcd-efgh-jkmn-pqrs' }, fetchImpl, verify), (error: unknown) => error instanceof RecoveryError && error.status === 503);
  assert.equal(calls.length, 0);
});
