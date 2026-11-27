import assert from 'node:assert/strict';
import test from 'node:test';

import { emailPreview, formatEmailBody, linkMatches } from './emailBody';

test('turns "Label ( url )" into tappable words', () => {
  const { segments, plain } = formatEmailBody('Shop by type\nSparkling\tSparkling\n ( https://clicks.vivino.com/f/a/B2rx~~/AAA~&lid=jn8 )\nRose Rosé ( https://clicks.vivino.com/f/a/wKS~&lid=zeq )');
  assert.equal(plain, 'Shop by type\nSparkling\nRosé');
  const links = segments.filter((segment) => segment.url);
  assert.equal(links.length, 2);
  assert.equal(links[1].text, 'Rosé');
  assert.match(links[1].url!, /^https:\/\/clicks\.vivino\.com\//);
  assert.ok(!plain.includes('http'));
});

test('labels bare and unlabeled links by domain', () => {
  const { segments } = formatEmailBody('Read more: https://www.example.com/a/b?c=1.');
  assert.deepEqual(segments, [{ text: 'Read more: ' }, { text: 'example.com ↗', url: 'https://www.example.com/a/b?c=1' }, { text: '.' }]);
});

test('drops quoted reply history', () => {
  const body = 'Sounds good!\n\nOn Thu, Oct 1, 2026 at 10:00 AM Ana <ana@example.com> wrote:\n> Lunch Thursday?\n> Noon?';
  const result = formatEmailBody(body);
  assert.equal(result.plain, 'Sounds good!');
  assert.equal(result.hadQuotedHistory, true);
  assert.equal(formatEmailBody('Yes\n\n> earlier line\n> more').plain, 'Yes');
});

test('removes invisible characters and layout spacing', () => {
  const { plain } = formatEmailBody('Hello​ there͏   friend\n\n\n\n\nBye');
  assert.equal(plain, 'Hello there friend\n\nBye');
});

test('previews use the first readable line', () => {
  assert.equal(emailPreview('​\n\nHey! Want lunch? ( https://x.example/y )\nMore'), 'Hey! Want lunch?');
  assert.equal(emailPreview('', 'Subject'), 'Subject');
});

test('stylesheets left in the plain-text version are removed', () => {
  const raw = [
    'Learn in-demand skills from Google experts by enrolling today',
    'body, table, td, th, h1, h2, h3, div, span, strong, b, i, p, ul,',
    'ol, li, a { font-family: Helvetica, sans-serif !important;} sup {',
    'font-size: 100% !important; } .nudge-component-icon-column {',
    'padding-left: 12px !important; padding-right: 32px !important; }',
    '@media only screen and (max-width: 600px) { .mobile-only { display: none !important; } }',
    'Coursera Google Career Certificates',
  ].join('\n');
  assert.equal(formatEmailBody(raw).plain, 'Learn in-demand skills from Google experts by enrolling today\n\nCoursera Google Career Certificates');
});

test('sentences with braces are not mistaken for CSS', () => {
  assert.equal(formatEmailBody('Use {name} in the template.\nSee you {soon}!').plain, 'Use {name} in the template.\nSee you {soon}!');
});

test('rows of asterisks and equals signs become paragraph breaks', () => {
  assert.equal(formatEmailBody('Top\n*********************\nBuild skills\n=====\nEnd').plain, 'Top\n\nBuild skills\n\nEnd');
});

test('HTML pasted into the plain-text part reads as a message, links kept', () => {
  const raw = 'Please read this email for more information\n\nHello Sam,</p><p style="margin:0;margin-bottom:0">&nbsp;</p><p style="margin:0;margin-bottom:0">Your order has been shipped!</p><p style="margin:0;margin-bottom:0">\nClick this <a href="https://shop.example.com/track?id=1" target="_blank" style="text-decoration: underline; color: #000000;" rel="noopener">link</a>&nbsp;to track your order. Tracking can take up to 24 hours.</p><p style="margin:0;margin-bottom:0">&nbsp;</p><p style="margin:0">Thanks &amp; see you soon</p>';
  const { plain, segments } = formatEmailBody(raw);
  assert.doesNotMatch(plain, /<|style=|&nbsp;|&amp;/);
  assert.ok(plain.split('\n').includes('Your order has been shipped!'));
  assert.match(plain, /Click this link to track your order\./);
  assert.match(plain, /Thanks & see you soon/);
  assert.deepEqual(segments.find((segment) => segment.url), { text: 'link', url: 'https://shop.example.com/track?id=1' });
});

test('plain text that mentions angle brackets is not treated as HTML', () => {
  const raw = 'If a < b and c > d, use <p> tags.\nThanks';
  assert.equal(formatEmailBody(raw).plain, raw);
});

// The regex linkMatches replaced. It is quadratic on long lines, so it stays here only as the reference.
const referencePattern = /\uE000([^\uE000\uE001\uE002]*)\uE001(https?:\/\/[^\s\uE002]+)\uE002|([^\n()[\]<>]*?)\s*[([<]\s*(https?:\/\/[^\s)\]>]+)\s*[)\]>]|(https?:\/\/[^\s)\]>]+)/g;
const asReference = (text: string) => [...text.matchAll(referencePattern)].map((match) => ({
  index: match.index, whole: match[0],
  markedLabel: match[1], markedURL: match[2], label: match[3], wrappedURL: match[4], bareURL: match[5],
}));
const asNew = (text: string) => [...linkMatches(text)].map((match) => ({
  index: match.index, whole: match.whole,
  markedLabel: match.markedLabel, markedURL: match.markedURL, label: match.label, wrappedURL: match.wrappedURL, bareURL: match.bareURL,
}));

test('finds exactly the links the old link regex found', () => {
  const pieces = ['https://a.co/x', 'http://b.io', 'https://', ' ', '  ', '\n', '\t', '(', ')', '[', ']', '<', '>', 'Label', 'Shop', '.', ',', 'h', 'ttp', '\uE000', '\uE001', '\uE002', 'é', '( https://c.com/p?q=1 )', '<https://d.org>', 'Rose [https://e.net/z]'];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 5000; round += 1) {
    const length = 1 + Math.floor(next() * 14);
    const text = Array.from({ length }, () => pieces[Math.floor(next() * pieces.length)]).join('');
    assert.deepEqual(asNew(text), asReference(text), JSON.stringify(text));
  }
});

test('long lines without wrapped links stay fast', () => {
  const line = 'A newsletter line with a link https://example.com/x?y=1 and more words. '.repeat(3000) + 'end';
  const started = performance.now();
  const { segments } = formatEmailBody(`${line}\n${line}`);
  assert.ok(performance.now() - started < 250, `took ${Math.round(performance.now() - started)} ms`);
  assert.equal(segments.filter((segment) => segment.url).length, 6000);
});

test('a preview skips a greeting on its own line, like a chat preview', () => {
  assert.equal(emailPreview('Hi Stephen,\n\nI read your post about two years on Crypto Clamor.'), 'I read your post about two years on Crypto Clamor.');
  assert.equal(emailPreview('Good morning!\nThe parts arrived.'), 'The parts arrived.');
  assert.equal(emailPreview('Hi Stephen, I read your post.'), 'Hi Stephen, I read your post.');
  assert.equal(emailPreview('Hi Stephen,'), 'Hi Stephen,');
});
