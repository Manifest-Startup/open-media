/**
 * Supabase's sign-in errors in words people understand. The common one is the email limit: until
 * Open Media's own emails are on, Supabase's built-in sender allows only a few emails an hour for
 * everyone, and its raw message is "email rate limit exceeded".
 */
export function signInEmailError(error: { message?: string; status?: number; code?: string }): Error {
  const text = `${error.code ?? ''} ${error.message ?? ''}`;
  if (error.status === 429 || /rate.?limit|over_email_send_rate_limit|security purposes/i.test(text)) {
    const seconds = Number(/after (\d+) seconds/i.exec(text)?.[1]);
    const wait = seconds ? `Try again in ${seconds} seconds` : 'Wait a few minutes and try again';
    return new Error(`Too many sign-in emails were sent just now. ${wait}, or use a password instead.`);
  }
  return new Error(error.message || 'The sign-in email could not be sent. Try again shortly.');
}
