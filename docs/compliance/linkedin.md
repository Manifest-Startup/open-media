# LinkedIn compliance report

| | |
|---|---|
| **Connection** | LinkedIn: sharing a person's own Open Media posts to their LinkedIn feed (posting only; Open Media never reads LinkedIn) |
| **How it connects** | OAuth 2.0 authorization code flow; scopes `openid profile w_member_social`; Posts API `POST /rest/posts` with `LinkedIn-Version: 202611` and `X-Restli-Protocol-Version: 2.0.0`; member ID and name from `/v2/userinfo` |
| **Developer app** | "Open Media" in the LinkedIn Developer Portal (linkedin.com/developers/apps), tied to Open Media's LinkedIn Page; products: Share on LinkedIn, Sign In with LinkedIn using OpenID Connect; redirect `https://openmedia.site/v1/social/linkedin/callback` |
| **Secrets** | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`: Cloudflare Worker secrets on `convo-mail-sync`, with the source of truth in Infisical (OpenMedia → Production → `/worker`). Optional variable `LINKEDIN_API_VERSION` (YYYYMM). |
| **Status** | Live since 2026-11-25 (`/v1/social/status` → `"linkedin": true`) |
| **Last reviewed** | 2026-11-25 by Claude Code for the owner |
| **Next review** | 2027-05-25, or sooner if LinkedIn changes its terms, scopes or API version. The API version must be bumped before 202611 is retired (about November 2027). |
| **Related ADRs** | [0033](../adrs/0033-every-social-network-bluesky-mastodon-nostr-and-official-oauth.md) |

## Summary

Open Media meets LinkedIn's API Terms, Posts API rules and brand rules for member sharing. The review found four gaps, all fixed in the change that added this report (LI-04, LI-05, LI-08, LI-09):

- Connections are now cleared on sign-out and account deletion, and tied to the Open Media account that made them.
- On the web, tokens are encrypted at rest.
- The privacy policy and the consent text now cover LinkedIn.
- The LinkedIn mark is never recoloured.

Two items are only partly met: LI-16 (the logo is drawn from an icon font, not LinkedIn's downloaded asset) and LI-11 (revocation can only be done on LinkedIn). Both are listed under gaps.

## What Open Media accesses and keeps

| Data | Why | Where it lives | How long | How it is deleted |
|---|---|---|---|---|
| LinkedIn access token (60 days) | To share the posts the person chooses | The person's device only: Keychain/Keystore on phones; on web, encrypted (AES-GCM, non-extractable key in IndexedDB). Passes through the Open Media server for each share, and is never stored or logged there. | Until it expires, the person disconnects, signs out or deletes their account | Disconnect, sign-out and account deletion remove it from the device. The person can also revoke it on LinkedIn. |
| LinkedIn member ID (`sub`) and name | The member ID is the post's author (`urn:li:person:…`). The name shows which account is connected. | Same as the token, in the same record | Same as the token | Same as the token |
| IDs of posts shared to LinkedIn (post URN) | Links "View on LinkedIn" and avoids posting twice | The device's cross-post record | Last 300 posts | Sign-out and account deletion clear it |
| LinkedIn feed, connections, messages, profile details | Not accessed | — | — | — |

## Requirements matrix

Sources are listed with IDs (S1…) under Sources. All were read on 2026-11-25.

| ID | Requirement | Source | How Open Media complies | Evidence | Status |
|---|---|---|---|---|---|
| LI-01 | No automated or bulk posting. Content is shared only as the member's own action. | S1 §3.1 | Posts go to LinkedIn only when the person taps Post (or Retry) in the composer. The agent, MCP and WebMCP tools post to Open Media only and can't reach LinkedIn. There are no scheduled shares. | `src/ui/OpenMediaFeed.tsx` (calls to `crossPost`); `src/domain/webMcpTools.ts` (read-only); `services/mail-sync/src/agentApi.ts` (no social publish) | Complies |
| LI-02 | Don't pre-fill content the member didn't write | S1 §3.1 | The composer is never pre-filled | `src/ui/OpenMediaFeed.tsx` | Complies |
| LI-03 | The member chooses where each post goes | S1 §3.1, §5.2 | Connected networks are listed in the composer and can be switched off for each post. "Include by default" is the person's own setting. | `src/domain/crossPosting.ts`; `src/ui/CrossPostingSettings.tsx` | Complies (see G-03 for a clarity improvement) |
| LI-04 | Don't let anyone act as a member without that member's consent | S1 §3.1, §5.2 | A connection is saved together with the Open Media user who made it, and can't be used by anyone else. Sign-out and account deletion clear every network connection on the device. | `src/connectors/publishing/oauthNetwork.ts` (`owner`); `src/auth/supabase.ts` `clearNetworkSessions`; `src/data/openMediaService.ts` `deleteCurrentAccount`; test `src/domain/networkSessionKeys.test.ts` | Complies (fixed 2026-11-25) |
| LI-05 | Tell members what data is used and how, get their consent, and offer a privacy policy | S1 §5.1, §5.2 | The approval prompt says what Open Media can do, that it receives the name and member ID, that posts are public, and how to disconnect. The privacy page has a "Sharing to other networks" section. | `src/connectors/publishing/oauthNetwork.ts` (`what.linkedin`); `services/mail-sync/src/agentSite.ts` `/privacy`; https://openmedia.site/privacy | Complies (fixed 2026-11-25) |
| LI-06 | Store only what is needed, and don't build profiles from member data | S1 §4.1, §4.3 | Only the member ID and name are kept from userinfo, on the device. Nothing is kept on the server, and nothing is used for ranking or ads. | `services/mail-sync/src/socialOAuth.ts` `exchangeCode`; privacy page | Complies |
| LI-07 | Delete member data on request or when the account closes | S1 §4.4 | Account deletion and sign-out clear the token, the identity and the cross-post record on the device. The server holds nothing. | `clearNetworkSessions`; `deleteCurrentAccount` | Complies (fixed 2026-11-25) |
| LI-08 | Keep tokens secure and never in easily reached client storage. Encrypt at rest. Keep the client secret server-side. | S1 §2.2, §7.1; S7 | Phones: Keychain/Keystore. Web: AES-GCM with a non-extractable key in IndexedDB, and plain copies left from before are sealed on first read. The client secret exists only as a Worker secret and in Infisical, and is sent only to LinkedIn's token endpoint. | `src/auth/networkSecretStorage.ts`; `src/domain/secretSealing.ts` + test; `services/mail-sync/src/socialOAuth.ts` | Complies (fixed 2026-11-25) |
| LI-09 | Use the LinkedIn mark unaltered, only in its allowed colours, and don't imply endorsement | S8, S9; S1 §6.1 | The mark is always drawn in black or white, never greyed. The wording is factual ("Connect LinkedIn to share your posts", "Approve Open Media on LinkedIn"), and LinkedIn branding isn't used in marketing. | `src/ui/NetworkMark.tsx` (`brandLockedMarks`); `src/ui/CrossPostingSettings.tsx` | Complies (fixed 2026-11-25); asset source: see LI-16 |
| LI-10 | CSRF protection: state is checked | S6 | `state` is random (`omc_` plus 32 hex characters plus the client), checked on the server and matched on the device | `services/mail-sync/src/socialOAuth.ts` `parseState`; `src/connectors/publishing/oauthWindow.ts` | Complies |
| LI-11 | Members can revoke access | S1 §5.2 | Disconnect removes the token from the device. The privacy page and the disconnect hint say how to revoke on LinkedIn. Self-serve apps have no revoke endpoint. | `oauthNetwork.ts` `revoke.linkedin`; privacy page | Partial (see G-02) |
| LI-12 | Tokens last 60 days. Refresh tokens are for approved partners only, so otherwise the member signs in again. | S6 | Refresh is used only when LinkedIn sends a refresh token. Otherwise an expired sign-in shows "Connect LinkedIn again". | `socialOAuth.ts` `refreshSession`; test "an expired LinkedIn sign-in … asks to reconnect" | Complies |
| LI-13 | Use a supported API version. LinkedIn returns 426 for retired versions. | S4 | Default 202611, which can be overridden by `LINKEDIN_API_VERSION` without a build. A 426 gets a plain message. | `socialOAuth.ts` `linkedInVersion`; tests | Complies |
| LI-14 | Posts API body and little-text format: reserved characters escaped, hashtags as templates | S3, S5 | Every reserved character is escaped, links included. Hashtags are sent as `{hashtag\|\#\|tag}`. The author is `urn:li:person:{sub}`. | `socialOAuth.ts` `linkedInCommentary`; tests | Complies |
| LI-15 | Commentary length and rate limits: 150 requests per member per day, 100,000 per app per day | S2, S3 | Length is checked after escaping (3,000), with a plain message. A 429 is reported, not retried. The Worker allows 10 sends per minute per user. | `socialOAuth.ts` `linkedInMaxCommentary`; `wrangler.jsonc` `MAIL_SEND_RATE_LIMITER` | Complies |
| LI-16 | Brand assets come from LinkedIn's official downloads | S8, S9 | The "in" glyph comes from the Ionicons font: the same shape, not LinkedIn's downloaded file | `src/ui/NetworkMark.tsx` | Partial (see G-01) |
| LI-17 | Scopes are only what is needed, and self-serve | S6, S10 | `openid profile w_member_social`. Email isn't requested. | `socialOAuth.ts` `authorizeURL` | Complies |

## Gaps and remediation

| ID | Gap | Fix | Owner | Due | Done |
|---|---|---|---|---|---|
| G-01 | The LinkedIn mark comes from an icon font, not LinkedIn's downloaded asset (LI-16) | Download the "in" logo from brand.linkedin.com and use it as provided, in black or white | Owner (needs the download from LinkedIn's brand site) | 2026-12-31 | |
| G-02 | Revocation on LinkedIn itself can only be done by the member in LinkedIn settings (LI-11) | Nothing more is possible for a self-serve app. Check the menu path once against LinkedIn Help. | Owner | 2026-12-31 | |
| G-03 | The composer's collapsed summary says "Open Media + N" without naming LinkedIn (LI-03) | Name the networks in the summary | Engineering | Next composer change | |
| G-04 | Sharing to LinkedIn isn't removed when the Open Media post is deleted | Call `DELETE /rest/posts/{urn}` when the person deletes the original, after asking them | Engineering | Nice to have | |
| G-05 | No reminder before the 60-day token runs out | Show the expiry in Settings and prompt a week before | Engineering | Nice to have | |

