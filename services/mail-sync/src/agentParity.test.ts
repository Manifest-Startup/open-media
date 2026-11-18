/**
 * Parity guard (ADR 0043): everything a person can do in the app, an agent can do through MCP,
 * unless src/domain/agentParity.ts says why not. A new REST operation or app data function fails
 * here until it is mapped to a tool or given a reason.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { appCapabilities, sourcePrefix } from '../../../src/domain/agentParity';
import { fullOpenApi, registeredTools } from './agentApi.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const sources = new Set(appCapabilities.flatMap((capability) => capability.sources));

/** The app's data layer: every exported function is something a screen does or needs. */
function appFunctions(): string[] {
  const files = [
    ...readdirSync(join(root, 'src/data')).filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.test.ts')).map((file) => `src/data/${file}`),
    'src/connectors/mailApiConnector.ts', 'src/connectors/aiChatConnector.ts', 'src/connectors/bridgesConnector.ts', 'src/auth/accountSecurity.ts',
  ];
  const names = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) names.add(`${sourcePrefix(file)}.${match[1]}`);
  }
  return [...names].sort();
}

function restOperations(): string[] {
  const document = fullOpenApi('https://api.openmedia.site') as { paths: Record<string, Record<string, unknown>> };
  return Object.entries(document.paths)
    .filter(([path]) => !path.startsWith('/v1/connected/')) // mirrors of /v1/me for apps (ADR 0041)
    .flatMap(([path, operations]) => Object.keys(operations).filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method)).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();
}

test('every REST operation is a capability with an MCP tool or a stated reason', () => {
  const missing = restOperations().filter((operation) => !sources.has(operation));
  assert.deepEqual(missing, [], 'add these to src/domain/agentParity.ts with the tool that does the same, or a reason there is none');
});

test('every app data function is a capability with an MCP tool or a stated reason', () => {
  const functions = appFunctions();
  assert.ok(functions.length > 100);
  const missing = functions.filter((name) => !sources.has(name));
  assert.deepEqual(missing, [], 'add these to src/domain/agentParity.ts with the tool that does the same, or a reason there is none');
});

test('the parity map names only real tools, operations and functions, and every gap has a reason', () => {
  const tools = new Set([...registeredTools('public'), ...registeredTools('account')]);
  const known = new Set([...restOperations(), ...appFunctions()]);
  for (const capability of appCapabilities) {
    assert.ok(capability.sources.length, capability.capability);
    for (const source of capability.sources) assert.ok(known.has(source), `${capability.capability}: ${source} is not a REST operation or app function any more`);
    if (capability.tools) {
      assert.ok(capability.tools.length && !capability.noTool, `${capability.capability}: tools or a reason, not both`);
      for (const name of capability.tools) assert.ok(tools.has(name), `${capability.capability}: ${name} is not a registered MCP tool`);
    } else {
      assert.ok(capability.noTool && capability.noTool.reason.length > 20, `${capability.capability}: say why there is no tool`);
    }
  }
  // Gaps stay the exception: most of the app is reachable by agents.
  const features = appCapabilities.filter((capability) => capability.noTool?.kind !== 'internal');
  const covered = features.filter((capability) => capability.tools).length;
  assert.ok(covered / features.length >= 0.8, `${covered} of ${features.length} capabilities have tools`);
});
