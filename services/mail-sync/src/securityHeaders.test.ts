import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { httpsRedirect, pagePolicy, webAppPolicy, withSecurityHeaders } from './securityHeaders.js';

test('every response gets HSTS, nosniff and no framing, without touching JSON or streams', async () => {
  const json = await withSecurityHeaders(new Response('{"a":1}', { status: 201, headers: { 'content-type': 'application/json' } }));
  assert.equal(json.status, 201);
  assert.equal(await json.text(), '{"a":1}');
  assert.match(json.headers.get('strict-transport-security')!, /max-age=31536000/);
  assert.equal(json.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(json.headers.get('x-frame-options'), 'DENY');
  assert.equal(json.headers.get('content-security-policy'), null);
  const redirect = await withSecurityHeaders(Response.redirect('https://openmedia.site/', 301));
  assert.equal(redirect.headers.get('location'), 'https://openmedia.site/');
});

test('server pages may run only the inline scripts they ship', async () => {
  const script = 'console.log("tools")';
  const page = await withSecurityHeaders(new Response(`<html><script type="application/ld+json">{"@type":"Thing"}</script><script>${script}</script></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const policy = page.headers.get('content-security-policy')!;
  assert.ok(policy.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`));
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(await pagePolicy('<p>no scripts</p>'), /script-src https:\/\/static\.cloudflareinsights\.com;/);
});

test('the web app runs only its own scripts and connects only over TLS', async () => {
  const app = await withSecurityHeaders(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }), { webApp: true });
  assert.equal(app.headers.get('content-security-policy'), webAppPolicy);
  assert.match(webAppPolicy, /script-src 'self' 'wasm-unsafe-eval' https:\/\/static\.cloudflareinsights\.com;/);
  assert.match(webAppPolicy, /connect-src 'self' https: wss:;/);
  assert.doesNotMatch(webAppPolicy, /'unsafe-eval'[^-]/);
});

test('the sign-in gateway runs no third-party scripts and connects only to Open Media and its Supabase project', async () => {
  const { signInPolicy } = await import('./securityHeaders.js');
  const response = await withSecurityHeaders(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }), { webApp: true, signIn: { connect: ['https://db.example.supabase.co', 'https://api.openmedia.site'] } });
  const policy = response.headers.get('content-security-policy')!;
  assert.equal(policy, signInPolicy(['https://db.example.supabase.co', 'https://api.openmedia.site']));
  assert.ok(policy.includes("script-src 'self' 'wasm-unsafe-eval';"), 'no analytics or other scripts');
  assert.ok(policy.includes("connect-src 'self' https://db.example.supabase.co https://api.openmedia.site;"));
  assert.ok(policy.includes("frame-src 'none'") && policy.includes("frame-ancestors 'none'") && policy.includes("base-uri 'none'"));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('plain HTTP on openmedia.site moves to HTTPS; local development does not', () => {
  const get = httpsRedirect(new Request('http://openmedia.site/feed?x=1'));
  assert.equal(get?.status, 301);
  assert.equal(get?.headers.get('location'), 'https://openmedia.site/feed?x=1');
  assert.equal(httpsRedirect(new Request('http://api.openmedia.site/v1/me', { method: 'POST' }))?.status, 308);
  assert.equal(httpsRedirect(new Request('https://openmedia.site/')), undefined);
  assert.equal(httpsRedirect(new Request('http://localhost:8787/')), undefined);
  assert.equal(httpsRedirect(new Request('http://notopenmedia.site/')), undefined);
});
