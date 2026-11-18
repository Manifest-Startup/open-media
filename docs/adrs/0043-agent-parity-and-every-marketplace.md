# ADR 0043: Agent parity with the app, and the plugin in every marketplace

- Status: **accepted; built and tested locally, not deployed** (2026-11-17). Builds on [ADR 0027](0027-one-agent-plugin-for-every-marketplace.md) (one plugin folder, many marketplaces), [ADR 0012](0012-agent-interfaces-and-design-system.md) (agent interfaces for everything) and [ADR 0041](0041-app-integrations.md) (apps signed in with Open Media).

## Context

The owner asked that "everything is a plugin": whatever a person can do in the Open Media app, an agent can do through the plugin, and the plugin installs from every real agent marketplace. The plugin, skills, commands and MCP tools should come from single sources of truth and be checked against them, never copied by hand.

An audit on 2026-11-17 compared every screen action, data function and REST route with the 116 tools then registered. Server-backed gaps:
- editing the name and bio;
- message replies, emoji reactions, marking a conversation unread, and paging through one conversation;
- searching people;
- likes, reshares and comments on web-feed items;
- feed interests;
- marking email and bridged chats read or unread, and cancelling a chat-network sign-in;
- finding contacts on Open Media;
- choosing the AI model, removing a key, clearing the AI chat;
- refreshing payout status;
- someone's public resume.

The slash commands were six hand-written files. The README counts were stale (114 tools against 116). Every link still named `mihirkavi/open-media`, which GitHub only redirects to `Manifest-Startup/open-media`.

## Decision

### 1. Close the gaps with tools that call what the app calls

- 21 new tools, 20 on the account server and `get_resume` on the public server:
  `edit_profile`, `get_conversation_messages`, `react_to_message`, `mark_conversation_unread`, `find_people`, `get_feed_interests`, `set_feed_interests`, `like_web_item`, `reshare_web_item`, `comment_on_web_item`, `get_web_item_comments`, `mark_email_read`, `mark_bridged_chat_read`, `cancel_chat_network_sign_in`, `find_contacts_on_open_media`, `get_ai_settings`, `choose_ai_model`, `remove_ai_key`, `clear_ai_chat`, `refresh_payout_setup`, `get_resume`.
- `send_message` now takes `replyTo` and `clientId`.
- Each tool runs the same RPC or route as the app, as the person. Database rules, blocks and rate limits apply unchanged, and nothing returns more than the app shows: AI keys show only their last four characters, and people search keeps blocks and the names people chose to show.
- Writes are never marked read-only. `remove_*`, `delete_*` and now `clear_*` are marked destructive. Every write that others see, that is public, or that cannot be undone tells the agent to confirm first, so the CLI asks too.

### 2. A parity guard

- `src/domain/agentParity.ts` lists the app's capabilities. Each names its sources: every REST operation in `/v1/openapi.json`, and every exported function in `src/data`, the mail, AI and bridge connectors and `src/auth/accountSecurity.ts`. It then names the MCP tools that do the same, or a typed reason why none should exist.
- `services/mail-sync/src/agentParity.test.ts` fails when:
  - a REST operation or data function is missing from the map;
  - a named tool is not registered, or a source no longer exists;
  - a gap has no reason;
  - tools cover fewer than 80% of the non-plumbing capabilities.
- Gaps kept on purpose:
  - **secret:** passwords, passkeys, the authenticator app, recovery codes, and saving an AI key. An agent that could change them could take over the account.
  - **apps-only:** listing or disconnecting connected apps. An app may not manage other apps, and the REST route refuses them too.
  - **device-keys:** cross-posting, and likes and replies on Farcaster, Lens, Hive and DeSo, are signed with keys on the device. Linking a wallet needs the wallet's own signature.
  - **upload:** profile pictures, post videos and email attachments are files. Scripts can use `POST /v1/me/media/videos`.
  - **device:** appearance, translation preferences, recent emoji and GIFs, dictation, and contact files.
  - **internal:** sign-out, realtime tokens, webhooks and helpers.

### 3. Commands and counts are generated

- Slash commands are data (`agentCommands` in `src/domain/agentSkills.ts`). `npm run agent-plugin:sync` writes `agent-plugin/commands/` and removes stale files.
- A test requires every command to name a real skill and every skill to have a command. There are 17 commands, one for each area: catch-up, inbox, feed, post, algorithm, follow, profile, people, settings, ask, connect, events, jobs, sell, pay, translate and verify.
- New skills: `open-media-account` (profile, privacy, people, AI model, data) and `open-media-selling` (listings, paid posts, tips, payouts, ONDC). There are 11 skills in all.
- The tool, skill and command counts in `README.md` and `agent-plugin/README.md` sit between generated markers. They come from the tools the Worker registers (`services/mail-sync/scripts/registered-tools.ts`), and `agentPluginContents.test.ts` fails on drift.

### 4. Marketplaces

All formats were verified against official documentation on 2026-11-17. A file was added only where a current, documented, repository-committed format exists. Every file is in the consistency test in `src/domain/agentSkills.test.ts`, which checks one name and version (2.1.0), the same three server URLs, and no credentials.

