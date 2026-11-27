# ADR 0046: Relicense to AGPL-3.0 core, Apache-2.0 agent packages and CC BY 4.0 docs

- Status: **accepted** (2026-11-26). Decided by the owner and copyright holder, Mihir Kavishwar.

## Context

Open Media was published under the MIT License. MIT let anyone take the whole app and server, rename it, close the source and host it as a competing service, with no credit beyond a licence file nobody sees. That cuts against the project's mission (an open communication layer no company can lock people into), including against closed, rebranded clones of Open Media itself.

At the same time, Open Media wants agents and other apps to use it as widely as possible. Agent marketplaces, MCP registries and package managers favour OSI-approved licences, and companies embed SDKs and plugins only when the licence is permissive. Researchers and writers should be able to cite and reuse the documentation freely.

The owner ships the app through the Apple App Store and Google Play, whose terms are widely held to conflict with GPL-family licences for third parties' code. The copyright holder can distribute their own code there, but only if they also have the rights to every contribution.

## Decision

- **Core app and server** (everything not listed below) is `AGPL-3.0-only`. The root `LICENSE` is the unmodified GNU AGPL v3 text, so GitHub and package tools detect it.
- **Additional terms under AGPL section 7** in `NOTICE`: 7(b) keep the plain-text line "Based on Open Media (https://github.com/Manifest-Startup/open-media) by Mihir Kavishwar." in the About or credits screen and documentation of any version that is conveyed or run over a network; 7(e) no trademark rights except as in `TRADEMARKS.md`.
- **Embeddable and agent-facing parts** are `Apache-2.0`, each with its own `LICENSE` and `NOTICE`: `agent-plugin/`, `skills/`, `packages/sdk`, `packages/cli`, `packages/python`, and the root agent manifests `gemini-extension.json`, `GEMINI.md` and `glama.json`. The MCP servers and WebMCP tools run inside the Worker and are not packaged separately, so their code stays AGPL; their public interfaces can be used by anyone, and that use does not create a covered work. The Expo config plugin (`plugins/`) and native module (`modules/`) are app internals and stay AGPL.
- **Prose documentation and research papers** are `CC-BY-4.0` (`docs/LICENSE.md`). Code in the docs follows the code's licence.
- **Contributions** carry a DCO sign-off and the grant in `CLA.md`: each contribution is licensed under its directory's licence, and the maintainer also gets a perpetual, irrevocable right to relicense it, which keeps app-store distribution possible.
- **Trademarks**: `TRADEMARKS.md`. Forks and hosted versions use their own name and logo; nominative use and federation with Open Media are welcome.
- **Citation**: `CITATION.cff`.
- **Past releases stay MIT.** Everything published before this change remains available under MIT; the change applies from this commit on.

## Alternatives considered

- **Stay MIT.** Maximum reach, but no protection against closed, rebranded hosted clones and no attribution where people see it.
- **Functional Source License (FSL) or other source-available licences.** Rejected: they are not OSI-approved, so agent marketplaces, registries and many companies treat the project as not open source, and the two-year delay adds confusion. The goal is to keep forks open, not to stop competition.
- **GPL-3.0.** Does not cover software offered as a network service, which is how Open Media is mostly used.
- **AGPL for everything.** Would stop companies and agent platforms from embedding the SDKs, skills and plugin, which is the opposite of what the agent interfaces are for.

Mastodon is the precedent: an AGPL-3.0 server and app with permissively licensed client libraries, a trademark policy that requires forks to rename, and a thriving ecosystem of third-party apps that talk to it over its API.

## Consequences

- Anyone may still use, change, sell and host Open Media. A modified version given to people or run as a service must publish its source under AGPL, keep the attribution line and use its own name.
- Apps and agents that only call the API, MCP servers or WebMCP, or that embed the Apache-2.0 packages, are unaffected.
- `package.json`, `pyproject.toml`, the plugin manifests, the agent site (`services/mail-sync/src/agentSite.ts`), `about_open_media` and the in-app Mission page state the new licences.
- The only other contributor so far is Dependabot (dependency-version bumps), so no third-party copyright needs to be relicensed.
- Owner follow-ups: legal review of the `NOTICE` and `CLA.md` wording, trademark registration, the licence text in store listings, and a Zenodo integration if a DOI is wanted.
