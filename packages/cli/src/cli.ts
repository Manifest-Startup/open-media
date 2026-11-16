#!/usr/bin/env node
/**
 * open-media: the Open Media command line, for people and agents.
 *
 * Every tool on Open Media's MCP servers is a command, read live from `tools/list` (cached for a
 * few minutes), with flags generated from its input schema; a handful of friendly commands (feed,
 * search, post …) sit on top. `login` signs in through the browser (OAuth 2.1 + PKCE, loopback
 * redirect) or, with an email, by a code from the inbox. `api` reaches any REST route.
 *
 * Human-readable by default; --json prints JSON for scripts and agents. Publishing, sending,
 * paying and deleting ask first (or need --yes). Exit codes: 0 done, 1 the API refused or failed,
 * 2 the command was wrong.
 */
import { createInterface } from 'node:readline/promises';

import { defaultBaseUrl, Network, OpenMedia, OpenMediaError, Post } from '../../sdk/src/index';
import { FlagSpec, globalFlags, parseArgs, Parsed, UsageError } from './args';
import { Access, browserLogin, cacheDir, currentAccess, Env, saveCredential, sessionCredential, signOut } from './auth';
import { bashCompletion, CompletionCommand, toolCompletion, zshCompletion } from './completion';
import { Catalog, CatalogSource, defaultTtlMs, loadCatalog, McpClient, McpError, ToolResult } from './mcp';
import { outline, printPosts, printReadable } from './output';
import { buildArguments, flagsFor, kebab, needsConfirmation, readValue, Tool, toolHelp } from './schema';

export const version = '0.3.0';
const networks: Network[] = ['open-media', 'farcaster', 'lens', 'hive', 'deso', 'bluesky', 'mastodon', 'nostr'];

interface Builtin { usage: string; summary: string; flags: FlagSpec[]; section: 'read' | 'account' | 'auth' | 'tools' | 'setup' }

/** The hand-written commands. A tool whose kebab name matches one of these is reached with `open-media tool <name>`. */
export const builtins: Record<string, Builtin> = {
  feed: { section: 'read', usage: 'feed [--sources farcaster,lens] [--mode raw|relevant] [--clips]', summary: 'The mixed feed', flags: [{ name: 'sources', value: true }, { name: 'mode', value: true }, { name: 'clips', value: false }] },
  search: { section: 'read', usage: 'search <words…>', summary: 'Search every network', flags: [] },
  events: { section: 'read', usage: 'events [--query <words>] [--days <1-14>]', summary: 'Bay Area events', flags: [{ name: 'query', value: true }, { name: 'days', value: true }] },
  profile: { section: 'read', usage: 'profile <handle>', summary: 'An Open Media profile', flags: [] },
  timeline: { section: 'read', usage: 'timeline <network> <handle>', summary: 'One person’s posts', flags: [] },
  login: { section: 'auth', usage: 'login [<email> [--code <code>]] [--no-browser] [--no-open]', summary: 'Sign in: in the browser, or with an emailed code', flags: [{ name: 'code', value: true }, { name: 'browser', value: false }, { name: 'open', value: false }] },
  logout: { section: 'auth', usage: 'logout', summary: 'Sign out and revoke this CLI’s access', flags: [] },
  whoami: { section: 'auth', usage: 'whoami', summary: 'Who you’re signed in as, and how', flags: [] },
  token: { section: 'auth', usage: 'token', summary: 'Print your access token', flags: [] },
  'set-up-profile': { section: 'account', usage: 'set-up-profile --name <name> --handle <handle>', summary: 'Name a new account', flags: [{ name: 'name', value: true }, { name: 'handle', value: true }] },
  me: { section: 'account', usage: 'me', summary: 'Your profile', flags: [] },
  post: { section: 'account', usage: 'post <text…> --yes', summary: 'Publish a public post', flags: [] },
  payments: { section: 'account', usage: 'payments', summary: 'Your payments', flags: [] },
  tools: { section: 'tools', usage: 'tools [--search <words>]', summary: 'Every tool you can run as a command', flags: [{ name: 'search', value: true }] },
  tool: { section: 'tools', usage: 'tool <name> [options]', summary: 'Run a tool by its MCP name', flags: [] },
  api: { section: 'tools', usage: 'api <METHOD> <path> [--data <json|@file|->] [--query k=v]…', summary: 'Call any REST route, signed in', flags: [{ name: 'data', value: true }, { name: 'query', value: true, repeat: true }] },
  completion: { section: 'setup', usage: 'completion zsh|bash', summary: 'Shell completion for every command', flags: [] },
  'mcp-config': { section: 'setup', usage: 'mcp-config [claude|codex]', summary: 'MCP config for your agent', flags: [] },
  help: { section: 'setup', usage: 'help [command]', summary: 'Help for a command', flags: [] },
};

