/**
 * Drift guard: every tool the account and public MCP servers register is a working command in the
 * Open Media CLI (packages/cli). The catalog comes from the real servers' `tools/list`, so a new
 * tool is covered the moment it's registered, and one whose schema the CLI can't turn into flags
 * fails here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { builtins, commandFor, run } from '../../../packages/cli/src/cli';
import { flagsFor, JsonSchema, kebab, needsConfirmation, Tool, toolHelp } from '../../../packages/cli/src/schema';
import { Account, accountMcp, AgentEnv, registeredTools } from './agentApi.js';

const origin = 'https://api.openmedia.site';

async function serverTools(): Promise<Tool[]> {
  const server = accountMcp({} as AgentEnv, origin, {} as Account);
  const response = await server.fetch(new Request(`${origin}/me/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }));
  const text = await response.text();
  const payload = text.trimStart().startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
  return (JSON.parse(payload) as { result: { tools: Tool[] } }).result.tools;
}

/** The smallest arguments the schema accepts, for calling each command once. */
function sample(schema: JsonSchema = {}): unknown {
  const options = schema.anyOf ?? schema.oneOf;
  if (options) return sample(options.find((option) => option.type !== 'null') ?? options[0]);
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== 'null') : schema.type;
  switch (type) {
    case 'string': return schema.format === 'uri' ? 'https://example.com/a' : 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    case 'integer': case 'number': return schema.minimum !== undefined && schema.minimum > 0 ? schema.minimum : 1;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return Object.fromEntries((schema.required ?? []).map((key) => [key, sample(schema.properties?.[key])]));
    default: return 'x';
  }
}

test('every MCP tool in agentApi.ts is a CLI command that calls that tool', async () => {
  const tools = await serverTools();
  const registered = new Set([...registeredTools('public'), ...registeredTools('account')]);
  assert.deepEqual(new Set(tools.map((tool) => tool.name)), registered, 'the catalog is exactly what agentApi.ts registers');
  assert.ok(tools.length > 100);

  const realServer = accountMcp({} as AgentEnv, origin, {} as Account);
  const called: string[] = [];
  const fakeFetch = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body ?? '{}')) as { id: number; method: string; params?: { name: string } };
    if (body.method === 'tools/call') {
      called.push(body.params!.name);
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
    }
    // Both /open/mcp and /me/mcp list from the real account server (a superset), as the CLI would see them.
    return realServer.fetch(new Request(`${origin}/me/mcp`, { method: 'POST', headers: init.headers as HeadersInit, body: init.body as string }));
  }) as typeof fetch;

  const root = mkdtempSync(join(tmpdir(), 'open-media-cli-coverage-'));
  const env = { OPEN_MEDIA_BASE_URL: origin, OPEN_MEDIA_TOKEN: 'synthetic', OPEN_MEDIA_CONFIG_DIR: join(root, 'config'), OPEN_MEDIA_CACHE_DIR: join(root, 'cache') };
  const realFetch = globalThis.fetch; const log = console.log; const error = console.error;
  const errors: string[] = [];
  globalThis.fetch = fakeFetch;
  console.log = () => undefined;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    for (const tool of tools) {
      // Flags and help are generated for every schema without throwing.
      assert.ok(flagsFor(tool.inputSchema).every((flag) => flag.flag === kebab(flag.property)), tool.name);
      assert.match(toolHelp(tool, commandFor(tool.name).join(' ')), new RegExp(`MCP tool: ${tool.name}`));
      const argv = [...commandFor(tool.name), '--input', JSON.stringify(sample(tool.inputSchema)), '--yes'];
      const before = called.length;
      errors.length = 0;
      const code = await run(argv, env, { interactive: false });
      assert.equal(code, 0, `open-media ${argv.join(' ')} → ${errors.join(' ')}`);
      assert.deepEqual(called.slice(before), [tool.name], `open-media ${commandFor(tool.name).join(' ')} calls ${tool.name}`);
    }
  } finally {
    globalThis.fetch = realFetch; console.log = log; console.error = error;
  }
  // Built-ins only shadow a tool name on purpose; the shadowed tools stay reachable via `tool <name>`.
  const shadowed = tools.filter((tool) => kebab(tool.name) in builtins).map((tool) => tool.name).sort();
  assert.deepEqual(shadowed, ['search', 'set_up_profile']);
  // Publishing, sending, paying and deleting tools ask first.
  for (const name of ['publish_post', 'send_message', 'send_email', 'delete_my_account', 'start_payment', 'remove_wallet', 'comment_on_post']) {
    assert.equal(needsConfirmation(tools.find((tool) => tool.name === name)!), true, name);
  }
});
