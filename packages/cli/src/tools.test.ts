import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

import { commandFor } from './cli';
import { loadCatalog, McpClient, parseMessage } from './mcp';
import { capture, fakeOpenMedia, sampleAccountTools, sampleTools, tempDirs } from './testing';

const base = { OPEN_MEDIA_BASE_URL: 'https://api.test' };

test('every tool is a kebab-case command with flags from its schema', async () => {
  const server = fakeOpenMedia({ publicTools: sampleTools });
  const result = await capture(['get-feed', '--sources', 'lens,hive', '--kind', 'clips', '--limit', '5', '--json'], { ...base, ...tempDirs() }, server.fetch);
  assert.equal(result.code, 0, result.err);
  const call = server.calls.find((item) => item.rpc?.method === 'tools/call')!;
  assert.equal(call.url, '/open/mcp');
  assert.deepEqual(call.rpc!.params, { name: 'get_feed', arguments: { sources: ['lens', 'hive'], kind: 'clips', limit: 5 } });
  assert.equal(call.auth, undefined, 'public tools need no token');
  assert.deepEqual(JSON.parse(result.out).called, 'get_feed');
});

test('servers that answer with server-sent events work too', async () => {
  const server = fakeOpenMedia({ publicTools: sampleTools, sse: true });
  const result = await capture(['get-post', 'p1'], { ...base, ...tempDirs() }, server.fetch);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /called: get_post/);
  assert.deepEqual(parseMessage('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n', 3), { jsonrpc: '2.0', id: 3, result: { ok: true } });
});

test('a tool a built-in shadows is reachable with `tool <name>`', async () => {
  assert.deepEqual(commandFor('search'), ['tool', 'search']);
  assert.deepEqual(commandFor('get_feed'), ['get-feed']);
  const server = fakeOpenMedia({ publicTools: sampleTools });
  const result = await capture(['tool', 'search', 'lens', 'posts'], { ...base, ...tempDirs() }, server.fetch);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(server.calls.find((item) => item.rpc?.method === 'tools/call')!.rpc!.params, { name: 'search', arguments: { query: 'lens posts' } });
});

test('per-tool --help comes from the server’s schema, without calling the tool', async () => {
  const server = fakeOpenMedia({ publicTools: sampleTools });
  const result = await capture(['get-feed', '--help'], { ...base, ...tempDirs() }, server.fetch);
  assert.equal(result.code, 0);
  assert.match(result.out, /The mixed feed\./);
  assert.match(result.out, /--sources <lens\|farcaster\|hive>…/);
  assert.ok(!server.calls.some((item) => item.rpc?.method === 'tools/call'));
});

test('account tools need a sign-in, and go to /me/mcp with the token', async () => {
  const server = fakeOpenMedia({ publicTools: sampleTools, accountTools: sampleAccountTools });
  const dirs = tempDirs();
  const signedOut = await capture(['get-me'], { ...base, ...dirs }, server.fetch);
  assert.equal(signedOut.code, 2);
  assert.match(signedOut.err, /Unknown command “get-me”.*sign in/);
  const signedIn = await capture(['get-me'], { ...base, ...dirs, OPEN_MEDIA_TOKEN: 'person-token' }, server.fetch);
  assert.equal(signedIn.code, 0, signedIn.err);
  const call = server.calls.find((item) => item.rpc?.method === 'tools/call')!;
  assert.equal(call.url, '/me/mcp');
  assert.equal(call.auth, 'Bearer person-token');
});

test('tools lists everything, marks account and confirm-first tools, and searches', async () => {
  const server = fakeOpenMedia({ publicTools: sampleTools, accountTools: sampleAccountTools });
  const env = { ...base, ...tempDirs(), OPEN_MEDIA_TOKEN: 't' };
  const all = await capture(['tools', '--json'], env, server.fetch);
  const rows = JSON.parse(all.out).tools as { name: string; command: string; server: string; asksFirst: boolean }[];
  assert.equal(rows.length, sampleTools.length + sampleAccountTools.length);
  assert.equal(rows.find((row) => row.name === 'publish_post')!.server, 'account');
  assert.equal(rows.find((row) => row.name === 'get_feed')!.server, 'open');
  assert.equal(rows.find((row) => row.name === 'delete_post')!.asksFirst, true);
  assert.equal(rows.find((row) => row.name === 'set_up_profile')!.command, 'open-media tool set_up_profile');
  const found = await capture(['tools', '--search', 'publish'], env, server.fetch);
  assert.match(found.out, /publish-post\s+Publish a post\s+\[account, asks first\]/);
  assert.match(found.out, /1 of 10 tools/);
});