## Answers to common questions

**What LinkedIn data does Open Media access?** Only the member's name and member ID, through OpenID Connect, plus permission to post as them (`w_member_social`). It never reads their feed, connections, messages or profile details. (LI-06, LI-17)

**Does Open Media store LinkedIn data or tokens on its servers?** No. The token, name and member ID stay on the person's device: in the Keychain or Keystore on phones, and encrypted in the browser on the web. The server passes each share through to LinkedIn and keeps nothing. (LI-06, LI-08)

**Does Open Media ever post without the member?** No. A post goes to LinkedIn only when the member taps Post with LinkedIn selected. Agents, APIs and schedules can't post to LinkedIn. (LI-01, LI-03)

**How does a member disconnect or delete their data?** Disconnect in Settings → Cross-posting. Signing out or deleting the account also removes it. To withdraw access on LinkedIn too: Settings → Data privacy → Permitted services. (LI-07, LI-11)

**Can someone else on a shared device post as me?** No. A connection belongs to the Open Media account that made it, and it is cleared on sign-out. (LI-04)

**How are the app's secrets handled?** The client secret is a Cloudflare Worker secret. Its source of truth is Infisical, and it is never in the code, the app or logs. (LI-08)

**Which API version and limits?** `LinkedIn-Version: 202611`, which can be changed without a build. Posts are up to 3,000 characters after LinkedIn's formatting. LinkedIn's daily limits are respected, and Open Media never retries automatically. (LI-13, LI-15)

