import { createHmac, timingSafeEqual } from 'node:crypto';

export type AgentEvent = {
  id: string;
  type: 'pull_request.opened';
  repository: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  createdAt: string;
  body?: string;
  deliveryId?: string;
};

export type PollState = {
  initialized: boolean;
  seen: number[];
  etag?: string;
  watermark?: string;
  boundary?: number[];
  minPollIntervalSeconds?: number;
};

export class GitHubEventError extends Error {
  readonly statusCode: number;
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
    readonly retryAt?: string,
  ) {
    super(message);
    this.name = 'GitHubEventError';
    this.statusCode = status;
  }
}

type PollOptions = {
  repository: string;
  token?: string;
  apiBase?: string;
  state: PollState;
  initialScan?: 'baseline' | 'enqueue';
  fetch?: typeof fetch;
  signal?: AbortSignal;
  maxPages?: number;
  /** Whole-repository deadline, including every page and response body. */
  timeoutMs?: number;
};

function repositoryName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value) ||
      value.split('/').some(part => part === '.' || part === '..')) {
    throw new GitHubEventError('Expected repository in owner/name form.', 'invalid_repository', 400);
  }
  return value.toLowerCase();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubEventError('Expected an object in the GitHub payload.', 'invalid_payload', 400);
  }
  return value as Record<string, unknown>;
}

function pullEvent(value: unknown, repository: string, deliveryId?: string): AgentEvent {
  const pr = object(value);
  const head = object(pr.head);
  if (!Number.isSafeInteger(pr.number) || Number(pr.number) <= 0 ||
      typeof pr.title !== 'string' || typeof pr.html_url !== 'string' ||
      typeof head.sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head.sha) ||
      typeof pr.created_at !== 'string' || !Number.isFinite(Date.parse(pr.created_at)) ||
      (pr.body != null && typeof pr.body !== 'string')) {
    throw new GitHubEventError('Invalid pull request fields in the GitHub payload.', 'invalid_payload', 400);
  }
  let url: URL;
  try { url = new URL(pr.html_url); } catch {
    throw new GitHubEventError('Invalid pull request URL.', 'invalid_payload', 400);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new GitHubEventError('Unsupported pull request URL.', 'invalid_payload', 400);
  }
  return {
    id: `github:${repository}:pull_request:${pr.number}:opened`,
    type: 'pull_request.opened', repository, number: Number(pr.number),
    title: pr.title, url: pr.html_url, headSha: head.sha,
    createdAt: new Date(pr.created_at).toISOString(),
    ...(pr.body == null ? {} : { body: pr.body as string }),
    ...(deliveryId ? { deliveryId } : {}),
  };
}

/** Authenticate the original bytes before parsing. Delivery IDs are audit data, not task IDs. */
export function parseWebhook(
  raw: Buffer,
  headers: { delivery?: string; event?: string; signature?: string },
  secret: string,
): AgentEvent | null {
  if (!secret) throw new GitHubEventError('Webhook secret is not configured.', 'webhook_disabled', 503);
  if (!headers.signature || !/^sha256=[a-f0-9]{64}$/i.test(headers.signature)) {
    throw new GitHubEventError('Missing or invalid webhook signature.', 'invalid_signature', 401);
  }
  const actual = Buffer.from(headers.signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new GitHubEventError('Webhook signature did not match.', 'invalid_signature', 401);
  }
  if (!headers.event) throw new GitHubEventError('Missing GitHub event header.', 'invalid_payload', 400);
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(raw.toString('utf8'))); } catch (error) {
    if (error instanceof GitHubEventError) throw error;
    throw new GitHubEventError('Webhook body must be valid JSON.', 'invalid_payload', 400);
  }
  if (headers.event !== 'pull_request' || payload.action !== 'opened') return null;
  const repository = repositoryName(object(payload.repository).full_name);
  const event = pullEvent(payload.pull_request, repository, headers.delivery);
  if (payload.number !== event.number) {
    throw new GitHubEventError('Webhook pull request numbers do not match.', 'invalid_payload', 400);
  }
  return event;
}

function retryTime(response: Response, now = Date.now()): string {
  const value = response.headers.get('retry-after');
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  const retry = value && /^\d+(?:\.\d+)?$/.test(value)
    ? now + Number(value) * 1000 : value ? Date.parse(value) : NaN;
  return new Date(Math.max(now + 1000, Number.isFinite(retry) ? retry :
    response.headers.get('x-ratelimit-remaining') === '0' && reset > now ? reset : now + 60_000)).toISOString();
}

async function responseError(response: Response): Promise<GitHubEventError> {
  // Do not echo remote bodies, which may contain repository content or proxies' diagnostics.
  const text = await response.text();
  const limited = response.status === 429 || response.status === 403 && (
    response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0' ||
    /rate limit/i.test(text));
  return new GitHubEventError(
    limited ? 'GitHub rate limit reached.' : `GitHub request failed with HTTP ${response.status}.`,
    limited ? 'rate_limited' : 'github_http_error', response.status,
    limited || response.status >= 500, limited ? retryTime(response) : undefined,
  );
}

function nextPage(link: string | null, current: URL, first: URL): URL | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (!match || !match[2].split(' ').includes('next')) continue;
    const next = new URL(match[1], current);
    // Never forward credentials to a different host or unrelated endpoint.
    if (next.origin !== first.origin || next.pathname !== first.pathname ||
        next.username || next.password || next.searchParams.get('state') !== 'all' ||
        next.searchParams.get('sort') !== 'created' || next.searchParams.get('direction') !== 'desc' ||
        next.searchParams.get('per_page') !== '100') {
      throw new GitHubEventError('Unsafe or incompatible GitHub pagination URL.', 'invalid_pagination', 502);
    }
    return next;
  }
  return undefined;
}

