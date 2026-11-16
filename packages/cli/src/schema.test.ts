import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs, UsageError } from './args';
import { buildArguments, flagsFor, kebab, needsConfirmation, Tool, toolHelp } from './schema';

const tool = (properties: Record<string, object>, required: string[] = [], extra: Partial<Tool> = {}): Tool => ({ name: 'demo_tool', inputSchema: { type: 'object', properties, required }, ...extra });

test('names become kebab-case flags and commands', () => {
  assert.equal(kebab('set_up_profile'), 'set-up-profile');
  assert.equal(kebab('linkedInPdfText'), 'linked-in-pdf-text');
  assert.equal(kebab('txHash'), 'tx-hash');
  assert.equal(kebab('HTMLBody'), 'html-body');
  assert.deepEqual(flagsFor(tool({ postId: { type: 'string' }, refresh_token: { type: 'string' } }).inputSchema).map((flag) => flag.flag), ['post-id', 'refresh-token']);
});

test('every schema shape maps to a flag kind', () => {
  const flags = flagsFor(tool({
    text: { type: 'string' },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    on: { type: 'boolean' },
    kind: { type: 'string', enum: ['feed', 'clips'] },
    sources: { type: 'array', items: { type: 'string', enum: ['lens', 'hive'] } },
    texts: { type: 'array', items: { type: 'string', maxLength: 5000 } },
    to: { type: 'array', items: { type: 'string' } },
    cards: { type: 'array', items: { type: 'object' } },
    manifest: { type: 'object', additionalProperties: {} },
    stars: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    base: { anyOf: [{ type: 'string' }, { type: 'object' }] },
    anything: {},
  }, ['text']).inputSchema);
  const byName = Object.fromEntries(flags.map((flag) => [flag.property, flag]));
  assert.equal(byName.text.kind, 'string'); assert.equal(byName.text.required, true);
  assert.equal(byName.count.kind, 'integer');
  assert.equal(byName.ratio.kind, 'number');
  assert.equal(byName.on.kind, 'boolean');
  assert.deepEqual(byName.kind.enumValues, ['feed', 'clips']);
  assert.equal(byName.sources.item?.kind, 'enum');
  assert.equal(byName.texts.item?.splitCommas, false, 'long free text is never split on commas');
  assert.equal(byName.to.item?.splitCommas, true);
  assert.equal(byName.cards.item?.kind, 'json');
  assert.equal(byName.manifest.kind, 'json');
  assert.equal(byName.stars.kind, 'integer'); assert.equal(byName.stars.nullable, true);
  assert.equal(byName.base.kind, 'json'); assert.equal(byName.base.allowsString, true);
  assert.equal(byName.anything.kind, 'json'); assert.equal(byName.anything.allowsString, true);
});

test('flags convert to typed arguments', () => {
  const demo = tool({
    query: { type: 'string' }, limit: { type: 'integer' }, on: { type: 'boolean' }, off: { type: 'boolean' },
    kind: { type: 'string', enum: ['feed', 'clips'] }, sources: { type: 'array', items: { type: 'string', enum: ['lens', 'hive', 'deso'] } },
    texts: { type: 'array', items: { type: 'string', maxLength: 5000 } }, manifest: { type: 'object' }, stars: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    base: { anyOf: [{ type: 'string' }, { type: 'object' }] },
  });
  const args = buildArguments(demo, ['--query', 'cats', '--limit=5', '--on', '--no-off', '--kind', 'clips', '--sources', 'lens,hive', '--sources', 'deso',
    '--texts', 'Hello, world', '--texts', 'Bye', '--manifest', '{"a":1}', '--stars', 'null', '--base', 'relevant']);
  assert.deepEqual(args, { query: 'cats', limit: 5, on: true, off: false, kind: 'clips', sources: ['lens', 'hive', 'deso'], texts: ['Hello, world', 'Bye'], manifest: { a: 1 }, stars: null, base: 'relevant' });
  assert.deepEqual(buildArguments(demo, ['--sources', '["lens"]', '--base', '{"x":true}']), { sources: ['lens'], base: { x: true } });
});

