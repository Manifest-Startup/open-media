/**
 * Recovery codes (ADR 0042): the way back in for someone who lost their passkey or authenticator app.
 *
 * The person has signed in with an email code, a link or a password, so their session is real but
 * still owes its second step (aal1). POST /v1/auth/recovery with that session and one code:
 * 1. the session's signature is checked (not its second step, which is what they can't do);
 * 2. the database uses up the code (open_media_use_recovery_code, service role only; at most five
 *    wrong codes per person per 15 minutes);
 * 3. the person's second-step factors are removed with the admin API, so the same aal1 session now
 *    counts as fully signed in. The app then asks them to set a second step up again.
 * Their sign-in passkeys are kept: those are a way in, not a second step.
 */
import { verifySessionToken } from './session.js';

export interface RecoveryEnv { SUPABASE_URL: string; SUPABASE_SECRET_KEY?: string }

export class RecoveryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function useRecoveryCode(request: Request, env: RecoveryEnv, body: unknown, fetchImpl: typeof fetch = fetch, verify = verifySessionToken): Promise<{ recovered: true; removed_factors: number }> {
  if (!env.SUPABASE_SECRET_KEY) throw new RecoveryError(503, 'not_configured', 'Recovery codes aren’t set up on this server.');
  const code = typeof (body as { code?: unknown })?.code === 'string' ? (body as { code: string }).code : '';
  if (!/^[A-Za-z0-9 -]{12,40}$/.test(code)) throw new RecoveryError(400, 'bad_request', 'Type one of your recovery codes, like abcd-efgh-jkmn-pqrs.');
  let userId: string;
  try { ({ userId } = await verify(request, env.SUPABASE_URL)); }
  catch { throw new RecoveryError(401, 'unauthorized', 'Sign in with your email or password first, then use a recovery code.'); }
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const admin = { apikey: env.SUPABASE_SECRET_KEY, authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, 'content-type': 'application/json' };
  const used = await fetchImpl(`${base}/rest/v1/rpc/open_media_use_recovery_code`, { method: 'POST', headers: admin, body: JSON.stringify({ p_user: userId, p_code: code }) });
  if (!used.ok) throw new RecoveryError(502, 'unavailable', 'Couldn’t check the code. Try again shortly.');
  const result = await used.json() as string;
  if (result === 'rate_limited') throw new RecoveryError(429, 'rate_limited', 'Too many wrong codes. Wait 15 minutes, then try again.');
  if (result !== 'ok') throw new RecoveryError(400, 'invalid_code', 'That recovery code is wrong or was already used.');
  const listed = await fetchImpl(`${base}/auth/v1/admin/users/${userId}/factors`, { headers: admin });
  if (!listed.ok) throw new RecoveryError(502, 'unavailable', 'The code was used, but your second step couldn’t be reset. Try again shortly or contact support.');
  const factors = await listed.json() as Array<{ id: string }>;
  for (const factor of factors) {
    const removed = await fetchImpl(`${base}/auth/v1/admin/users/${userId}/factors/${factor.id}`, { method: 'DELETE', headers: admin });
    if (!removed.ok && removed.status !== 404) throw new RecoveryError(502, 'unavailable', 'The code was used, but your second step couldn’t be reset. Try again shortly or contact support.');
  }
  return { recovered: true, removed_factors: factors.length };
}