/** Return a new checkpoint only after a complete scan. Persist it atomically with events. */
export async function pollPullRequests(options: PollOptions): Promise<{ events: AgentEvent[]; state: PollState }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new GitHubEventError('timeoutMs must be finite, positive, and at most 2147483647.', 'invalid_options', 400);
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('GitHub poll deadline expired.', 'TimeoutError')), timeoutMs);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    signal.throwIfAborted();
    return await scanPullRequests({ ...options, signal });
  } catch (error) {
    // Body consumption may surface AbortError or a parser error; classify the
    // cancellation at the whole-scan boundary, preserving caller shutdown.
    if (options.signal?.aborted) throw options.signal.reason;
    if (deadline.signal.aborted) throw new GitHubEventError('GitHub poll deadline expired; checkpoint was not advanced.', 'poll_timeout', 504, true);
    throw error;
  } finally { clearTimeout(timer); }
}

async function scanPullRequests(options: PollOptions): Promise<{ events: AgentEvent[]; state: PollState }> {
  const repository = repositoryName(options.repository);
  const state = options.state;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new GitHubEventError('maxPages must be an integer from 1 to 10000.', 'invalid_options', 400);
  }
  if (typeof state.initialized !== 'boolean' || !Array.isArray(state.seen) ||
      state.seen.some(n => !Number.isSafeInteger(n) || n <= 0) ||
      state.boundary !== undefined && (!Array.isArray(state.boundary) ||
        state.boundary.some(n => !Number.isSafeInteger(n) || n <= 0)) ||
      state.watermark && !Number.isFinite(Date.parse(state.watermark))) {
    throw new GitHubEventError('Invalid GitHub poll checkpoint.', 'invalid_state', 400);
  }
  const base = new URL(options.apiBase ?? 'https://api.github.com');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) {
    throw new GitHubEventError('Invalid GitHub API base URL.', 'invalid_options', 400);
  }
  const first = new URL(`${base.pathname.replace(/\/$/, '')}/repos/${repository}/pulls`, base.origin);
  first.search = new URLSearchParams({ state: 'all', sort: 'created', direction: 'desc', per_page: '100' }).toString();
  const fetcher = options.fetch ?? fetch;
  const collected = new Map<number, AgentEvent>();
  const visited = new Set<string>();
  const oldWatermark = state.watermark ? Date.parse(state.watermark) : undefined;
  const baseline = !state.initialized && options.initialScan !== 'enqueue';
  let newest = oldWatermark;
  let boundary = new Set(state.boundary ?? state.seen);
  let etag: string | undefined;
  let minPollIntervalSeconds = state.minPollIntervalSeconds;
  let url: URL | undefined = first;
  let pages = 0;
  let done = false;

  while (url) {
    if (++pages > maxPages || visited.has(url.href)) {
      throw new GitHubEventError('GitHub catch-up scan is incomplete; increase maxPages or narrow the source before retrying. Checkpoint was not advanced.',
        'catchup_limit', 409);
    }
    visited.add(url.href);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10',
      'user-agent': 'pi-durable-service-template',
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    // An ETag describes page one only. Never apply it to later pages.
    if (pages === 1 && state.initialized && state.etag) headers['if-none-match'] = state.etag;
    let response: Response;
    try { response = await fetcher(url, { headers, signal: options.signal }); } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new GitHubEventError('GitHub request could not complete.', 'network_error', 503, true);
    }
    const interval = Number(response.headers.get('x-poll-interval'));
    if (Number.isFinite(interval) && interval > 0) minPollIntervalSeconds = interval;
    if (response.status === 304) {
      if (pages !== 1 || !state.initialized || !state.etag) {
        throw new GitHubEventError('Unexpected conditional response from GitHub.', 'invalid_response', 502);
      }
      return { events: [], state: { ...state, seen: [...state.seen], minPollIntervalSeconds } };
    }
    if (!response.ok) throw await responseError(response);
    if (pages === 1) etag = response.headers.get('etag') ?? undefined;
    let rows: unknown;
    try { rows = await response.json(); } catch {
      throw new GitHubEventError('GitHub returned invalid JSON.', 'invalid_response', 502, true);
    }
    if (!Array.isArray(rows)) throw new GitHubEventError('GitHub returned a non-array pull request list.', 'invalid_response', 502);
    for (const row of rows) {
      let event: AgentEvent;
      try { event = pullEvent(row, repository); } catch {
        throw new GitHubEventError('GitHub returned an invalid pull request.', 'invalid_response', 502);
      }
      const created = Date.parse(event.createdAt);
      if (newest === undefined || created > newest) {
        newest = created;
        boundary = new Set();
      }
      if (created === newest) boundary.add(event.number);
      if (oldWatermark !== undefined && created < oldWatermark) done = true;
      if (baseline && newest !== undefined && created < newest) done = true;
      if (!baseline && (oldWatermark === undefined ? !state.seen.includes(event.number) :
          created > oldWatermark || created === oldWatermark && !(state.boundary ?? state.seen).includes(event.number))) {
        collected.set(event.number, event);
      }
    }
    if (done) break;
    url = nextPage(response.headers.get('link'), url, first);
  }
  // Boundary IDs protect multiple PRs created in the same second. Fail explicitly rather than truncate.
  if (boundary.size > 10_000) throw new GitHubEventError('GitHub checkpoint boundary is too large.', 'catchup_limit', 409);
  const ids = [...boundary].sort((a, b) => a - b);
  return {
    events: [...collected.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number),
    state: { initialized: true, seen: ids, boundary: ids, etag,
      ...(newest === undefined ? {} : { watermark: new Date(newest).toISOString() }),
      ...(minPollIntervalSeconds ? { minPollIntervalSeconds } : {}) },
  };
}
