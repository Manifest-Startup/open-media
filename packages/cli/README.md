# open-media-cli

Open Media from the command line, for people and AI agents. Every tool on Open Media's MCP servers is a command, so the CLI can do everything the platform can: read the feed and search every network, publish, message, manage your profile, feeds, lenses, mail, payments and more.

```bash
npx open-media-cli login                       # sign in in the browser
npx open-media-cli tools                       # everything you can run
npx open-media-cli get-feed --sources farcaster,lens --kind clips
npx open-media-cli publish-post "Hello from the terminal" --yes
```

Install globally to get the `open-media` command: `npm install -g open-media-cli`. Node 18 or newer.

## Signing in

- `open-media login` opens your browser to Open Media's sign-in page (passkeys, email code, second step). The CLI uses OAuth 2.1 with PKCE and a loopback redirect on a random `127.0.0.1` port. It registers itself once per server as the public client "Open Media CLI", so it shows in Profile → Sign-in and security → Connected apps. `--no-open` prints the link instead of opening it.
- `open-media login you@example.com` is the fallback for machines without a browser and for agents: Open Media emails a code, which you type in or pass with `--code`.
- Tokens are stored in `~/.config/open-media/credentials.json` (mode 0600, folder 0700; `OPEN_MEDIA_CONFIG_DIR` or `XDG_CONFIG_HOME` move it) and refresh themselves. The macOS Keychain isn't used: without a native module, the only way in is the `security` command, which would put the token on a process command line.
- `open-media logout` revokes the CLI's access and forgets the tokens. `open-media whoami` shows who you are and how you signed in.
- `OPEN_MEDIA_TOKEN` (an access token from the email-code sign-in) overrides the saved sign-in.

## Every tool is a command

The CLI reads the tool list from the server (`tools/list` on `/open/mcp`, plus `/account/mcp` when you're signed in) and caches it for 10 minutes in `~/.cache/open-media/` (`OPEN_MEDIA_TOOLS_TTL` seconds changes that; `--refresh-tools` reads it now). New tools work without updating the CLI.

- A tool's command is its name in kebab-case: `get_feed` is `open-media get-feed`. Two tools share a name with a built-in command (`search`, `set_up_profile`); reach those with `open-media tool search …`.
- `open-media <command> --help` shows the tool's description and every flag.
- Flags come from the tool's input schema: `--text "Hi"`, `--limit 5`, `--remote` / `--no-remote`, enums are checked, lists repeat the flag or take commas (`--sources lens,hive`), and objects take JSON, `@file` or `-` for stdin.
- `--input <json|@file|->` passes all the arguments as one JSON object; flags given with it override it.
- Required fields can be given in order without their flag: `open-media get-post <id>`, `open-media publish-post Hello there`.
- `open-media tools [--search words]` lists every tool, marking those that need an account and those that ask first.

Publishing, sending, paying and deleting ask before running, or need `--yes` when there's no terminal.

## Built-in commands

```
feed [--sources farcaster,lens] [--mode raw|relevant] [--clips]
search <words…>
events [--query <words>] [--days <1-14>]
profile <handle>
timeline <network> <handle>
me · payments · post <text…> --yes · set-up-profile --name <name> --handle <handle>
token · whoami · logout
api <METHOD> <path> [--data <json|@file|->] [--query key=value]…
completion zsh|bash
mcp-config [claude|codex]
```

`open-media api GET /v1/me/follows` calls any REST route with your sign-in (see `/v1/openapi.json`).

## Shell completion

```bash
source <(open-media completion zsh)    # in ~/.zshrc, after compinit
source <(open-media completion bash)   # in ~/.bashrc
```

The script is generated from the tool list, so re-run it after an update to pick up new tools.

## For scripts and agents

- `--json` prints JSON.
- `--base-url <url>` or `OPEN_MEDIA_BASE_URL` picks the server (default `https://api.openmedia.site`; the local stack is `http://127.0.0.1:8787`).
- Exit codes: 0 done, 1 the API refused or failed, 2 the command was wrong.

## Developing

`npm test` runs the unit tests. With the local stack running (`npm run local` at the repository root), `npm run test:local` signs in with an emailed code and runs reads and writes on a made-up account. `services/mail-sync/src/cliCoverage.test.ts` checks that every MCP tool is reachable as a command.

Docs: https://api.openmedia.site/developers · Source: https://github.com/Manifest-Startup/open-media · MIT licence.
