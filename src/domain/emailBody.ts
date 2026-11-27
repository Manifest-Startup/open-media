/**
 * Turns the plain-text version of an email (often machine-converted from HTML)
 * into something that reads like a message: links become tappable words
 * instead of long tracking URLs, quoted reply history is dropped, invisible
 * characters and layout spacing are cleaned up.
 */

import { htmlToMessageText, linkMark, looksLikeHtml } from './htmlText';

export interface BodySegment {
  text: string;
  /** Present when this segment is a link. */
  url?: string;
}

export interface FormattedEmailBody {
  segments: BodySegment[];
  /** Plain text without links, for previews and search. */
  plain: string;
  /** True when earlier quoted messages were removed. */
  hadQuotedHistory: boolean;
}

const invisible = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]/g;
const quoteStarts = [
  /^On .{4,200}wrote:\s*$/i,
  /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i,
  /^From:\s.+$/i,
  /^Sent from my (iPhone|iPad|Android)/i,
];

export function formatEmailBody(raw: string): FormattedEmailBody {
  // Some senders put HTML in the plain-text part; read it as a message, links kept.
  let text = (looksLikeHtml(raw) ? htmlToMessageText(raw) : raw)
    .replace(/\r\n?/g, '\n')
    .replace(invisible, '')
    .replace(/ /g, ' ')
    .replace(/\t+/g, ' ');
  text = stripStyleRules(text);

  // Drop quoted history: the first "On … wrote:" / forwarded header, or a trailing block of "> " lines.
  const lines = text.split('\n');
  let cut = lines.findIndex((line, index) => index > 0 && quoteStarts.some((pattern) => pattern.test(line.trim())));
  if (cut === -1) {
    let start = lines.length;
    while (start > 0 && (/^\s*>/.test(lines[start - 1]) || (!lines[start - 1].trim() && start < lines.length))) start -= 1;
    if (start < lines.length && lines.slice(start).some((line) => /^\s*>/.test(line))) cut = start;
  }
  const hadQuotedHistory = cut > 0;
  if (hadQuotedHistory) text = lines.slice(0, cut).join('\n');

  text = text
    .split('\n')
    // Rows of ***, ===, --- or ___ are layout dividers in machine-made text.
    .map((line) => (/^\s*([*=_~#-])\1{3,}\s*$/.test(line) ? '' : line))
    .map((line) => dedupeRepeatedLabel(line.replace(/ {2,}/g, ' ').trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const segments = linkSegments(text);
  const plain = segments.map((segment) => segment.text).join('').replace(/\n{3,}/g, '\n\n').trim();
  return { segments, plain, hadQuotedHistory };
}

/** First readable line of an email, for conversation previews. */
export function emailPreview(raw: string, fallback = ''): string {
  const { plain } = formatEmailBody(raw);
  return plain.split('\n').map((line) => line.trim()).find((line) => line.length > 1) ?? fallback;
}

/**
 * Some senders paste their stylesheet into the plain-text version ("body, td { font-family: … }").
 * Removes rule blocks whose body is CSS declarations, innermost first so @media wrappers go too.
 * A rule's selector must start a line or follow another rule's brace, so ordinary sentences are kept.
 */
function stripStyleRules(text: string): string {
  // A selector list may wrap after its commas ("h1, h2,\nol, li {").
  const rule = /(^|[{}])[ \t]*(?:[^{}\n;]*,[ \t]*\n)*[^{}\n;]*\{\s*(?:[\w-]+\s*:[^{};]*;?\s*)*\}/gm;
  let previous;
  do {
    previous = text;
    text = text.replace(rule, '$1');
  } while (text !== previous);
  return text.replace(/^\s*\}+\s*$/gm, '');
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** "Sparkling Sparkling" (image alt text next to a label) becomes "Sparkling". */
function dedupeRepeatedLabel(line: string): string {
  const words = line.split(' ');
  if (words.length % 2 === 0 && words.length > 0) {
    const half = words.length / 2;
    // Compare without accents or case ("Rose Rosé"), and keep the second, styled label.
    if (fold(words.slice(0, half).join(' ')) === fold(words.slice(half).join(' '))) return words.slice(half).join(' ');
  }
  return line;
}

/** Converts "Label ( https://… )", "Label <https://…>", "Label [https://…]", and bare URLs into link segments. */
function linkSegments(text: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let last = 0;
  for (const match of linkMatches(text)) {
    const { index, whole, markedLabel, markedURL, label, wrappedURL, bareURL } = match;
    if (index > last) segments.push({ text: withoutMarks(text.slice(last, index)) });
    if (markedURL) {
      // A link converted from HTML: its exact words, not the whole line before it.
      const words = (markedLabel ?? '').replace(/\s+/g, ' ').trim();
      segments.push(words ? { text: words, url: markedURL } : { text: linkLabel(markedURL), url: markedURL });
      last = index + whole.length;
      continue;
    }
    const rawURL = (wrappedURL ?? bareURL)!;
    const url = rawURL.replace(/[.,;:!?]+$/, '');
    const trimmedLabel = dedupeRepeatedLabel((label ?? '').trim());
    if (wrappedURL && trimmedLabel) {
      const leading = label!.slice(0, label!.length - label!.trimStart().length);
      if (leading) segments.push({ text: leading });
      segments.push({ text: trimmedLabel, url });
    } else {
      if (label) segments.push({ text: label });
      segments.push({ text: linkLabel(url), url });
    }
    // Trailing sentence punctuation after a bare URL stays in the text.
    last = index + whole.length - (bareURL ? rawURL.length - url.length : 0);
  }
  if (last < text.length) segments.push({ text: withoutMarks(text.slice(last)) });
  return mergeText(segments);
}

interface LinkMatch {
  index: number;
  whole: string;
  markedLabel?: string;
  markedURL?: string;
  label?: string;
  wrappedURL?: string;
  bareURL?: string;
}

const markedLink = new RegExp(`${linkMark.start}([^${linkMark.start}${linkMark.split}${linkMark.end}]*)${linkMark.split}(https?:\\/\\/[^\\s${linkMark.end}]+)${linkMark.end}`, 'y');
const wrappedTail = /\s*[([<]\s*(https?:\/\/[^\s)\]>]+)\s*[)\]>]/y;
const bareLink = /https?:\/\/[^\s)\]>]+/y;
const labelBreak = /[\n()[\]<>]/g;
const nextAnchor = new RegExp(`${linkMark.start}|https?:\\/\\/`, 'g');

/**
 * The links in `text`, left to right, as one regex would find them:
 *   marked HTML link | "Label (url)" with a lazy label of [^\n()[\]<>] | bare url.
 * That single regex restarts its lazy label at every character of a long line without a
 * wrapped link, which is quadratic: a 4 MB inbox took seconds of CPU and the Worker hit
 * its limit. Every start inside one run of label characters ends that run at the same
 * place, so the wrapped-link test is made once per run, and the scan skips ahead to the
 * next place a link could begin. Output matches the regex exactly (emailBody.test.ts).
 */
export function* linkMatches(text: string): Generator<LinkMatch> {
  const sticky = (pattern: RegExp, at: number) => {
    pattern.lastIndex = at;
    return pattern.exec(text);
  };
  // The run of label characters that the current position is in: where it ends, and
  // the wrapped link right after it (or null), which every start in the run shares.
  let runEnd = -1;
  let runTail: RegExpExecArray | null = null;
  let p = 0;
  while (p <= text.length) {
    if (p > runEnd) {
      labelBreak.lastIndex = p;
      const brk = labelBreak.exec(text);
      runEnd = brk ? brk.index : text.length;
      runTail = sticky(wrappedTail, runEnd);
    }
    const marked = text.charCodeAt(p) === 0xe000 ? sticky(markedLink, p) : null;
    if (marked) {
      yield { index: p, whole: marked[0], markedLabel: marked[1], markedURL: marked[2] };
      p += marked[0].length || 1;
      runEnd = -1;
      continue;
    }
    if (runTail) {
      // The lazy label stops before the whitespace that leads up to the bracket.
      let k = runEnd;
      while (k > p && /\s/.test(text[k - 1])) k -= 1;
      const end = runTail.index + runTail[0].length;
      yield { index: p, whole: text.slice(p, end), label: text.slice(p, k), wrappedURL: runTail[1] };
      p = end;
      runEnd = -1;
      continue;
    }
    const bare = sticky(bareLink, p);
    if (bare) {
      yield { index: p, whole: bare[0], bareURL: bare[0] };
      p += bare[0].length;
      runEnd = -1;
      continue;
    }
    // Nothing starts here, and nothing can until the next mark or url, or the next run.
    nextAnchor.lastIndex = p + 1;
    const anchor = nextAnchor.exec(text);
    p = Math.min(anchor ? anchor.index : text.length + 1, runEnd + 1);
  }
}

/** Link marks left unpaired (say, by cutting quoted history mid-link) are never shown. */
function withoutMarks(text: string): string {
  return text.replace(/[\uE000-\uE002]/g, '');
}

function linkLabel(url: string): string {
  try {
    return `${new URL(url).hostname.replace(/^www\./, '')} ↗`;
  } catch {
    return 'link ↗';
  }
}

function mergeText(segments: BodySegment[]): BodySegment[] {
  const merged: BodySegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && !previous.url && !segment.url) previous.text += segment.text;
    else if (segment.text) merged.push({ ...segment });
  }
  return merged;
}
