/** Readable output for people: posts as posts, everything else as an indented outline. */
import type { Post } from '../../sdk/src/index';

export function printPosts(posts: Post[], log: (line: string) => void = console.log) {
  if (!posts.length) { log('No posts.'); return; }
  for (const post of posts) {
    log(`${post.author?.name ?? ''} (${post.author?.handle ?? ''}) · ${post.network ?? 'open-media'} · ${post.createdAt ?? ''}`);
    if (post.title) log(post.title);
    const text = post.text ?? '';
    log(text.length > 400 ? `${text.slice(0, 400)}…` : text);
    if (post.url) log(post.url);
    if (post.why?.used?.length) log(`Why this: ${post.why.used.join('; ')}`);
    log('');
  }
}

function looksLikePosts(value: unknown): value is Post[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === 'object' && 'author' in item && 'text' in item);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.includes('\n') ? value.replace(/\n/g, '\n    ') : value;
  return String(value);
}

/** An outline of any JSON value, like YAML without the punctuation. Long lists are cut to 50. */
export function outline(value: unknown, indent = ''): string[] {
  if (value === null || typeof value !== 'object') return [`${indent}${scalar(value)}`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}(none)`];
    const lines: string[] = [];
    for (const item of value.slice(0, 50)) {
      if (item !== null && typeof item === 'object') {
        const inner = outline(item, `${indent}  `);
        lines.push(`${indent}- ${inner[0].trimStart()}`, ...inner.slice(1));
      } else lines.push(`${indent}- ${scalar(item)}`);
    }
    if (value.length > 50) lines.push(`${indent}… and ${value.length - 50} more (use --json for everything)`);
    return lines;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return [`${indent}(empty)`];
  const lines: string[] = [];
  for (const [key, item] of entries) {
    if (item !== null && typeof item === 'object' && (Array.isArray(item) ? item.length : Object.keys(item).length)) {
      lines.push(`${indent}${key}:`, ...outline(item, `${indent}  `));
    } else lines.push(`${indent}${key}: ${Array.isArray(item) ? '(none)' : item !== null && typeof item === 'object' ? '(empty)' : scalar(item)}`);
  }
  return lines;
}

/** Prints a tool's or route's result for a person. */
export function printReadable(value: unknown, log: (line: string) => void = console.log) {
  if (looksLikePosts(value)) { printPosts(value, log); return; }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['data', 'posts', 'items']) {
      if (looksLikePosts(record[key])) {
        printPosts(record[key] as Post[], log);
        const rest = Object.fromEntries(Object.entries(record).filter(([name, item]) => name !== key && item !== null && item !== undefined && !(Array.isArray(item) && !item.length)));
        if (Object.keys(rest).length) for (const line of outline(rest)) log(line);
        return;
      }
    }
  }
  for (const line of outline(value)) log(line);
}