test('the tool list is cached per server for a short time, then read again', async () => {
  const server = fakeOpenMedia({ publicTools: sampleTools });
  const dirs = tempDirs();
  let now = 1_000_000;
  const options = { baseUrl: 'https://api.test', cacheDir: dirs.OPEN_MEDIA_CACHE_DIR, cliVersion: '0.3.0', sources: [{ server: 'open' as const, endpoint: 'https://api.test/open/mcp' }], fetch: server.fetch, now: () => now };
  const first = await loadCatalog(options);
  assert.equal(first.fromCache, false);
  assert.equal(first.serverVersion, '9.9.9');
  assert.equal(readdirSync(dirs.OPEN_MEDIA_CACHE_DIR).length, 1);
  const lists = () => server.calls.filter((item) => item.rpc?.method === 'tools/list').length;
  now += 60_000;
  assert.equal((await loadCatalog(options)).fromCache, true);
  assert.equal(lists(), 1);
  now += 10 * 60_000;
  assert.equal((await loadCatalog(options)).fromCache, false, 'stale after the TTL');
  assert.equal(lists(), 2);
  assert.equal((await loadCatalog({ ...options, cliVersion: '0.4.0' })).fromCache, false, 'a new CLI reads the list again');
  assert.equal((await loadCatalog({ ...options, refresh: true })).fromCache, false);
});

test('a command the cache doesn’t know triggers one fresh read, so new server tools appear', async () => {
  const dirs = tempDirs();
  const old = fakeOpenMedia({ publicTools: sampleTools });
  await capture(['tools'], { ...base, ...dirs }, old.fetch);
  const newer = fakeOpenMedia({ publicTools: [...sampleTools, { name: 'brand_new_tool', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } }] });
  const result = await capture(['brand-new-tool'], { ...base, ...dirs }, newer.fetch);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(newer.calls.filter((item) => item.rpc).map((item) => item.rpc!.method), ['initialize', 'tools/list', 'tools/call']);
});

test('publishing and destructive tools ask first: --yes, a yes at the prompt, or a usage error', async () => {
  const server = fakeOpenMedia({ publicTools: sampleTools, accountTools: sampleAccountTools });
  const env = { ...base, ...tempDirs(), OPEN_MEDIA_TOKEN: 't' };
  const called = () => server.calls.filter((item) => item.rpc?.method === 'tools/call').map((item) => item.rpc!.params!.name);
  const refused = await capture(['publish-post', 'Hello', 'world'], env, server.fetch);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /text: Hello world[\s\S]*--yes/);
  const declined = await capture(['delete-post', '--id', 'p1'], env, server.fetch, { interactive: true, confirm: async () => false });
  assert.equal(declined.code, 2);
  assert.deepEqual(called(), [], 'nothing runs without a yes');
  let asked = '';
  const accepted = await capture(['delete-post', '--id', 'p1'], env, server.fetch, { interactive: true, confirm: async (question) => { asked = question; return true; } });
  assert.equal(accepted.code, 0);
  assert.match(asked, /Delete a post as you[\s\S]*id: p1[\s\S]*\[y\/N\]/);
  assert.equal((await capture(['publish-post', 'Hi', '--yes'], env, server.fetch)).code, 0);
  assert.equal((await capture(['set-read-receipts', '--no-enabled'], env, server.fetch)).code, 0, 'quiet settings changes don’t ask');
  assert.deepEqual(called(), ['delete_post', 'publish_post', 'set_read_receipts']);
});

