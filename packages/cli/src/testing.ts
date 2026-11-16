/** Test helpers: a fake Open Media MCP server and a console/fetch capture. Not shipped (only cli.ts is bundled). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, RunInput } from './cli';
import { Tool } from './schema';

export interface FakeCall { url: string; method: string; auth?: string; rpc?: { method: string; params?: { name?: string; arguments?: Record<string, unknown> } }; body?: unknown }

/**
 * Answers MCP JSON-RPC like Open Media's servers: /open/mcp lists `publicTools`, /me/mcp and
 * /account/mcp list both (and need a bearer token). Tool calls echo their arguments. Anything
 * else goes to `rest`.
 */
export function fakeOpenMedia(options: { publicTools: Tool[]; accountTools?: Tool[]; sse?: boolean; rest?: (url: URL, init: RequestInit) => Response | Promise<Response>; onCall?: (name: string, args: Record<string, unknown>) => unknown }) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: URL | string | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? safeJson(init.body) : undefined;
    const call: FakeCall = { url: url.pathname + url.search, method: init.method ?? 'GET', auth: headers.get('authorization') ?? undefined, body };
    calls.push(call);
    if (['/open/mcp', '/me/mcp', '/account/mcp'].includes(url.pathname)) {
      const rpc = body as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      call.rpc = { method: rpc.method, params: rpc.params };
      const account = url.pathname !== '/open/mcp';
      if (account && !call.auth) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const tools = account ? [...options.publicTools, ...(options.accountTools ?? [])] : options.publicTools;
      let result: unknown;
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'open-media', version: '9.9.9' }, capabilities: {} };
      else if (rpc.method === 'tools/list') result = { tools };
      else if (rpc.method === 'tools/call') {
        const tool = tools.find((item) => item.name === rpc.params?.name);
        if (!tool) return reply(rpc.id, undefined, { code: -32602, message: `Tool ${rpc.params?.name} not found` });
        const value = options.onCall?.(tool.name, rpc.params?.arguments ?? {}) ?? { called: tool.name, arguments: rpc.params?.arguments ?? {} };
        result = value && typeof value === 'object' && 'isError' in value ? value : { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else return reply(rpc.id, undefined, { code: -32601, message: 'Method not found' });
      return reply(rpc.id, result);
    }
    if (options.rest) return options.rest(url, init);
    return Response.json({ error: { code: 'not_found', message: 'Not here.' } }, { status: 404 });
  }) as typeof fetch;
  function reply(id: number, result?: unknown, error?: { code: number; message: string }) {
    const message = JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });
    return options.sse
      ? new Response(`event: message\ndata: ${message}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : new Response(message, { headers: { 'content-type': 'application/json' } });
  }
  return { fetch: fetchImpl, calls };
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }

export function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), 'open-media-cli-'));
  return { OPEN_MEDIA_CONFIG_DIR: join(root, 'config'), OPEN_MEDIA_CACHE_DIR: join(root, 'cache') };
}

/** Runs the CLI with console output captured and fetch replaced. */
export async function capture(argv: string[], env: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch, input: RunInput = {}) {
  const out: string[] = []; const err: string[] = [];
  const log = console.log; const error = console.error; const realFetch = globalThis.fetch;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.join(' ')); };
  // No real network in unit tests: an unexpected request fails loudly.
  globalThis.fetch = fetchImpl ?? ((async (url: unknown) => { throw new Error(`Unexpected network request in a test: ${String(url)}`); }) as typeof fetch);
  try { return { code: await run(argv, { ...tempDirsOnce(), ...env }, { interactive: false, ...input }), out: out.join('\n'), err: err.join('\n') }; }
  finally { console.log = log; console.error = error; globalThis.fetch = realFetch; }
}

let shared: ReturnType<typeof tempDirs> | undefined;
/** One private config/cache per test process, so nothing touches the real ~/.config or ~/.cache. */
function tempDirsOnce() { return (shared ??= tempDirs()); }

export const sampleTools: Tool[] = [
  { name: 'get_feed', title: 'Read the feed', description: 'The mixed feed.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'string', enum: ['lens', 'farcaster', 'hive'] } }, kind: { type: 'string', enum: ['feed', 'clips'], description: 'clips = short videos only' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string' } } } },
  { name: 'search', title: 'Search', description: 'Search posts.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_post', title: 'One post', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'translate_text', title: 'Translate public text', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { texts: { type: 'array', items: { type: 'string', maxLength: 5000 } }, target: { type: 'string' } }, required: ['texts', 'target'] } },
];

export const sampleAccountTools: Tool[] = [
  { name: 'get_me', title: 'Your profile', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'publish_post', title: 'Publish a post', description: 'Publish a public post.', annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] } },
  { name: 'delete_post', title: 'Delete a post', annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'set_read_receipts', title: 'Read receipts', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } },
  { name: 'set_up_profile', title: 'Set up your profile', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: { displayName: { type: 'string' }, handle: { type: 'string' } }, required: ['displayName', 'handle'] } },
  { name: 'save_feed_lens', title: 'Save a lens', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: { lens: { type: 'object', additionalProperties: {} }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['lens'] } },
];
