import assert from 'node:assert/strict';
import test from 'node:test';

import { appLinkRedirect, cleanGatewaySearch, nextGatewayStep, normalizeRecoveryCode, readGatewayParams, recoveryCodesFile, safeNext, sessionEndpoint } from './signInGateway';

const challenge = 'ab'.repeat(32);

test('the gateway reads only well-formed values from its address', () => {
  const params = readGatewayParams(`?request=${challenge}&token_hash=abcdefghijklmnopqrst&type=signup&login_hint=Ana%40Example.test&next=%2F%23feed`);
  assert.deepEqual(params, { request: challenge, tokenHash: 'abcdefghijklmnopqrst', linkType: 'signup', code: undefined, linkError: undefined, loginHint: 'ana@example.test', next: '/#feed' });
  const bad = readGatewayParams('request=nope&token_hash=<x>&type=recovery&login_hint=not-an-email&code=a');
  assert.equal(bad.request, undefined);
  assert.equal(bad.tokenHash, undefined);
  assert.equal(bad.linkType, 'magiclink', 'only sign-in link types are accepted');
  assert.equal(bad.loginHint, undefined);
  assert.equal(bad.code, undefined);
});

test('own mode only ever continues to a path on this site', () => {
  for (const value of ['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)', '/signin', '/signin?request=x', '/ok\nx', null]) assert.equal(safeNext(value), '/', String(value));
  assert.equal(safeNext('/@ana'), '/@ana');
});

test('one-time values leave the address bar once read', () => {
  assert.equal(cleanGatewaySearch({ request: challenge, next: '/' }), `?request=${challenge}`);
  assert.equal(cleanGatewaySearch({ next: '/' }), '');
  assert.equal(cleanGatewaySearch({ next: '/#clips' }), '?next=%2F%23clips');
});

test('the steps go sign-in, second step, profile, then the app (consent) or done', () => {
  assert.equal(nextGatewayStep({ signedIn: false, secondStepNeeded: false, hasProfile: false, appMode: true }), 'sign-in');
  assert.equal(nextGatewayStep({ signedIn: true, secondStepNeeded: true, hasProfile: true, appMode: true }), 'second-step');
  assert.equal(nextGatewayStep({ signedIn: true, secondStepNeeded: false, hasProfile: false, appMode: false }), 'profile', 'every account has a profile');
  assert.equal(nextGatewayStep({ signedIn: true, secondStepNeeded: false, hasProfile: true, appMode: true }), 'consent');
  assert.equal(nextGatewayStep({ signedIn: true, secondStepNeeded: false, hasProfile: true, appMode: false }), 'done');
});

test('app mode talks only to the configured API', () => {
  assert.equal(sessionEndpoint('https://api.openmedia.site/'), 'https://api.openmedia.site/authorize/account/session');
  assert.equal(appLinkRedirect('https://api.openmedia.site', challenge), `https://api.openmedia.site/authorize/account/link?challenge=${challenge}`);
});

test('recovery codes are typed loosely and saved as a plain file', () => {
  assert.equal(normalizeRecoveryCode(' ABCD efgh-JKMN pqrs!! '), 'abcd-efgh-jkmn-pqrs');
  assert.equal(normalizeRecoveryCode('abcde'), 'abcd-e');
  const file = recoveryCodesFile(['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'], 'ana@example.test', new Date('2026-11-16T00:00:00Z'));
  assert.ok(file.includes('Account: ana@example.test') && file.includes('Made: 2026-11-16') && file.includes('eeee-ffff-gggg-hhhh'));
});