/** How a tool is reached on the command line: its kebab name, unless a built-in already uses it. */
export function commandFor(toolName: string): string[] {
  const name = kebab(toolName);
  return name in builtins ? ['tool', toolName] : [name];
}

function mainHelp(): string {
  const section = (key: Builtin['section']) => Object.values(builtins).filter((item) => item.section === key).map((item) => `  ${item.usage.padEnd(66)}${item.summary}`).join('\n');
  return `open-media ${version}: Open Media from the command line

Usage: open-media <command> [options]

Read (no account needed)
${section('read')}

Sign in
${section('auth')}

Your account
${section('account')}

Every tool is a command
  Each Open Media MCP tool is a command with flags from its schema, e.g.
    open-media get-feed --sources lens --kind clips
    open-media publish-post "Hello" --yes
    open-media get-post --help
${section('tools')}

Set up
${section('setup')}

Options
  --json             Print JSON (for scripts and agents)
  --base-url <url>   API origin (default ${defaultBaseUrl}, or OPEN_MEDIA_BASE_URL)
  --yes, -y          Don’t ask before publishing, sending, paying or deleting
  --refresh-tools    Read the tool list from the server now instead of the cache
  -h, --help         Show help (open-media <command> --help for one command)
  -v, --version      Show the version

Exit codes: 0 done, 1 the API refused or failed, 2 the command was wrong.`;
}

function mcpConfig(target: string | undefined, baseUrl: string) {
  if (target === 'codex') {
    return `# ~/.codex/config.toml\n[mcp_servers.open-media]\nurl = "${baseUrl}/open/mcp"\n\n[mcp_servers.open-media-account]\nurl = "${baseUrl}/me/mcp"\nbearer_token_env_var = "OPEN_MEDIA_TOKEN"\n\n# Or install the plugin: codex plugin marketplace add Manifest-Startup/open-media`;
  }
  return JSON.stringify({
    mcpServers: {
      'open-media': { type: 'http', url: `${baseUrl}/open/mcp` },
      'open-media-account': { type: 'http', url: `${baseUrl}/me/mcp`, headers: { Authorization: 'Bearer ${OPEN_MEDIA_TOKEN}' } },
    },
  }, null, 2) + '\n\n// Or install the plugin: /plugin install open-media --marketplace Manifest-Startup/open-media';
}

async function askLine(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await prompt.question(question)).trim(); } finally { prompt.close(); }
}

export interface RunInput {
  /** Whether a person is at the keyboard (defaults to stdin being a terminal). */
  interactive?: boolean;
  /** Reads the emailed code. */
  ask?: () => Promise<string>;
  /** Asks yes/no before a publishing, sending, paying or deleting tool. */
  confirm?: (question: string) => Promise<boolean>;
  /** Opens the sign-in page; tests follow the redirect here. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Reads `-` values. */
  stdin?: () => string;
  /** Clock for the tool cache. */
  now?: () => number;
}

/** Finds the command word: the first argument that isn't an option (or --base-url's value). */
function splitCommand(argv: string[]): { command?: string; rest: string[] } {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') break;
    if (arg === '--base-url') { index += 1; continue; }
    if (arg.startsWith('-')) continue;
    return { command: arg, rest: [...argv.slice(0, index), ...argv.slice(index + 1)] };
  }
  return { rest: argv };
}

interface Context {
  env: Env;
  input: RunInput;
  baseUrl: string;
  json: boolean;
  yes: boolean;
  refreshTools: boolean;
  access?: Access;
}

function accountEndpoint(ctx: Context, access: Access): string {
  return `${ctx.baseUrl}${access.kind === 'oauth' ? '/account/mcp' : '/me/mcp'}`;
}

