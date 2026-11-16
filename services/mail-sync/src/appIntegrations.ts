/**
 * App integrations (ADR 0041): what lets a web app such as Manifest work with a person's Open Media
 * account after "Sign in with Open Media".
 *
 * - `/v1/connected/me/*` is `/v1/me/*` for an OAuth account grant. The OAuth provider checks the
 *   app's token; the request is then answered by the same account routes, as the person, with their
 *   own session, exactly as `/account/mcp` reaches `/me/mcp`. Errors use OAuth's
 *   `{error, error_description}` shape there.
 * - `POST /v1/me/media/videos` stores a raw video upload in the person's own folder of the
 *   `post-videos` bucket, streaming it so the Worker never holds the whole file.
 * - `POST /v1/me/realtime-token` hands a browser the person's own short-lived session for Realtime.
 */
import { sha256 } from '@noble/hashes/sha2';

import { contentTypeFromBytes, maxVideoBytes, maxVideoSeconds, postVideoPublicUrl, postVideoBucket, videoContentTypeFor, videoExtension, VideoContentType } from '../../../src/domain/postVideo';
import { VideoInspector } from '../../../src/domain/videoInfo';
import type { AccountGrantProps } from './accountOAuth.js';

/** A refusal written for the app's developer; it never contains credentials. */
export class IntegrationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export const connectedPrefix = '/v1/connected';

// Requests this Worker forwarded from /v1/connected: their rate limit is per person, not per IP,
// because one app's server speaks for many people from the same address.
const forwarded = new WeakMap<Request, { userId: string }>();

export function isConnectedPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '');
  return path === `${connectedPrefix}/me` || path.startsWith(`${connectedPrefix}/me/`);
}

/** /v1/connected/me/… once OAuth has checked the app's token: /v1/me/…, as the person. */
export function connectedRequest(request: Request, props: AccountGrantProps): Request | undefined {
  const url = new URL(request.url);
  if (!isConnectedPath(url.pathname)) return undefined;
  url.pathname = `/v1${url.pathname.slice(connectedPrefix.length)}`;
  const next = new Request(url, request);
  next.headers.set('authorization', `Bearer ${props.accessToken}`);
  next.headers.delete('cookie');
  forwarded.set(next, { userId: props.userId });
  return next;
}

/** The person an app is acting for, when this request came through /v1/connected. */
export function connectedCaller(request: Request): { userId: string } | undefined {
  return forwarded.get(request);
}

/** Account-route errors ({error: {code, message}}) in the OAuth shape the contract names. */
export async function connectedResponse(response: Response): Promise<Response> {
  if (response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return response;
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  const error = (body as { error?: unknown } | undefined)?.error;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: string; message?: string };
    return new Response(JSON.stringify({ error: code ?? `http_${response.status}`, error_description: message ?? 'Open Media refused that request.' }), { status: response.status, headers });
  }
  return new Response(text, { status: response.status, headers });
}

