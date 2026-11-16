import assert from 'node:assert/strict';
import test from 'node:test';

import { signInEmailError } from './signInErrors.js';

test('the email limit reads as a plain instruction, not Supabase’s raw message', () => {
  assert.match(signInEmailError({ message: 'email rate limit exceeded', status: 429 }).message, /^Too many sign-in emails were sent just now\. Wait a few minutes/);
  assert.match(signInEmailError({ message: 'For security purposes, you can only request this after 42 seconds.' }).message, /Try again in 42 seconds, or use a password/);
  assert.equal(signInEmailError({ message: 'Signups not allowed for otp' }).message, 'Signups not allowed for otp');
});