test('tool errors exit 1, bad arguments exit 2', async () => {
  const server = fakeOpenMedia({ publicTools: sampleTools, onCall: () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'not_found', message: 'Post not found.' }) }] }) });
  const env = { ...base, ...tempDirs() };
  const failed = await capture(['get-post', 'nope'], env, server.fetch);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /not_found\): Post not found/);
  const json = await capture(['get-post', 'nope', '--json'], env, server.fetch);
  assert.equal(JSON.parse(json.err).error.error, 'not_found');
  assert.equal((await capture(['get-feed', '--kind', 'reels'], env, server.fetch)).code, 2);
  assert.equal((await capture(['get-feed', '--bogus'], env, server.fetch)).code, 2);
  assert.equal((await capture(['no-such-thing'], env, server.fetch)).code, 2);
  const down = (async () => Response.json({ error: 'unavailable' }, { status: 503 })) as unknown as typeof fetch;
  assert.equal((await capture(['get-feed'], { ...base, ...tempDirs() }, down)).code, 1);
});

test('api calls any REST route with the saved token, and asks before raw publishing', async () => {
  const seen: { path: string; method: string; auth: string | null; body: unknown }[] = [];
  const server = fakeOpenMedia({
    publicTools: sampleTools,
    rest: async (url, init) => {
      const headers = new Headers(init.headers);
      seen.push({ path: url.pathname + url.search, method: init.method ?? 'GET', auth: headers.get('authorization'), body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname === '/v1/missing') return Response.json({ error: { code: 'not_found', message: 'Nope.' } }, { status: 404 });
      return Response.json({ ok: true, path: url.pathname });
    },
  });
  const env = { ...base, ...tempDirs(), OPEN_MEDIA_TOKEN: 'tok' };
  const read = await capture(['api', 'get', '/v1/me/follows', '--query', 'limit=5'], env, server.fetch);
  assert.equal(read.code, 0, read.err);
  assert.deepEqual(JSON.parse(read.out), { ok: true, path: '/v1/me/follows' });
  assert.deepEqual(seen[0], { path: '/v1/me/follows?limit=5', method: 'GET', auth: 'Bearer tok', body: undefined });
  const unconfirmed = await capture(['api', 'POST', '/v1/me/posts', '--data', '{"text":"hi"}'], env, server.fetch);
  assert.equal(unconfirmed.code, 2);
  assert.equal(seen.length, 1);
  const posted = await capture(['api', 'POST', '/v1/me/posts', '--data', '-', '--yes'], env, server.fetch, { stdin: () => '{"text":"hi"}' });
  assert.equal(posted.code, 0);
  assert.deepEqual(seen[1].body, { text: 'hi' });
  assert.equal((await capture(['api', 'GET', '/v1/missing'], env, server.fetch)).code, 1);
  assert.equal((await capture(['api', 'FETCH', '/v1/me'], env, server.fetch)).code, 2);
  assert.equal((await capture(['api', 'GET', 'v1/me'], env, server.fetch)).code, 2);
  assert.equal((await capture(['api', 'POST', '/v1/x', '--data', '{bad'], env, server.fetch)).code, 2);
});

test('completion scripts cover the built-ins and every tool', async () => {
  const server = fakeOpenMedia({ publicTools: sampleTools, accountTools: sampleAccountTools });
  const env = { ...base, ...tempDirs(), OPEN_MEDIA_TOKEN: 't' };
  const zsh = await capture(['completion', 'zsh'], env, server.fetch);
  assert.equal(zsh.code, 0);
  assert.match(zsh.out, /^#compdef open-media/);
  assert.match(zsh.out, /'get-feed:Read the feed'/);
  assert.match(zsh.out, /'--kind\[clips = short videos only\]:value:\(feed clips\)'/);
  assert.match(zsh.out, /'publish-post:Publish a post'/);
  const bash = await capture(['completion', 'bash'], env, server.fetch);
  assert.match(bash.out, /complete -F _open_media open-media/);
  assert.match(bash.out, /compgen -W "[^"]*\bfeed\b[^"]*\bget-feed\b[^"]*"/);
  assert.equal((await capture(['completion', 'fish'], env, server.fetch)).code, 2);
});

test('the MCP client pages through tools/list', async () => {
  let page = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const rpc = JSON.parse(String(init.body));
    page += 1;
    const result = rpc.params.cursor ? { tools: [{ name: 'b' }] } : { tools: [{ name: 'a' }], nextCursor: 'next' };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  }) as unknown as typeof fetch;
  const tools = await new McpClient({ endpoint: 'https://api.test/open/mcp', fetch: fetchImpl }).listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['a', 'b']);
  assert.equal(page, 2);
});
