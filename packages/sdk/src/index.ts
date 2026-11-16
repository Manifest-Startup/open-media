/**
 * Open Media SDK: a typed client for the Open Media API.
 *
 * Public data (the mixed feed, cross-network search, posts, profiles, timelines and events) needs
 * no key. Account calls need the person's own access token, copied from the app (Settings, then
 * Developers and agents), and act only as that person.
 *
 * Apps that sign people in with "Sign in with Open Media" (OAuth) pass that access token with
 * `connected: true`: account calls then go to /v1/connected/me/… (ADR 0041).
 *
 * Docs: https://api.openmedia.site/docs
 */

export const defaultBaseUrl = 'https://api.openmedia.site';

export type Network = 'open-media' | 'farcaster' | 'lens' | 'hive' | 'deso' | 'bluesky' | 'mastodon' | 'nostr';
export type FeedMode = 'raw' | 'relevant';

export interface Post {
  id: string;
  network: Network;
  author: { name: string; handle: string; avatarUrl: string | null };
  title: string | null;
  text: string;
  createdAt: string;
  url: string | null;
  media: { type: 'image' | 'video'; url: string; posterUrl: string | null; durationSeconds: number | null; altText: string | null }[];
  engagement: { replies: number; reposts: number; likes: number } | null;
  why: { used: string[]; filters: string[]; notUsed: string[] };
  listing?: Record<string, unknown>;
}

/** A person's session from signing in with an email code. Keep both tokens private. */
export interface Session {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  user: { id: string; email?: string };
}

export interface FeedPage { data: Post[]; unavailable: string[]; nextCursor: string | null; next: string | null }

/** An integrated app's context on a conversation or post (ADR 0041). url must be on the app's own site. */
export interface AppContext { app: 'manifest'; idea_id?: string; title?: string; url?: string }

export interface ConversationSummary {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  context: AppContext | null;
  members: { id: string; handle: string | null; display_name: string; avatar_url: string | null }[];
  last_message: { id: string; body: string; sender_id: string; created_at: string } | null;
  unread_count: number;
  updated_at: string;
}

export interface ChatMessage { id: string; conversation_id: string; sender_id: string; body: string; created_at: string; reply_to_message_id: string | null }

/** What an upload returns; pass it back unchanged as `video` when publishing. */
export interface UploadedVideo { path: string; posterPath: null; durationSeconds: number; width: number; height: number; contentType: string; sha256: string; sizeBytes: number; url: string }

/** A public Open Media post as /v1/posts and app feeds return it. */
export interface AppPost {
  id: string;
  body: string;
  created_at: string;
  author: { id: string | null; handle: string; display_name: string; avatar_url: string | null };
  video: { url: string; poster_url: string | null; width: number | null; height: number | null; duration_ms: number | null } | null;
  context: AppContext | null;
  counts: { likes: number; comments: number; reshares: number };
  viewer?: { liked: boolean };
}

export interface AppFeedPage { data: AppPost[]; app: string; kind: 'feed' | 'clips'; nextCursor: string | null }

export interface RealtimeToken { supabase_url: string; anon_key: string; access_token: string; expires_at: number | null }

export interface OpenMediaOptions {
  /** API origin. Defaults to the public Open Media API. */
  baseUrl?: string;
  /** The person's access token, for account calls. */
  token?: string;
  /** A fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** How many times to retry a 429 after waiting Retry-After seconds (default 2). */
  maxRetries?: number;
  /** User-Agent suffix identifying your app or agent. */
  userAgent?: string;
  /** The token is a "Sign in with Open Media" OAuth access token: use /v1/connected/me/… for account calls. */
  connected?: boolean;
}

/** An API error with the server's machine-readable code. */
export class OpenMediaError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'OpenMediaError';
  }
}

export type Query = Record<string, string | number | undefined | null>;

export class OpenMedia {
  private readonly baseUrl: string;
  private token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly connected: boolean;

  constructor(options: OpenMediaOptions = {}) {
    this.connected = options.connected === true;
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 2;
    this.userAgent = ['open-media-sdk/0.2.0', options.userAgent].filter(Boolean).join(' ');
  }