async function catalogFor(ctx: Context, refresh = ctx.refreshTools): Promise<Catalog> {
  const sources: CatalogSource[] = [{ server: 'open', endpoint: `${ctx.baseUrl}/open/mcp` }];
  if (ctx.access) sources.push({ server: 'account', endpoint: accountEndpoint(ctx, ctx.access), token: ctx.access.token });
  const ttl = Number(ctx.env.OPEN_MEDIA_TOOLS_TTL);
  const options = { baseUrl: ctx.baseUrl, cacheDir: cacheDir(ctx.env), cliVersion: version, ttlMs: Number.isFinite(ttl) && ttl >= 0 && ctx.env.OPEN_MEDIA_TOOLS_TTL ? ttl * 1000 : defaultTtlMs, refresh, now: ctx.input.now, userAgent: `open-media-cli/${version}` };
  try { return await loadCatalog({ ...options, sources }); }
  catch (error) {
    if (!ctx.access || !(error instanceof OpenMediaError) || error.status !== 401) throw error;
    // The saved token was refused: renew it once, else carry on with the public tools.
    const renewed = ctx.access.kind === 'env' ? undefined : await currentAccess(ctx.env, ctx.baseUrl, { force: true });
    if (renewed) { ctx.access = renewed; sources[1] = { ...sources[1], endpoint: accountEndpoint(ctx, renewed), token: renewed.token }; return loadCatalog({ ...options, sources }); }
    console.error('Your sign-in has expired; showing public tools only. Run open-media login.');
    ctx.access = undefined;
    return loadCatalog({ ...options, sources: sources.slice(0, 1) });
  }
}

function findTool(catalog: Catalog, word: string): Tool | undefined {
  return catalog.tools.find((tool) => tool.name === word || kebab(tool.name) === word);
}

/** Parses a tool's payload: structured content first, then JSON text, then plain text. */
function payloadOf(result: ToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const texts = (result.content ?? []).filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text!);
  if (texts.length === 1) { try { return JSON.parse(texts[0]); } catch { return texts[0]; } }
  return texts.length ? texts.join('\n') : result;
}

async function confirmOrRefuse(ctx: Context, tool: Tool, args: Record<string, unknown>) {
  if (ctx.yes || !needsConfirmation(tool)) return;
  const summary = `${tool.title ?? tool.name} as you:\n\n${outline(args, '  ').join('\n')}\n`;
  const interactive = ctx.input.interactive ?? Boolean(process.stdin.isTTY);
  if (!interactive) throw new UsageError(`This runs ${summary}\nRun again with --yes to go ahead.`);
  const confirm = ctx.input.confirm ?? (async (question: string) => /^y(es)?$/i.test(await askLine(question)));
  if (!(await confirm(`This runs ${summary}\nGo ahead? [y/N] `))) throw new UsageError('Cancelled; nothing was changed.');
}

async function runTool(ctx: Context, tool: Tool, command: string, argv: string[], help: boolean): Promise<number> {
  if (help) { console.log(toolHelp(tool, command)); return 0; }
  const args = buildArguments(tool, argv, { stdin: ctx.input.stdin });
  if (tool.server === 'account' && !ctx.access) throw new UsageError(`${command} acts on your account. Sign in first: open-media login (or set OPEN_MEDIA_TOKEN).`);
  await confirmOrRefuse(ctx, tool, args);
  const call = (access: Access | undefined) => new McpClient({ endpoint: access ? accountEndpoint(ctx, access) : `${ctx.baseUrl}/open/mcp`, token: access?.token, userAgent: `open-media-cli/${version}` }).callTool(tool.name, args);
  let result: ToolResult;
  try { result = await call(ctx.access); }
  catch (error) {
    if (!(error instanceof OpenMediaError && error.status === 401 && ctx.access && ctx.access.kind !== 'env')) throw error;
    const renewed = await currentAccess(ctx.env, ctx.baseUrl, { force: true });
    if (!renewed) throw new UsageError('Your sign-in has expired. Run open-media login.');
    ctx.access = renewed;
    result = await call(renewed);
  }
  const payload = payloadOf(result);
  if (result.isError) {
    const problem = payload as { error?: string; message?: string } | string;
    if (ctx.json) console.error(JSON.stringify({ error: typeof problem === 'object' ? problem : { message: problem } }));
    else console.error(`Open Media refused (${typeof problem === 'object' ? problem.error ?? 'error' : 'error'}): ${typeof problem === 'object' ? problem.message ?? JSON.stringify(problem) : problem}`);
    return 1;
  }
  if (ctx.json) console.log(JSON.stringify(payload, null, 2));
  else printReadable(payload);
  return 0;
}

