# src

The CLI source, bundled into `dist/cli.js` by `npm run build` (the SDK comes from `../../sdk/src`).

- `cli.ts`: the entry point, built-in commands and the dispatch of every other word to a tool.
- `auth.ts`: browser login (OAuth 2.1 + PKCE, loopback redirect, dynamic client registration), the email-code session, refresh, logout and `credentials.json`.
- `mcp.ts`: the MCP client and the cached tool catalog.
- `schema.ts`: a tool's JSON input schema to flags, arguments, help and the confirm-first rule.
- `args.ts`, `output.ts`, `completion.ts`: argv parsing, readable output, shell completion.
- `testing.ts`: a fake Open Media server for the tests (not bundled). `local.integration.test.ts` runs only with `OPEN_MEDIA_LOCAL_STACK=1`.