test('bad values, unknown flags and missing fields are usage errors', () => {
  const demo = tool({ id: { type: 'string' }, limit: { type: 'integer' }, kind: { type: 'string', enum: ['a', 'b'] }, manifest: { type: 'object' } }, ['id']);
  assert.throws(() => buildArguments(demo, ['--id', 'x', '--limit', '2.5']), /whole number/);
  assert.throws(() => buildArguments(demo, ['--id', 'x', '--kind', 'c']), /one of: a, b/);
  assert.throws(() => buildArguments(demo, ['--id', 'x', '--manifest', 'nope']), /must be JSON/);
  assert.throws(() => buildArguments(demo, ['--id', 'x', '--colour', 'red']), /Unknown option --colour/);
  assert.throws(() => buildArguments(demo, []), (error: Error) => error instanceof UsageError && /needs --id/.test(error.message));
  assert.throws(() => buildArguments(demo, ['--id', 'a', '--id', 'b']), /more than once/);
  assert.throws(() => parseArgs(['--json=maybe'], [{ name: 'json', value: false }]), /switch/);
});

test('positionals fill required fields, and extra words join the last text field', () => {
  const post = tool({ text: { type: 'string' } }, ['text']);
  assert.deepEqual(buildArguments(post, ['Hello', 'there', 'world']), { text: 'Hello there world' });
  const two = tool({ network: { type: 'string', enum: ['lens', 'hive'] }, handle: { type: 'string' } }, ['network', 'handle']);
  assert.deepEqual(buildArguments(two, ['lens', 'ada']), { network: 'lens', handle: 'ada' });
  assert.throws(() => buildArguments(tool({ id: { type: 'string' } }), ['stray']), /Unexpected argument/);
});

test('--input takes JSON, a file or stdin, and flags override it', () => {
  const demo = tool({ text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, ['text']);
  assert.deepEqual(buildArguments(demo, ['--input', '{"text":"a","tags":["x"]}', '--text', 'b']), { text: 'b', tags: ['x'] });
  const dir = mkdtempSync(join(tmpdir(), 'om-schema-'));
  writeFileSync(join(dir, 'args.json'), '{"text":"from file"}');
  assert.deepEqual(buildArguments(demo, ['--input', `@${join(dir, 'args.json')}`]), { text: 'from file' });
  assert.deepEqual(buildArguments(demo, ['--input', '-'], { stdin: () => '{"text":"piped"}' }), { text: 'piped' });
  assert.throws(() => buildArguments(demo, ['--input', '[1]']), /JSON object/);
});

test('confirmation follows the annotations and the tool’s verb', () => {
  assert.equal(needsConfirmation({ name: 'get_feed', annotations: { readOnlyHint: true } }), false);
  assert.equal(needsConfirmation({ name: 'remove_wallet', annotations: { readOnlyHint: false, destructiveHint: true } }), true);
  for (const name of ['publish_post', 'send_message', 'comment_on_post', 'reshare_post', 'start_payment', 'submit_payment_transaction', 'disconnect_chat_network', 'block_person']) {
    assert.equal(needsConfirmation({ name, annotations: { readOnlyHint: false } }), true, name);
  }
  for (const name of ['follow', 'set_read_receipts', 'tune_feed_lens', 'mark_conversation_read']) assert.equal(needsConfirmation({ name, annotations: { readOnlyHint: false } }), false, name);
});

test('help comes from the description and schema', () => {
  const help = toolHelp(tool({ kind: { type: 'string', enum: ['feed', 'clips'], description: 'clips = short videos only' }, id: { type: 'string' } }, ['id'], { title: 'Demo', description: 'Does a demo.', annotations: { readOnlyHint: true } }), 'demo-tool');
  assert.match(help, /^open-media demo-tool <id> \[options\]/);
  assert.match(help, /Does a demo\./);
  assert.match(help, /--kind <feed\|clips>\s+clips = short videos only/);
  assert.match(help, /--id <string>\s+\(required\)/);
  assert.match(help, /MCP tool: demo_tool/);
});
