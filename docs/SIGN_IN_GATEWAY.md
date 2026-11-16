# One sign-in for Open Media and Manifest (spec, 2026-11-16)

Status: built on `feat/sign-in-gateway`, not deployed. Decisions, verification and what is left: [ADR 0042](adrs/0042-one-sign-in-gateway-passkeys-and-mfa.md). The old Worker HTML forms were removed rather than kept as a fallback (ADR 0042, decision 4).

Owner decisions:
- **Identity:** Open Media is the only identity provider. Manifest signs in only with "Continue with Open Media" (OAuth 2.1 + PKCE). Manifest auto-links existing accounts by verified email. Guests can still try Manifest, and upgrade by continuing with Open Media.
- **Passkeys:** passkey-first sign-in (no email or password) through Supabase passkeys (`/auth/v1/passkeys/*`, supabase-js `auth.signInWithPasskey`, `auth.experimental.passkey: true`). Email code or one-tap link, and password, stay for new devices.
- **MFA:** optional. Passkeys plus an authenticator app (TOTP) plus one-time recovery codes. Once a person adds a second factor, the database enforces it (extend the existing `open_media_session_meets_mfa()` from ADR 0034).
- **Platforms:** web now (the Open Media web app and Manifest). The iOS and Android apps move in a later release; their current native sign-in keeps working unchanged.

## The gateway: `https://openmedia.site/signin`

One screen in the Expo web app. It reuses the app's design system, theme (light and dark), and fonts, so the Open Media app and every connected app see the same polished page.

**Flow**
1. **Continue with passkey** is the primary button. It is offered by conditional UI / autofill where the browser supports it. One tap signs in.
2. **Email.** The email field is pre-filled from `login_hint`. **Continue** sends the one-tap link and a code (ADR 0041 / one-tap connect). The button in the email comes back to this page in the same browser. Typing the code also works.
3. **Use a password instead** sits behind a quiet link.
4. **New accounts:** after the first sign-in, ask for name and handle on the same page before continuing. Every account has a profile.
5. **Second step:** if the account has MFA factors and the session is `aal1`, show **Confirm it's you**. Offer passkey (WebAuthn MFA) or the authenticator code, and "Use a recovery code".
6. **App mode** (`?request=<challenge id>` from the Worker's `/authorize`):
   - Show the app's name and icon (from its CIMD `client_name`/`logo_uri`).
   - Show a short consent list and one **Continue to <App>** button.
   - Sign in with a **separate, in-memory supabase client**, never the app's persisted session, so the grant gets its own session and refresh-token rotation can't log either one out.
   - Then make a top-level form POST of `{challenge, access_token, refresh_token}` to `https://api.openmedia.site/authorize/account/session`.

   Same-site cookies make the challenge cookie (path `/authorize`) arrive. The Worker:
   - checks the cookie matches the challenge
   - validates the token with Supabase `/auth/v1/user`
   - requires `open_media_session_meets_mfa()` to be true for that token
   - completes the authorization (props: the session) and 302s to the client's `redirect_uri`
7. **Own mode** (no `request`): the Open Media web app's sign-in. It is the same page with the persisted client, then goes to the app.

**Existing Worker HTML.** The current Worker HTML pages (`/authorize` email form, code form, link page) become a fallback. `/authorize` for account scope now 302s to the gateway with the challenge. The one-tap email link (`/authorize/account/link`) redirects to the gateway with `token_hash`, which the gateway verifies with its in-memory client (`verifyOtp({ token_hash, type })`).

**Page security.** The gateway is on `openmedia.site`; the API is on `api.openmedia.site`.
- strict CSP for the page, no third-party scripts
- the passkey RP ID is `openmedia.site`
- rate limits on email sends, as already exist
- never logs tokens

## Security settings (in the Open Media app: Profile → Sign-in and security, web)

- **Passkeys:** list, add, rename, remove (Supabase `/passkeys`).
- **Authenticator app:** enroll a TOTP factor (QR code plus secret), verify, remove.
- **Recovery codes:**
  - Generate 10 one-time codes; show them once and allow download.
  - Store them as hashes in a private table.
  - Regenerating replaces them all.
  - Using one (gateway, "Use a recovery code") calls a Worker endpoint with the person's `aal1` session. The Worker:
    - checks and consumes the code
    - removes that person's MFA factors with the admin API
    - signs them in at `aal1`
    - asks them to set up a factor again
- **Password:** set or change.
- **Signed-in apps:** list OAuth grants (Manifest and others) and revoke them.

**Database enforcement.** Extend `open_media_session_meets_mfa()` so these count:
- a verified TOTP factor (in addition to WebAuthn)
- a passkey-first sign-in, if GoTrue marks it in `amr`. **Verify locally what amr/aal a passkey sign-in yields and document it.**

  A passkey sign-in is phishing-resistant with user verification, so it should satisfy MFA for people whose second factor is a passkey. If it is only `aal1`, people with TOTP still do the TOTP step.

## API changes for apps

- `GET /v1/connected/me` (and `/v1/me`) also returns `email` and `email_verified` (from the session's user) and `has_profile`. `/v1/me` must not 404 for a person without a profile on the connected route; return `has_profile:false` instead.
- No other contract changes. Token endpoint `/oauth/token`, CIMD clients, `/v1/connected/*` stay as they are.

## Production configuration (owner runs a script; agents can't change production config)

The Supabase auth settings:
- `passkey_enabled`
- WebAuthn RP: `openmedia.site`, origins `https://openmedia.site` and `https://www.openmedia.site`, name `Open Media`
- `mfa_totp_enroll_enabled` and `mfa_totp_verify_enabled`
- `mfa_web_authn_enroll_enabled` and `mfa_web_authn_verify_enabled`
- email confirmations on
- password minimum 8
- the send-email hook
- redirect allow list: the gateway `https://openmedia.site/signin**` and `https://api.openmedia.site/authorize/account/link**`

The script is `~/.config/manifest/enable-open-media-email.sh`; extend it rather than starting a new one.
