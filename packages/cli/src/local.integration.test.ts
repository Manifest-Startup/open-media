/**
 * Against the local stack (`npm run local`): sign in with the email-code fallback, list the tools
 * from the real MCP servers, and run reads and writes on a made-up account.
 *
 *   OPEN_MEDIA_LOCAL_STACK=1 npm run test:local --prefix packages/cli
 *
 * Skipped otherwise, so `npm run check` never needs the stack or touches its data.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { capture, tempDirs } from './testing';

const api = process.env.OPEN_MEDIA_LOCAL_API ?? 'http://127.0.0.1:8787';
const inbox = process.env.OPEN_MEDIA_LOCAL_INBOX ?? 'http://127.0.0.1:54324';
const enabled = process.env.OPEN_MEDIA_LOCAL_STACK === '1';

async function latestCode(email: string, realFetch: typeof fetch): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await realFetch(`${inbox}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=1`);
    const { messages = [] } = await search.json() as { messages?: { ID: string }[] };
    if (messages.length) {
      const message = await (await realFetch(`${inbox}/api/v1/message/${messages[0].ID}`)).json() as { Text?: string };
      const code = message.Text?.match(/\b(\d{6,10})\b/)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No sign-in email for ${email} in the local inbox.`);
}

test('the CLI against the local stack: email-code login, every tool listed, reads and writes', { skip: !enabled && 'set OPEN_MEDIA_LOCAL_STACK=1 with npm run local running' }, async () => {
  const realFetch = globalThis.fetch;
  const env = { ...tempDirs(), OPEN_MEDIA_BASE_URL: api };
  const om = (...argv: string[]) => capture(argv, env, realFetch);
  const email = `cli-local-${Date.now()}@example.test`;
  const handle = `cli${Date.now() % 1_000_000_000}`;

  // Public tools work signed out.
  const publicTools = JSON.parse((await om('tools', '--json')).out).tools as { name: string; command: string }[];
  assert.ok(publicTools.some((tool) => tool.name === 'get_feed'));
  assert.ok(!publicTools.some((tool) => tool.name === 'publish_post'));
  const networks = await om('list-networks', '--json');
  assert.equal(networks.code, 0, networks.err);

  // Sign in with the emailed code (the headless fallback).
  const asked = await om('login', email);
  assert.equal(asked.code, 0, asked.err);
  const signedIn = await om('login', email, '--code', await latestCode(email, realFetch));
  assert.equal(signedIn.code, 0, signedIn.err);
  assert.match(signedIn.out, /new account/);
  assert.equal((await om('set-up-profile', '--name', 'CLI Local Test', '--handle', handle)).code, 0);

  // The account server adds its tools, and every one of them is a command.
  const tools = JSON.parse((await om('tools', '--json')).out).tools as { name: string; command: string; server: string }[];
  assert.ok(tools.length > publicTools.length, 'signed in, the account tools appear');
  assert.ok(tools.some((tool) => tool.name === 'publish_post' && tool.server === 'account'));
  for (const tool of tools) assert.match(tool.command, /^open-media [a-z0-9-]+( [a-z_]+)?$/, tool.name);

  // Reads.
  const me = await om('get-me', '--json');
  assert.equal(me.code, 0, me.err);
  assert.equal(JSON.parse(me.out).handle, handle);
  assert.equal((await om('get-feed', '--sources', 'open-media', '--json')).code, 0);
  assert.equal((await om('find-setting', '--query', 'read receipts')).code, 0);

  // Writes: publishing asks first, then works with --yes; the post can be read and deleted.
  assert.equal((await om('publish-post', 'Synthetic CLI test post')).code, 2);
  const published = await om('publish-post', 'Synthetic CLI test post', '--yes', '--json');
  assert.equal(published.code, 0, published.err);
  const id = JSON.parse(published.out).id as string;
  const read = await om('get-post', id, '--json');
  assert.equal(JSON.parse(read.out).text, 'Synthetic CLI test post');
  assert.equal((await om('set-read-receipts', '--no-share', '--yes')).code, 0);
  assert.equal((await om('set-read-receipts', '--share', '--yes')).code, 0);
  assert.equal((await om('delete-post', '--id', id, '--yes')).code, 0);
  assert.equal((await om('get-post', id)).code, 1, 'a deleted post is gone');

  // REST escape hatch and completion.
  const rest = await om('api', 'GET', '/v1/me');
  assert.equal(JSON.parse(rest.out).handle, handle);
  assert.match((await om('completion', 'zsh')).out, /'publish-post:/);

  assert.equal((await om('logout')).code, 0);
  assert.equal((await om('get-me')).code, 2, 'signed out, account tools need a sign-in');
});