export function connectedNotFound(): Response {
  return Response.json({ error: 'not_found', error_description: 'Only /v1/connected/me/… routes exist. See /v1/openapi.json.' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

// ─── Realtime ────────────────────────────────────────────────────────────────

/**
 * The person's own Supabase session token, so a browser can subscribe to Realtime changes on
 * `messages`. Row-level security limits it to their own conversations, and it expires with the
 * session (about an hour); the app asks again for a fresh one.
 */
export function realtimeToken(supabaseUrl: string, publishableKey: string, token: string): { supabase_url: string; anon_key: string; access_token: string; expires_at: number | null } {
  return { supabase_url: supabaseUrl.replace(/\/$/, ''), anon_key: publishableKey, access_token: token, expires_at: tokenExpiry(token) };
}

function tokenExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}

// ─── Video upload ────────────────────────────────────────────────────────────

/** What an upload returns. The app sends it back unchanged as `video` when it publishes. */
export interface UploadedVideo {
  path: string;
  posterPath: null;
  durationSeconds: number;
  width: number;
  height: number;
  contentType: VideoContentType;
  sha256: string;
  sizeBytes: number;
  url: string;
}

export interface VideoUploadInput {
  supabaseUrl: string;
  publishableKey: string;
  token: string;
  userId: string;
  request: Request;
}

const acceptedTypes = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

/**
 * Streams a raw video body into `post-videos/<uid>/<uuid>.<ext>` as the person (Storage's own rules
 * keep it in their folder), hashing it on the way and reading its length and frame size from the
 * container. Nothing is changed in the file. A file that is not a video, too long, or unreadable
 * is removed again and refused.
 */
export async function storeUploadedVideo(input: VideoUploadInput, fetchImpl: typeof fetch = fetch): Promise<UploadedVideo> {
  const { request } = input;
  const mime = (request.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  const declared = acceptedTypes.has(mime) ? videoContentTypeFor(mime) : undefined;
  if (!declared) throw new IntegrationError(415, 'unsupported_media_type', 'Send the video as the raw request body with Content-Type video/mp4, video/quicktime or video/webm.');
  const length = Number(request.headers.get('content-length') ?? '');
  if (!Number.isInteger(length) || length <= 0) throw new IntegrationError(411, 'length_required', 'Send the file with a Content-Length header.');
  if (length > maxVideoBytes) throw new IntegrationError(413, 'too_large', 'Videos can be up to 100 MB.');
  if (!request.body) throw new IntegrationError(400, 'bad_request', 'The request has no video in its body.');

  // Read the first bytes to check the container before anything is stored.
  const reader = request.body.getReader();
  const first: Uint8Array[] = [];
  let firstLength = 0;
  while (firstLength < 12) {
    const { done, value } = await reader.read();
    if (done) break;
    first.push(value);
    firstLength += value.length;
  }
  const head = joined(first, firstLength);
  const actual = contentTypeFromBytes(head);
  if (!actual || (actual === 'video/webm') !== (declared === 'video/webm')) {
    await reader.cancel().catch(() => undefined);
    throw new IntegrationError(415, 'unsupported_media_type', 'The file is not an MP4, MOV or WebM video, or does not match its Content-Type.');
  }

  const inspector = new VideoInspector(head);
  const hash = sha256.create();
  let seen = 0;
  const take = (chunk: Uint8Array) => {
    seen += chunk.length;
    if (seen > length) throw new IntegrationError(400, 'bad_request', 'The body is longer than its Content-Length.');
    inspector.push(chunk);
    hash.update(chunk);
  };
  let failure: unknown;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      try { for (const chunk of first) { take(chunk); controller.enqueue(chunk); } }
      catch (error) { failure = error; controller.error(error); }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (seen !== length) throw new IntegrationError(400, 'bad_request', 'The body is shorter than its Content-Length.');
          controller.close();
          return;
        }
        take(value);
        controller.enqueue(value);
      } catch (error) {
        failure = error;
        controller.error(error);
        await reader.cancel().catch(() => undefined);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });

  const base = input.supabaseUrl.replace(/\/$/, '');
  const path = `${input.userId}/${crypto.randomUUID()}.${videoExtension(declared)}`;
  const objectUrl = `${base}/storage/v1/object/${postVideoBucket}/${path}`;
  const headers = { apikey: input.publishableKey, authorization: `Bearer ${input.token}` };
  // Workers send a stream with a known length only through FixedLengthStream; Node needs duplex.
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  let uploadBody: ReadableStream<Uint8Array> = body;
  if (Fixed) {
    const fixed = new Fixed(length);
    body.pipeTo(fixed.writable).catch(() => undefined);
    uploadBody = fixed.readable;
  }
  let response: Response;
  try {
    response = await fetchImpl(objectUrl, {
      method: 'POST',
      headers: { ...headers, 'content-type': declared, 'cache-control': 'max-age=31536000', 'x-upsert': 'false' },
      body: uploadBody,
      duplex: 'half',
    } as RequestInit);
  } catch (error) {
    if (failure instanceof IntegrationError) throw failure;
    throw error;
  }
  if (failure instanceof IntegrationError) throw failure;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 413) throw new IntegrationError(413, 'too_large', 'Storage refused a file this large.');
    if (response.status === 401 || response.status === 403) throw new IntegrationError(403, 'refused', 'Storage refused this upload for this account.');
    throw new IntegrationError(502, 'upstream_unavailable', 'The video could not be stored. Try again shortly.');
  }
  await response.body?.cancel().catch(() => undefined);

  const remove = () => fetchImpl(`${base}/storage/v1/object/${postVideoBucket}`, { method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [path] }) }).catch(() => undefined);
  const hints = new URL(request.url).searchParams;
  const info = inspector.info();
  const durationSeconds = Math.round((info.durationSeconds ?? positive(hints.get('duration_ms')) / 1000) * 100) / 100;
  const width = info.width ?? positive(hints.get('width'));
  const height = info.height ?? positive(hints.get('height'));
  if (!(durationSeconds > 0) || !(width > 0) || !(height > 0) || width > 8192 || height > 8192) {
    await remove();
    throw new IntegrationError(422, 'unreadable_video', 'Open Media could not read this video’s length and frame size. Send an MP4 with a moov box, or add ?duration_ms=&width=&height=.');
  }
  if (durationSeconds > maxVideoSeconds) {
    await remove();
    throw new IntegrationError(400, 'too_long', `Videos can be up to ${maxVideoSeconds} seconds.`);
  }
  return {
    path, posterPath: null, durationSeconds, width: Math.round(width), height: Math.round(height), contentType: declared,
    sha256: [...hash.digest()].map((byte) => byte.toString(16).padStart(2, '0')).join(''), sizeBytes: length, url: postVideoPublicUrl(base, path),
  };
}

function positive(value: string | null): number {
  const number = Number(value ?? '');
  return Number.isFinite(number) && number > 0 ? number : Number.NaN;
}

function joined(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
