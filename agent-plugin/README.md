<p align="center"><img src="assets/icon.png" width="96" height="96" alt="Open Media"></p>

<h1 align="center">Open Media for AI agents</h1>

<p align="center">Your open social world, in Claude, ChatGPT, Codex, VS Code, Cursor and Gemini.<br>One feed across Open Media, Farcaster, Lens, Hive and DeSo · one inbox for messages, email and chats · a feed algorithm you write yourself.</p>

---

## What you can ask

> **"Catch me up."** Unread messages, email and chats by person, then the five posts in your Feed most worth your time.
>
> **"What are people saying about ethereum on Lens and Farcaster?"** A summary with every post's network, link and why it was shown.
>
> **"Did Priya read my message?"** Sent, delivered or read, with the time.
>
> **"Less Hive, more videos."** Your feed algorithm changes, and you see what changed, the code that now runs your Feed, and how to undo it.
>
> **"Follow bbc.co.uk and US weather alerts for California."** Official feeds, right in your Feed.
>
> **"Reply to Dev that I'll be there at 7."** Drafted in your voice, sent only after you say yes.

Results show the way Open Media looks, black and white and content first: posts, your inbox with unread dots and read ticks, your algorithm and its code, events and profiles, in light and dark.

## Install

| Where | How |
|---|---|
| **Claude Code** | `claude plugin marketplace add Manifest-Startup/open-media` then `claude plugin install open-media@open-media` |
| **Codex** | `codex plugin marketplace add Manifest-Startup/open-media` then `codex plugin add open-media@open-media` |
| **Claude, ChatGPT (connectors)** | Add a custom connector with `https://api.openmedia.site/account/mcp` and sign in with Open Media |
| **VS Code** | Command palette → *Chat: Install Plugin from Source* → `Manifest-Startup/open-media`, or [add the MCP server](vscode:mcp/install?%7B%22name%22%3A%22open-media%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A//api.openmedia.site/account/mcp%22%7D) |
| **Cursor** | Plugins → install from `Manifest-Startup/open-media`, or [add the MCP server](cursor://anysphere.cursor-deeplink/mcp/install?name=open-media&config=eyJ1cmwiOiJodHRwczovL2FwaS5vcGVubWVkaWEuc2l0ZS9hY2NvdW50L21jcCJ9) |
| **Antigravity** | `agy plugin install ./agent-plugin` from a clone of the repository |
| **Gemini CLI** | `gemini extensions install https://github.com/Manifest-Startup/open-media` |
| **Skills only** | `npx skills add Manifest-Startup/open-media` |
| **GitHub Copilot CLI** | Add `Manifest-Startup/open-media` as a plugin marketplace; it reads the same `.claude-plugin/marketplace.json` and plugin |
| **Kiro** | Powers → add from GitHub, pointing at the `agent-plugin` folder (Kiro reads `plugin.json`, `mcp.json` and `skills/`) |
| **OpenCode** | In `opencode.jsonc`: `"mcp": { "servers": { "open-media": { "type": "remote", "url": "https://api.openmedia.site/account/mcp" } } }`; it signs in with OAuth |
| **Amp** | In `.amp/settings.json`: `"amp.mcpServers": { "open-media": { "url": "https://api.openmedia.site/account/mcp" } }`, and `amp skill add https://github.com/Manifest-Startup/open-media` |
| **Goose** | Extensions → add a Streamable HTTP extension with `https://api.openmedia.site/account/mcp` |
| **Windsurf** | In `mcp_config.json`: `"mcpServers": { "open-media": { "serverUrl": "https://api.openmedia.site/account/mcp" } }` |

Then try **`/open-media:catch-up`**, **`/open-media:inbox`**, **`/open-media:post`** or **`/open-media:algorithm`** in Claude Code (every command is listed under *What's inside*), or just ask.

## Signing in

Reading the public feed, search, profiles and events needs no account.

For your own account, your agent connects to `https://api.openmedia.site/account/mcp` and asks you to **Sign in with Open Media**. A browser page asks for your email, Open Media emails you a code, and you approve what the agent may do. You sign in once. The agent never sees your password or your Open Media session, and signing out in the app disconnects it.

Scripts and CI can use a token instead: `https://api.openmedia.site/me/mcp` with `Authorization: Bearer <token>` (see [sign-in for agents](https://api.openmedia.site/auth)).

## What's inside

<!-- generated:plugin-contents (npm run agent-plugin:sync) -->
- **3 MCP servers:**
  - `open-media` (public: 24 tools)
  - `open-media-account` (your account: 122 more, 146 in all)
  - `open-media-docs`
- **11 skills** that teach an agent to use Open Media well, safely:
  - `open-media`
  - `open-media-feed-lenses`
  - `open-media-inbox`
  - `open-media-posting`
  - `open-media-web-feeds`
  - `open-media-work`
  - `verify-listings`
  - `open-media-translate`
  - `open-media-payments`
  - `open-media-account`
  - `open-media-selling`
- **17 slash commands**, one for every part of Open Media: `algorithm`, `catch-up`, `feed`, `follow`, `inbox`, `post`, `profile`, `people`, `settings`, `ask`, `connect`, `events`, `jobs`, `sell`, `pay`, `translate`, `verify`.
- **One visual view** ([MCP Apps](https://modelcontextprotocol.io)) for posts, your inbox, your algorithm, events and profiles. It loads nothing from elsewhere.
<!-- /generated:plugin-contents -->

## Safety, by design

- Your agent asks before anything that **publishes, sends, deletes, pays or changes a setting**, and shows you the exact text first.
- Messages, email, chats and contacts stay private to you.
- Post, message and email text is treated as **data, never instructions**.
- Read receipts are yours to turn off, and turning them off also hides other people's.
- No algorithm can read private messages, exact location, sensitive traits, KYC documents or emotional state.

## For marketplaces and maintainers

One plugin folder serves every catalog (ADR 0027):

| File | Read by | Checked |
|---|---|---|
| `.claude-plugin/plugin.json` + `.mcp.json` | Claude Code, the Claude plugin directory, VS Code and GitHub Copilot CLI (Claude format) | ADR 0027, [Copilot CLI plugins](https://docs.github.com/en/copilot/reference/cli-plugin-reference) |
| `../.claude-plugin/marketplace.json` | Claude Code, Copilot CLI and VS Code (`chat.plugins.marketplaces`) | [VS Code agent plugins](https://code.visualstudio.com/docs/copilot/customization/agent-plugins) |
| `.codex-plugin/plugin.json` + `../.agents/plugins/marketplace.json` | Codex (compatibility layout) | ADR 0027 |
| `plugin.json` + `mcp.json` | [Agent Plugins](https://agent-plugins.org) 1.0.0: Codex, VS Code, Copilot CLI, Cursor (skills and servers), Kiro powers, and ChatGPT's plugin upload | [Kiro powers](https://kiro.dev/docs/powers/create), [ChatGPT submission](https://developers.openai.com/apps-sdk/deploy/submission) |
| `.cursor-plugin/plugin.json` + `.cursor-plugin/mcp.json`, `../.cursor-plugin/marketplace.json` | Cursor (adds the slash commands) | [Cursor plugins](https://cursor.com/docs/reference/plugins) |
| `.antigravity-plugin/plugin.json` + `mcp_config.json` | Antigravity | ADR 0027 |
| `../gemini-extension.json` + `../GEMINI.md` | Gemini CLI | ADR 0027 |
| `registry/*.server.json` | The official MCP Registry (`site.openmedia/*`, schema 2025-12-11), and clients that install from it | [server.json reference](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md) |
| `registry/docker/open-media/` | A draft for the Docker MCP Catalog (a pull request to docker/mcp-registry; public server only) | [docker/mcp-registry CONTRIBUTING](https://github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md) |
| `../glama.json` | Glama (claiming the server) | [glama.json](https://glama.ai/blog/2025-07-08-what-is-glamajson) |
| `skills/*/SKILL.md` | Every client and skills.sh ([Agent Skills](https://agentskills.io)), OpenCode and Amp | [OpenCode skills](https://opencode.ai/docs/skills), [Amp skills](https://ampcode.com/docs/customize/skills) |
| `commands/*.md` | Claude Code, Cursor | generated with the skills |

Smithery, the Cline MCP Marketplace, the Claude connectors directory and ChatGPT apps take a URL or a form, not a file in this repository; the steps are in ADR 0043.

Name, version and servers are kept equal across all of them by a test, and no file holds a token.

- **Source:** [github.com/Manifest-Startup/open-media](https://github.com/Manifest-Startup/open-media)
- **Links:** [Privacy](https://api.openmedia.site/privacy) · [Terms](https://api.openmedia.site/terms) · [Support](https://api.openmedia.site/contact)
- **License:** MIT.