  // ─── Public: no key ────────────────────────────────────────────────────────

  /** The mixed feed across Open Media and the open networks, with “why” reasons. */
  feed(options: { sources?: Network[]; mode?: FeedMode; kind?: 'feed' | 'clips'; cursor?: string } = {}): Promise<FeedPage> {
    return this.get('/v1/feed', { sources: options.sources?.join(','), mode: options.mode, kind: options.kind, cursor: options.cursor });
  }

  /** Plain-language search across public posts on every network, plus matching settings. */
  search(query: string): Promise<Record<string, unknown>> {
    return this.get('/v1/search', { q: query });
  }

  /** One app's public posts (kind clips: only videos), newest first, with context and counts. */
  appPosts(app: AppContext['app'], options: { kind?: 'feed' | 'clips'; cursor?: string } = {}): Promise<AppFeedPage> {
    return this.get('/v1/feed', { app, kind: options.kind, cursor: options.cursor });
  }

  /** One public Open Media post. */
  post(id: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/posts/${encodeURIComponent(id)}`);
  }

  /** A public Open Media profile with recent posts. */
  profile(handle: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/profiles/${encodeURIComponent(handle.replace(/^@/, ''))}`);
  }

  /** One person's public posts in one timeline. */
  timeline(network: Network, handle: string, cursor?: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/people/${network}/${encodeURIComponent(handle.replace(/^@/, ''))}`, { cursor });
  }

  /** Upcoming public events in the San Francisco Bay Area, with official registration links. */
  events(options: { area?: string; days?: number; query?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    return this.get('/v1/events/upcoming', { area: options.area, days: options.days, q: options.query, limit: options.limit });
  }

  /** Every network and exactly what works today. */
  networks(): Promise<Record<string, unknown>> {
    return this.get('/v1/networks');
  }

  /** Mission, principles, roadmap, honest status and every agent interface. */
  about(): Promise<Record<string, unknown>> {
    return this.get('/v1/about');
  }

  // ─── Signing a person in ───────────────────────────────────────────────────

  /** Step 1: Open Media emails the person a sign-in code (and creates an account for a new email). */
  requestSignInCode(email: string): Promise<{ sent: boolean; email: string; expires_in: number }> {
    return this.send('POST', '/v1/auth/email-code', { email });
  }

  /** Step 2: the code the person read from their email. The client then acts as them. */
  async signInWithCode(email: string, code: string): Promise<Session> {
    const session = await this.send<Session>('POST', '/v1/auth/verify', { email, code });
    this.token = session.access_token;
    return session;
  }

  /** Renews the session before expires_in runs out. */
  async refreshSession(refreshToken: string): Promise<Session> {
    const session = await this.send<Session>('POST', '/v1/auth/refresh', { refresh_token: refreshToken });
    this.token = session.access_token;
    return session;
  }

  async signOut(): Promise<void> {
    await this.send('POST', '/v1/auth/sign-out');
    this.token = undefined;
  }

  // ─── The person's account: needs their token ───────────────────────────────

  /** For a new account: the name and @handle the person chose. */
  setUpProfile(displayName: string, handle: string): Promise<Record<string, unknown>> {
    return this.send('PUT', '/v1/me/profile', { displayName, handle });
  }

  me(): Promise<Record<string, unknown>> {
    return this.get('/v1/me');
  }

  /**
   * Publishes a public post. Pass the same idempotencyKey when retrying. An app may attach a video
   * from uploadVideo (text may then be empty) and its context.
   */
  publish(text: string, options: { idempotencyKey?: string; video?: UploadedVideo; context?: AppContext } = {}): Promise<Record<string, unknown>> {
    const body = { text, ...(options.video ? { video: options.video } : {}), ...(options.context ? { context: options.context } : {}) };
    return this.send('POST', '/v1/me/posts', body, options.idempotencyKey);
  }

  /** Uploads a video (MP4, MOV or WebM, at most 100 MB) as the raw body. Pass the result to publish. */
  async uploadVideo(video: Blob | ArrayBuffer | Uint8Array, contentType: 'video/mp4' | 'video/quicktime' | 'video/webm'): Promise<UploadedVideo> {
    const result = await this.request<{ video: UploadedVideo }>('POST', '/v1/me/media/videos', {}, undefined, undefined, { body: video as BodyInit, contentType });
    return result.video;
  }

  likePost(id: string, liked = true): Promise<Record<string, unknown>> {
    return this.send(liked ? 'PUT' : 'DELETE', `/v1/me/posts/${encodeURIComponent(id)}/like`);
  }

  comments(postId: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/me/posts/${encodeURIComponent(postId)}/comments`);
  }

  comment(postId: string, text: string): Promise<Record<string, unknown>> {
    return this.send('POST', `/v1/me/posts/${encodeURIComponent(postId)}/comments`, { body: text });
  }

  /** Your feed; with app, only that app's posts, each with viewer.liked. */
  myFeed(options: { app?: AppContext['app']; kind?: 'feed' | 'clips'; cursor?: string; lens?: string } = {}): Promise<AppFeedPage | Record<string, unknown>> {
    return this.get('/v1/me/feed', { app: options.app, kind: options.kind, cursor: options.cursor, lens: options.lens });
  }

  deletePost(id: string): Promise<Record<string, unknown>> {
    return this.send('DELETE', `/v1/me/posts/${encodeURIComponent(id)}`);
  }

  /** Your conversations: `conversations` in the app shape (and `data`, the original). app keeps one app's. */
  conversations(options: { app?: AppContext['app'] } = {}): Promise<{ conversations: ConversationSummary[]; data: unknown[] }> {
    return this.get('/v1/me/conversations', { app: options.app });
  }

  /** Opens (or re-uses) the direct conversation with a handle; context is set only if it has none. */
  startConversation(handle: string, context?: AppContext): Promise<{ id: string; conversation: ConversationSummary | null }> {
    return this.send('POST', '/v1/me/conversations', { handle, ...(context ? { context } : {}) });
  }

  /** Messages, newest last. before is a message id or an ISO time. */
  messages(conversationId: string, options: { limit?: number; before?: string } = {}): Promise<{ messages: ChatMessage[] }> {
    return this.get(`/v1/me/conversations/${encodeURIComponent(conversationId)}/messages`, { limit: options.limit, before: options.before });
  }

  /** Sends a message. The same clientId (or idempotency key) makes a retry land once. */
  sendMessage(conversationId: string, text: string, options: { clientId?: string } = {}): Promise<{ sent: boolean; message: ChatMessage | null } & Record<string, unknown>> {
    return this.send('POST', `/v1/me/conversations/${encodeURIComponent(conversationId)}/messages`, { text, ...(options.clientId ? { client_id: options.clientId } : {}) }, options.clientId);
  }

  markRead(conversationId: string): Promise<Record<string, unknown>> {
    return this.send('POST', `/v1/me/conversations/${encodeURIComponent(conversationId)}/read`);
  }

  /** The person's own short-lived session for Supabase Realtime (messages they can read). */
  realtimeToken(): Promise<RealtimeToken> {
    return this.send('POST', '/v1/me/realtime-token');
  }

  /** Offers a product or service as a public post with a price, e.g. price "25" or "25.50". */
  publishListing(listing: { kind: 'product' | 'service'; title: string; price?: string; currency?: string; location?: string; remote?: boolean; text?: string }, options: { idempotencyKey?: string } = {}): Promise<Record<string, unknown>> {
    return this.send('POST', '/v1/me/listings', listing, options.idempotencyKey);
  }

  /** Publishes a post with a free preview and a paid part. priceMinor is in cents. */
  publishPaidPost(post: { preview: string; paidText: string; priceMinor: number; currency?: string }, options: { idempotencyKey?: string } = {}): Promise<Record<string, unknown>> {
    return this.send('POST', '/v1/me/paid-posts', post, options.idempotencyKey);
  }

  /** The person's payments, payout setup and whether this server is in test mode. */
  paymentSetup(): Promise<Record<string, unknown>> {
    return this.get('/v1/me/payments/setup');
  }

  payments(limit = 50): Promise<unknown[]> {
    return this.get('/v1/me/payments', { limit });
  }

  /**
   * Starts a payment. Show the person who is paid, the amount and the fees first (getPaymentOptions)
   * and only call this once they agreed. Card returns checkoutUrl for them to open; USDC returns the
   * transfer for their own wallet. Nothing is paid until Stripe or the network confirms it.
   */
  startPayment(payment: { contextType: 'listing' | 'tip' | 'paid_post'; contextId: string; rail: 'card' | 'onchain'; chain?: 'base' | 'base-sepolia'; amountMinor?: number }, options: { idempotencyKey?: string } = {}): Promise<Record<string, unknown>> {
    return this.send('POST', '/v1/me/payments', payment, options.idempotencyKey);
  }

  getPaymentOptions(postId: string, kind: 'listing' | 'post' = 'listing'): Promise<Record<string, unknown>> {
    return this.get(kind === 'listing' ? `/v1/me/listings/${encodeURIComponent(postId)}/payment-options` : `/v1/me/posts/${encodeURIComponent(postId)}/payment-options`);
  }

  payment(id: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/me/payments/${encodeURIComponent(id)}`);
  }

  exportData(): Promise<Record<string, unknown>> {
    return this.get('/v1/me/export');
  }

  /**
   * Any REST route, for what the helpers above don't cover: `api('GET', '/v1/me/follows')`. With
   * `connected`, /v1/me/… goes to /v1/connected/me/… as usual. Retries 429s and sends an
   * Idempotency-Key on writes, like every other call.
   */
  api<T = unknown>(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    if (!path.startsWith('/')) throw new TypeError('path must start with /, e.g. /v1/feed');
    return this.request<T>(method.toUpperCase(), path, options.query ?? {}, options.body);
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  private get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  private send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>(method, path, {}, body, idempotencyKey);
  }

  private async request<T>(method: string, path: string, query: Query, body?: unknown, idempotencyKey?: string, raw?: { body: BodyInit; contentType: string }): Promise<T> {
    // Account routes for an OAuth-connected app (ADR 0041).
    const routed = this.connected && (path === '/v1/me' || path.startsWith('/v1/me/')) ? `/v1/connected${path.slice(3)}` : path;
    const url = new URL(`${this.baseUrl}${routed}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (raw) headers['content-type'] = raw.contentType;
    // A write gets one key for all its retries, so a retry never creates a second post or payment.
    if (method !== 'GET') headers['idempotency-key'] = idempotencyKey ?? globalThis.crypto.randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(url, { method, headers, body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      const payload = text ? safeJson(text) : null;
      if (response.ok) return payload as T;
      const retryAfter = Number(response.headers.get('retry-after') ?? '') || undefined;
      if (response.status === 429 && attempt < this.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, (retryAfter ?? 1) * 1000));
        continue;
      }
      // Account routes answer {error: {code, message}}; /v1/connected and OAuth answer {error, error_description}.
      const problem = payload as { error?: { code?: string; message?: string } | string; error_description?: string } | null;
      const error = problem?.error;
      const code = typeof error === 'object' && error?.code ? error.code : typeof error === 'string' ? error : `http_${response.status}`;
      const message = typeof error === 'object' && error?.message ? error.message : problem?.error_description ?? (typeof error === 'string' ? error : `Open Media answered ${response.status}.`);
      throw new OpenMediaError(response.status, code, message, retryAfter);
    }
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Checks an Open Media webhook (ADR 0041): the signature over `${timestamp}.${rawBody}` with your
 * secret, and a timestamp within five minutes. Pass the raw body exactly as received. Dedupe on the
 * body's `id` yourself.
 */
export async function verifyWebhook(secret: string, headers: { get(name: string): string | null }, rawBody: string, options: { toleranceSeconds?: number; now?: number } = {}): Promise<boolean> {
  const timestamp = Number(headers.get('x-open-media-timestamp'));
  const signature = headers.get('x-open-media-signature') ?? '';
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  const expected = `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return difference === 0;
}