async function listTools(ctx: Context, search: string | undefined): Promise<number> {
  const catalog = await catalogFor(ctx);
  const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const tools = catalog.tools.filter((tool) => words.every((word) => `${tool.name} ${kebab(tool.name)} ${tool.title ?? ''} ${tool.description ?? ''}`.toLowerCase().includes(word)));
  const rows = tools.map((tool) => ({ name: tool.name, command: `open-media ${commandFor(tool.name).join(' ')}`, title: tool.title ?? '', server: tool.server, readOnly: Boolean(tool.annotations?.readOnlyHint), asksFirst: needsConfirmation(tool) }));
  if (ctx.json) { console.log(JSON.stringify({ tools: rows, signedIn: catalog.signedIn, serverVersion: catalog.serverVersion ?? null }, null, 2)); return 0; }
  if (!rows.length) { console.log(search ? `No tools match “${search}”.` : 'No tools.'); return 0; }
  const width = Math.min(40, Math.max(...rows.map((row) => commandFor(row.name).join(' ').length)) + 2);
  for (const row of rows) {
    const marks = [row.server === 'account' ? 'account' : '', row.asksFirst ? 'asks first' : ''].filter(Boolean);
    console.log(`  ${commandFor(row.name).join(' ').padEnd(width)}${row.title}${marks.length ? `  [${marks.join(', ')}]` : ''}`);
  }
  console.log(`\n${rows.length} of ${catalog.tools.length} tools.${catalog.signedIn ? '' : ' Sign in (open-media login) to see your account’s tools too.'} Help for one: open-media <command> --help`);
  return 0;
}

async function completion(ctx: Context, shell: string | undefined): Promise<number> {
  if (shell !== 'zsh' && shell !== 'bash') throw new UsageError('completion zsh|bash, e.g. source <(open-media completion zsh)');
  const commands: CompletionCommand[] = Object.entries(builtins).map(([name, item]) => ({ name, summary: item.summary, flags: item.flags.map((flag) => ({ flag: `--${flag.name}`, takesValue: flag.value })) }));
  try {
    const catalog = await catalogFor(ctx);
    for (const tool of catalog.tools) {
      const [first] = commandFor(tool.name);
      if (first !== 'tool') commands.push(toolCompletion(first, tool));
    }
  } catch { console.error('Couldn’t reach Open Media; completing the built-in commands only.'); }
  console.log(ctx.json ? JSON.stringify(commands, null, 2) : shell === 'zsh' ? zshCompletion(commands) : bashCompletion(commands));
  return 0;
}

