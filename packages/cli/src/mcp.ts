/**
 * A minimal MCP client for Open Media's stateless Streamable HTTP servers (/open/mcp,
 * /account/mcp, /me/mcp), and the tool catalog the CLI builds its commands from.
 *
 * The catalog is read from the servers with `tools/list` and cached in ~/.cache/open-media/ for a
 * short time (10 minutes; OPEN_MEDIA_TOOLS_TTL seconds), keyed by API origin and server, and
 * stamped with the server's version and this CLI's version. A command the cache doesn't know
 * triggers one fresh read before it is called unknown, so new tools appear without a release.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { OpenMediaError } from '../../sdk/src/index';
import { Tool } from './schema';

export const protocolVersion = '2025-06-18';

/** A JSON-RPC error from the server (bad arguments, unknown tool …). */
export class McpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = 'McpError'; }
}

export interface McpClientOptions { endpoint: string; token?: string; fetch?: typeof fetch; userAgent?: string }

export interface ToolResult { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }

export class McpClient {
  private id = 0;
  constructor(private readonly options: McpClientOptions) {}

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
      'user-agent': this.options.userAgent ?? 'open-media-cli',
    };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const response = await fetchImpl(this.options.endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    const text = await response.text();
    if (!response.ok) {
      const problem = safeJson(text) as { error?: string | { code?: string; message?: string }; error_description?: string } | undefined;
      const error = problem?.error;
      const code = typeof error === 'object' && error?.code ? error.code : typeof error === 'string' ? error : `http_${response.status}`;
      const message = typeof error === 'object' && error?.message ? error.message : problem?.error_description ?? `The MCP server answered ${response.status}.`;
      throw new OpenMediaError(response.status, code, message);
    }
    const message = parseMessage(text, id);
    if (message.error) throw new McpError(message.error.code, message.error.message, message.error.data);
    return message.result as T;
  }

  async listTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request<{ tools: Tool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {});
      tools.push(...result.tools);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async serverVersion(): Promise<string | undefined> {
    const result = await this.request<{ serverInfo?: { version?: string } }>('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'open-media-cli', version: '0' } });
    return result.serverInfo?.version;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.request<ToolResult>('tools/call', { name, arguments: args });
  }
}

/** The server answers either as JSON or as server-sent events; find our response either way. */
export function parseMessage(text: string, id: number): { result?: unknown; error?: { code: number; message: string; data?: unknown } } {
  const trimmed = text.trim();
  const candidates = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? [trimmed]
    : trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  for (const candidate of candidates) {
    const parsed = safeJson(candidate);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages as { id?: number; result?: unknown; error?: { code: number; message: string } }[]) {
      if (message && typeof message === 'object' && (message.id === id || message.id === undefined) && ('result' in message || 'error' in message)) return message;
    }
  }
  throw new McpError(-32700, 'The MCP server sent a response the CLI couldn’t read.');
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }

// ─── The catalog ─────────────────────────────────────────────────────────────

export interface CatalogSource { server: 'open' | 'account'; endpoint: string; token?: string }

interface CacheFile { cli: string; baseUrl: string; endpoint: string; serverVersion?: string; fetchedAt: number; tools: Tool[] }

export interface Catalog { tools: Tool[]; fromCache: boolean; fetchedAt: number; serverVersion?: string; signedIn: boolean }

export interface CatalogOptions {
  baseUrl: string;
  cacheDir: string;
  cliVersion: string;
  /** The public server, always; the account server when signed in. */
  sources: CatalogSource[];
  ttlMs?: number;
  refresh?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  userAgent?: string;
}

export const defaultTtlMs = 10 * 60 * 1000;

function cachePath(dir: string, baseUrl: string, endpoint: string): string {
  return join(dir, `tools-${createHash('sha256').update(`${baseUrl}\n${endpoint}`).digest('hex').slice(0, 16)}.json`);
}

function readCache(file: string, options: CatalogOptions, now: number): CacheFile | undefined {
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8')) as CacheFile;
    if (cached.cli !== options.cliVersion || cached.baseUrl !== options.baseUrl || !Array.isArray(cached.tools)) return undefined;
    if (now - cached.fetchedAt > (options.ttlMs ?? defaultTtlMs) || cached.fetchedAt > now + 60_000) return undefined;
    return cached;
  } catch { return undefined; }
}

function writeCache(file: string, value: CacheFile) {
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  } catch { /* a read-only cache only costs a network call next time */ }
}

async function loadSource(source: CatalogSource, options: CatalogOptions, now: number): Promise<CacheFile & { fromCache: boolean }> {
  const file = cachePath(options.cacheDir, options.baseUrl, source.endpoint);
  if (!options.refresh) {
    const cached = readCache(file, options, now);
    if (cached) return { ...cached, fromCache: true };
  }
  const client = new McpClient({ endpoint: source.endpoint, token: source.token, fetch: options.fetch, userAgent: options.userAgent });
  const serverVersion = await client.serverVersion().catch(() => undefined);
  const tools = await client.listTools();
  const fresh: CacheFile = { cli: options.cliVersion, baseUrl: options.baseUrl, endpoint: source.endpoint, serverVersion, fetchedAt: now, tools };
  writeCache(file, fresh);
  return { ...fresh, fromCache: false };
}

/**
 * Every tool this person can call: the public server's, plus the account server's when signed in.
 * A tool only the account server lists is marked `server: 'account'`.
 */
export async function loadCatalog(options: CatalogOptions): Promise<Catalog> {
  const now = (options.now ?? Date.now)();
  const loaded = await Promise.all(options.sources.map((source) => loadSource(source, options, now)));
  const open = options.sources.findIndex((source) => source.server === 'open');
  const publicNames = new Set(open === -1 ? [] : loaded[open].tools.map((tool) => tool.name));
  const byName = new Map<string, Tool>();
  options.sources.forEach((source, index) => {
    for (const tool of loaded[index].tools) {
      if (byName.has(tool.name)) continue;
      byName.set(tool.name, { ...tool, server: source.server === 'account' && !publicNames.has(tool.name) ? 'account' : 'open' });
    }
  });
  return {
    tools: [...byName.values()],
    fromCache: loaded.every((item) => item.fromCache),
    fetchedAt: Math.min(...loaded.map((item) => item.fetchedAt)),
    serverVersion: loaded[0]?.serverVersion,
    signedIn: options.sources.some((source) => source.server === 'account'),
  };
}