| Target | What it reads | Added here | Source |
|---|---|---|---|
| Cursor | Agent Plugins `plugin.json` for skills and MCP; `.cursor-plugin/plugin.json` for commands; `.cursor-plugin/marketplace.json` | `agent-plugin/.cursor-plugin/plugin.json` + `mcp.json` (url only), `.cursor-plugin/marketplace.json` | <https://cursor.com/docs/reference/plugins>, <https://cursor.com/docs/plugins> |
| GitHub Copilot CLI | Agent Plugins `plugin.json`, or `.claude-plugin/plugin.json`; `marketplace.json` in `.claude-plugin/` | nothing new (already served) | <https://docs.github.com/en/copilot/reference/cli-plugin-reference> |
| VS Code agent plugins | Agent Plugins, Copilot or Claude format; marketplaces through `chat.plugins.marketplaces` | nothing new | <https://code.visualstudio.com/docs/copilot/customization/agent-plugins> (updated 2026-11-11) |
| Kiro powers | Agent Plugins `plugin.json` (needs version, description, author.name, keywords) + `mcp.json` + `skills/` | nothing new; the test checks Kiro's required fields | <https://kiro.dev/docs/powers/create>, <https://kiro.dev/docs/powers> (updated 2026-11-12) |
| OpenCode | `opencode.jsonc` `mcp.servers` (`type: remote`, OAuth by default); skills from `.agents/skills` and others | install snippet in the README | <https://opencode.ai/docs/mcp-servers>, <https://opencode.ai/docs/skills> |
| Amp | `amp.mcpServers` in settings; `amp skill add` | install snippet | <https://ampcode.com/docs/customize/mcp>, <https://ampcode.com/docs/customize/skills> |
| Goose | user config or a `goose://extension` deeplink; no repository manifest | install note | <https://goose-docs.ai/docs/getting-started/using-extensions> |
| Windsurf | `mcp_config.json` `serverUrl`; how the plugin store is curated is not documented | install snippet | <https://docs.devin.ai/windsurf/plugins/cascade/mcp> |
| Official MCP Registry | `server.json`, schema 2025-12-11 (still the latest released) | unchanged apart from the version | <https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json> |
| Docker MCP Catalog | `servers/<name>/server.yaml` + `tools.json` + `readme.md`, through a pull request to docker/mcp-registry | a draft at `agent-plugin/registry/docker/open-media/`, public server only | <https://github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md> |
| Glama | `glama.json` at the repository root (maintainers) | `glama.json` | <https://glama.ai/blog/2025-07-08-what-is-glamajson> |
| Smithery | a URL (web form or `smithery mcp publish`); no file for a hosted server | nothing | smithery.ai/docs/build/publish (only search excerpts could be read; the page returned 404 when fetched) |
| Cline MCP Marketplace | a GitHub issue with a 400×400 logo; `llms-install.md` is optional | nothing | <https://github.com/cline/mcp-marketplace> |
| ChatGPT apps | a plugin ZIP (Agent Plugins or Codex layout), uploaded in the portal; one server; no headers; OAuth | nothing new (`plugin.json` + `mcp.json` already fit) | <https://developers.openai.com/apps-sdk/deploy/submission> |
| Claude connectors directory | the portal at claude.ai/directory/manage; every tool needs a title and a read-only or destructive hint | nothing (every tool already has both) | <https://claude.com/docs/connectors/building/submission> |

### 5. The repository's real name

Every manifest, registry entry, package and link now names `Manifest-Startup/open-media`. On 2026-11-17, `gh api repos/mihirkavi/open-media` answered `Manifest-Startup/open-media` and `git ls-remote` on the old URL worked. Both work only through GitHub's redirect, which breaks if anyone creates a repository under the old name.

## Consequences

- An agent can do 58 of the app’s 72 non-plumbing capabilities. Each of the other 14 has a written reason, and a new feature cannot land without one or the other.
- The plugin is now 2.1.0, with 24 public tools plus 113 account tools: 137 in all.
- **Not verified:**
  - the new tools against production (they need a deploy);
  - how Cursor handles OAuth for plugin MCP servers (its docs say nothing);
  - how Kiro handles POWER.md frontmatter;
  - how to get listed in the Goose and Windsurf stores;
  - whether Cline accepts hosted servers;
  - Smithery's server-card fields;
  - Docker's OAuth provider for Dynamic Client Registration, which is why only the public server is in its draft.
- **Owner steps** (none were done here):
  - deploy the Worker;
  - publish `registry/*.server.json` with `mcp-publisher` after the `openmedia.site` proof;
  - submit to the Cursor marketplace (cursor.com/marketplace/publish);
  - open the docker/mcp-registry pull request from the draft;
  - claim the server on Glama, whose `glama.json` names `mihirkavi`;
  - submit `https://api.openmedia.site/account/mcp` to Smithery;
  - open the Cline issue with `agent-plugin/assets/cline-400.png` (400×400);
  - re-submit the ChatGPT plugin ZIP and the Claude connector;
  - review `/terms`, as ADR 0027 asks.