async function api(ctx: Context, parsed: Parsed): Promise<number> {
  const [methodWord, path] = parsed.positional;
  const method = methodWord?.toUpperCase();
  if (!method || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) || !path?.startsWith('/')) throw new UsageError('api <METHOD> <path>, e.g. open-media api GET /v1/me or open-media api POST /v1/me/posts --data \'{"text":"Hi"}\'');
  let body: unknown;
  if (typeof parsed.flags.data === 'string') {
    const raw = readValue(parsed.flags.data, ctx.input.stdin);
    try { body = JSON.parse(raw); } catch { throw new UsageError('--data must be JSON (or @file, or - for stdin).'); }
  }
  const query: Record<string, string> = {};
  for (const pair of (parsed.flags.query as string[] | undefined) ?? []) {
    const equals = pair.indexOf('=');
    if (equals < 1) throw new UsageError('--query takes key=value');
    query[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  // Raw writes that publish, send, pay or delete get the same pause as the tools.
  const bare = path.split('?')[0];
  if (method === 'DELETE' || (method === 'POST' && /\/(posts|messages|payments|comments|reshares|send|email)(\/|$)/.test(bare))) {
    await confirmOrRefuse(ctx, { name: 'api', title: `${method} ${bare}`, annotations: { destructiveHint: true } }, (body && typeof body === 'object' ? body : {}) as Record<string, unknown>);
  }
  // An OAuth grant reaches the account through /v1/connected/me; elsewhere it's not a session, so send it only there.
  const accountPath = /^\/v1\/(connected\/)?me(\/|$|\?)/.test(path);
  const token = ctx.access && (ctx.access.kind !== 'oauth' || accountPath) ? ctx.access.token : undefined;
  const client = new OpenMedia({ baseUrl: ctx.baseUrl, token, connected: ctx.access?.kind === 'oauth', userAgent: `open-media-cli/${version}` });
  const result = await client.api(method, path, { query, body });
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  return 0;
}

export async function run(argv: string[], env: Env = process.env, input: RunInput = {}): Promise<number> {
  const { command, rest } = splitCommand(argv);
  // Global options can't be read before we know the command: a tool may have its own --version.
  const early = parseArgs(rest, [...globalFlags, { name: 'version', value: false, short: 'v' }], { allowUnknown: true });
  const json = early.flags.json === true;
  try {
    if (!command) {
      if (early.flags.version) { console.log(version); return 0; }
      console.log(mainHelp());
      return early.flags.help ? 0 : 2;
    }
    const baseUrl = String((typeof early.flags['base-url'] === 'string' && early.flags['base-url']) || env.OPEN_MEDIA_BASE_URL || defaultBaseUrl).replace(/\/+$/, '');
    const ctx: Context = { env, input, baseUrl, json, yes: early.flags.yes === true, refreshTools: early.flags['refresh-tools'] === true };
    // `tool <name> …` reaches any tool by its MCP name, including ones a built-in shadows.
    if (command === 'tool') {
      const inner = splitCommand(rest);
      if (!inner.command) {
        if (early.flags.help) { console.log(`open-media ${builtins.tool.usage}\n\n${builtins.tool.summary}.`); return 0; }
        throw new UsageError('tool <name> [options], e.g. open-media tool search lens. List them with open-media tools.');
      }
      return await dispatchTool(ctx, inner.command, inner.rest, `tool ${inner.command}`);
    }
    const builtin = builtins[command];
    if (builtin) {
      const parsed = parseArgs(rest, [...globalFlags, ...builtin.flags]);
      if (parsed.flags.help) { console.log(`open-media ${builtin.usage}\n\n${builtin.summary}.`); return 0; }
      return await runBuiltin(ctx, command, parsed);
    }
    // Any other word is a tool.
    return await dispatchTool(ctx, command, rest, command);
  } catch (error) {
    return report(error, json);
  }
}

async function dispatchTool(ctx: Context, word: string, rest: string[], display: string): Promise<number> {
  ctx.access = await currentAccess(ctx.env, ctx.baseUrl);
  let catalog = await catalogFor(ctx);
  let tool = findTool(catalog, word);
  // Not in the cached list: read it once more, so tools added on the server work straight away.
  if (!tool && catalog.fromCache) { catalog = await catalogFor(ctx, true); tool = findTool(catalog, word); }
  if (!tool) throw new UsageError(`Unknown command “${word}”. Run open-media tools to list everything${ctx.access ? '' : ' (sign in to see your account’s tools)'}, or open-media --help.`);
  // The tool's own flags win over global ones of the same name.
  const own = new Set(flagsFor(tool.inputSchema).map((flag) => flag.flag));
  const parsed = parseArgs(rest, globalFlags.filter((flag) => !own.has(flag.name)), { allowUnknown: true });
  ctx.json = parsed.flags.json === true;
  ctx.yes = parsed.flags.yes === true;
  return runTool(ctx, tool, display, parsed.positional, parsed.flags.help === true);
}

function report(error: unknown, json: boolean): number {
  if (error instanceof UsageError) { console.error(error.message); return 2; }
  if (error instanceof McpError) {
    // Invalid params and unknown tools are the command's fault; anything else is the server's.
    const usage = error.code === -32602 || error.code === -32601;
    if (json) console.error(JSON.stringify({ error: { code: error.code, message: error.message } }));
    else console.error(usage ? `${error.message}` : `Open Media’s MCP server failed (${error.code}): ${error.message}`);
    return usage ? 2 : 1;
  }
  if (error instanceof OpenMediaError) {
    if (json) console.error(JSON.stringify({ error: { status: error.status, code: error.code, message: error.message } }));
    else console.error(`Open Media refused (${error.status} ${error.code}): ${error.message}`);
    return 1;
  }
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
}

async function runBuiltin(ctx: Context, command: string, parsed: Parsed): Promise<number> {
  const { flags, positional: rest } = parsed;
  const needsAccount = ['me', 'post', 'payments', 'set-up-profile', 'token', 'whoami', 'api', 'tools', 'completion'].includes(command);
  if (needsAccount) ctx.access = await currentAccess(ctx.env, ctx.baseUrl);
  const token = ctx.access?.token ?? (command === 'logout' ? undefined : ctx.env.OPEN_MEDIA_TOKEN);
  const client = new OpenMedia({ baseUrl: ctx.baseUrl, token, connected: ctx.access?.kind === 'oauth', userAgent: `open-media-cli/${version}` });
  const out = (value: unknown, human: () => void) => { if (ctx.json) console.log(JSON.stringify(value, null, 2)); else human(); };
  const needToken = () => { if (!token) throw new UsageError('Sign in first: open-media login (or open-media login you@example.com, or set OPEN_MEDIA_TOKEN).'); };

  switch (command) {
    case 'feed': {
      const sources = flags.sources ? String(flags.sources).split(',').map((item) => item.trim()) as Network[] : undefined;
      if (sources?.some((item) => !networks.includes(item))) throw new UsageError(`--sources takes: ${networks.join(', ')}`);
      if (flags.mode && flags.mode !== 'raw' && flags.mode !== 'relevant') throw new UsageError('--mode is raw or relevant');
      const page = await client.feed({ sources, mode: flags.mode as 'raw' | 'relevant' | undefined, kind: flags.clips ? 'clips' : 'feed' });
      out(page, () => { printPosts(page.data); if (page.unavailable.length) console.log(`Not loading right now: ${page.unavailable.join(', ')}`); });
      return 0;
    }
    case 'search': {
      if (!rest.length) throw new UsageError('search needs some words, e.g. open-media search ethereum on lens');
      const result = await client.search(rest.join(' ')) as { posts?: Post[]; data?: Post[] };
      out(result, () => printPosts(result.posts ?? result.data ?? []));
      return 0;
    }
    case 'events': {
      const days = flags.days ? Number(flags.days) : undefined;
      if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= 14)) throw new UsageError('--days is a whole number from 1 to 14');
      const result = await client.events({ query: flags.query ? String(flags.query) : undefined, days }) as { area: string; data: { title: string; startsAt: string; place?: string; registrationUrl?: string }[] };
      out(result, () => {
        console.log(`Upcoming in ${result.area}:\n`);
        for (const event of result.data) console.log(`${event.startsAt}  ${event.title}${event.place ? ` · ${event.place}` : ''}\n  ${event.registrationUrl ?? ''}\n`);
      });
      return 0;
    }
    case 'profile': {
      if (!rest[0]) throw new UsageError('profile needs a handle');
      const result = await client.profile(rest[0]);
      out(result, () => printReadable(result));
      return 0;
    }
    case 'timeline': {
      if (!networks.includes(rest[0] as Network) || !rest[1]) throw new UsageError(`timeline <network> <handle>; network is one of ${networks.join(', ')}`);
      const result = await client.timeline(rest[0] as Network, rest[1]) as { posts?: Post[]; data?: Post[] };
      out(result, () => printPosts(result.posts ?? result.data ?? []));
      return 0;
    }
    case 'me': {
      needToken();
      const result = await client.me();
      out(result, () => printReadable(result));
      return 0;
    }
    case 'whoami': {
      if (!ctx.access) { out({ signedIn: false }, () => console.log('Not signed in. Run open-media login.')); return 0; }
      const how = { oauth: 'browser sign-in (OAuth, “Open Media CLI”)', session: 'emailed code', env: 'OPEN_MEDIA_TOKEN' }[ctx.access.kind];
      const profile = await client.me().catch((error) => (error instanceof OpenMediaError && error.code === 'no_profile' ? null : Promise.reject(error))) as { handle?: string } | null;
      out({ signedIn: true, via: ctx.access.kind, baseUrl: ctx.baseUrl, profile }, () => console.log(`${profile?.handle ? `@${profile.handle}` : 'Signed in (no profile yet)'} on ${ctx.baseUrl}, via ${how}.`));
      return 0;
    }
    case 'post': {
      needToken();
      const text = rest.join(' ').trim();
      if (!text) throw new UsageError('post needs the text to publish');
      if (!ctx.yes) throw new UsageError(`This publishes a public post as you:\n\n  ${text}\n\nRun again with --yes to publish.`);
      const result = await client.publish(text);
      out(result, () => console.log(`Published: ${(result as { url?: string }).url ?? 'done'}`));
      return 0;
    }
    case 'payments': {
      needToken();
      const result = await client.payments();
      out(result, () => printReadable(result));
      return 0;
    }
    case 'login': return login(ctx, client, rest, flags);
    case 'token': {
      needToken();
      console.log(token);
      return 0;
    }
    case 'logout': {
      const env = { ...ctx.env, OPEN_MEDIA_TOKEN: undefined };
      const result = await signOut(env, ctx.baseUrl);
      out({ signedOut: true, revoked: result.revoked }, () => console.log(!result.kind ? 'You weren’t signed in.' : result.kind === 'oauth' ? (result.revoked ? 'Signed out; the Open Media CLI’s access was revoked.' : 'Signed out here. Open Media didn’t confirm the revocation; remove “Open Media CLI” in Profile → Sign-in and security → Connected apps.') : 'Signed out.'));
      if (ctx.env.OPEN_MEDIA_TOKEN) console.error('OPEN_MEDIA_TOKEN is still set in your environment.');
      return 0;
    }
    case 'set-up-profile': {
      needToken();
      if (typeof flags.name !== 'string' || typeof flags.handle !== 'string') throw new UsageError('set-up-profile --name "Your name" --handle yourhandle');
      const profile = await client.setUpProfile(flags.name, flags.handle);
      out(profile, () => console.log(`Profile ready: @${(profile as { handle: string }).handle}`));
      return 0;
    }
    case 'tools': return listTools(ctx, typeof flags.search === 'string' ? flags.search : rest.join(' ') || undefined);
    case 'api': return api(ctx, parsed);
    case 'completion': return completion(ctx, rest[0]);
    case 'mcp-config': {
      console.log(mcpConfig(rest[0], ctx.baseUrl));
      return 0;
    }
    case 'help': {
      const target = rest[0];
      if (!target) { console.log(mainHelp()); return 0; }
      if (builtins[target]) { console.log(`open-media ${builtins[target].usage}\n\n${builtins[target].summary}.`); return 0; }
      return run([target, '--help'], ctx.env, ctx.input);
    }
    default:
      throw new UsageError(`Unknown command “${command}”. Run open-media --help.`);
  }
}

