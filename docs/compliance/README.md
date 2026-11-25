# Connection compliance reports

Open Media connects to other networks and services. For each one, this folder has a report: what that network requires of apps like Open Media, how Open Media meets each requirement, the evidence, and any gaps. Use these reports to answer platform reviews, partners, users and auditors. Every answer cites a requirement ID.

## How the reports are made

Each report follows [TEMPLATE.md](TEMPLATE.md). The core of each report is a **requirements matrix** that traces every rule to its source, the way Open Media meets it, and the evidence. This is the same structure as a statement of applicability or a control matrix in a security audit.

- **Sources** are the network's own published terms, developer policies, API docs and brand rules. Third-party blogs aren't used. Every source carries the date it was read.
- **Evidence** is a `file:line` reference, a test, or a setting that can be checked. It is never a claim with nothing behind it.
- **Status** is one of Complies, Partial, Gap, Not applicable, or Unclear. Unclear means the source doesn't say.
- **Gaps** get an owner, a fix and a due date, and stay listed until they are fixed.
- **Reviews** happen at least every 6 months. A connection is also reviewed whenever its network changes its terms, API version or scopes, or when Open Media changes what it does with that connection. Reviewing means updating *Last reviewed* and adding a line to the change log.

## Index

| Connection | Kind | Report | Status | Last reviewed |
|---|---|---|---|---|
| LinkedIn | Posting (official OAuth API) | [linkedin.md](linkedin.md) | Live since 2026-11-25 | 2026-11-25 |
| X | Posting (official OAuth API) | Not yet written | Built, off (no app) | |
| Threads | Posting (official OAuth API) | Not yet written | Built, off (no app) | |
| Instagram | Posting (official OAuth API) | Not yet written | Built, off (no app) | |
| Facebook Pages | Posting (official OAuth API) | Not yet written | Built, off (no app) | |
| Bluesky | Open network (AT Protocol): read and post | Not yet written | Built | |
| Mastodon | Open network (ActivityPub): read and post | Not yet written | Built | |
| Nostr | Open network: read and post | Not yet written | Built | |
| Farcaster, Lens, Hive, DeSo | Open networks: read and post | Not yet written | Live | |
| Email (Gmail, Outlook, iCloud, IMAP) | Mail sync and send | Not yet written | Live | |
| Messaging bridges (WhatsApp, Signal, Telegram and others) | Chat bridges (ADR 0011) | Not yet written | Opt-in | |
| Manifest | Connected app (ADR 0041) | Not yet written | Live | |
| ONDC | Seller app (ADR 0015) | Not yet written | Phase 1 | |

Write a connection's report before turning it on for real accounts, and add it to this index.