## Sources

| ID | Source | Read |
|---|---|---|
| S1 | LinkedIn API Terms of Use, https://www.linkedin.com/legal/l/api-terms-of-use | 2026-11-25 |
| S2 | Share on LinkedIn (rate limits), https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin | 2026-11-25 |
| S3 | Posts API, https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api | 2026-11-25 |
| S4 | API versioning, https://learn.microsoft.com/en-us/linkedin/marketing/versioning | 2026-11-25 |
| S5 | Little text format, https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format | 2026-11-25 |
| S6 | Authorization code flow, https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow | 2026-11-25 |
| S7 | Secure applications, https://learn.microsoft.com/en-us/linkedin/shared/api-guide/best-practices/secure-applications | 2026-11-25 |
| S8 | Brand policies, https://brand.linkedin.com/policies | 2026-11-25 |
| S9 | The "in" logo, https://brand.linkedin.com/in-logo | 2026-11-25 |
| S10 | Getting access (open permissions), https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access | 2026-11-25 |
| S11 | Sign In with LinkedIn using OpenID Connect, https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2 | 2026-11-25 |

## Change log

| Date | Change |
|---|---|
| 2026-11-24 | API version 202510, retired on 2026-10-15, replaced with 202611. Hashtags and escaping fixed (open-media #20). |
| 2026-11-25 | LinkedIn turned on. First review: fixed LI-04, LI-05, LI-07, LI-08 and LI-09. Added length-after-escaping check. Report created. |