async function login(ctx: Context, client: OpenMedia, rest: string[], flags: Parsed['flags']): Promise<number> {
  const email = rest[0];
  const env = ctx.env;
  if (!email) {
    if (flags.browser === false) throw new UsageError('Without a browser, sign in with an emailed code: open-media login you@example.com');
    const credential = await browserLogin({
      baseUrl: ctx.baseUrl,
      env,
      openBrowser: flags.open === false ? () => undefined : ctx.input.openBrowser,
      log: (line) => console.error(line),
    });
    const signedIn = new OpenMedia({ baseUrl: ctx.baseUrl, token: credential.access_token, connected: true, userAgent: `open-media-cli/${version}` });
    const profile = await signedIn.me().catch(() => undefined) as { handle?: string } | undefined;
    out(ctx, { signedIn: true, via: 'oauth', profile: profile ?? null }, () => console.log(profile?.handle ? `Signed in as @${profile.handle}.` : 'Signed in.'));
    return 0;
  }
  if (!email.includes('@')) throw new UsageError('login needs your email, e.g. open-media login you@example.com (or just open-media login to use the browser)');
  let code = typeof flags.code === 'string' ? flags.code : '';
  if (!code) {
    await client.requestSignInCode(email);
    const interactive = ctx.input.interactive ?? Boolean(process.stdin.isTTY);
    if (!interactive) {
      out(ctx, { sent: true, email, next: `open-media login ${email} --code <code>` }, () => console.log(`Open Media emailed a sign-in code to ${email}.\nRun: open-media login ${email} --code <code>`));
      return 0;
    }
    console.log(`Open Media emailed a sign-in code to ${email}.`);
    code = await (ctx.input.ask ?? (() => askLine('Code from the email: ')))();
  }
  const session = await client.signInWithCode(email, code);
  saveCredential(env, ctx.baseUrl, sessionCredential(session));
  const profile = await client.me().catch((error) => (error instanceof OpenMediaError && error.code === 'no_profile' ? undefined : Promise.reject(error)));
  out(ctx, { signedIn: true, via: 'session', user: session.user, profile: profile ?? null }, () => console.log(profile
    ? `Signed in as @${(profile as { handle: string }).handle}.`
    : `Signed in. This is a new account: open-media set-up-profile --name "Your name" --handle yourhandle`));
  return 0;
}

function out(ctx: Context, value: unknown, human: () => void) {
  if (ctx.json) console.log(JSON.stringify(value, null, 2)); else human();
}

if (process.argv[1] && /open-media|cli\.(js|ts)$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
