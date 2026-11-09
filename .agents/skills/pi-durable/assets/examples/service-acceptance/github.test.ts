import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { GitHubEventError, parseWebhook, pollPullRequests, type PollState } from '../src/github.js';

const repository = 'Acme/Widget';
const sha = 'a'.repeat(40);
const initial = (): PollState => ({ initialized: false, seen: [] });
const pr = (number: number, created = number) => ({
  number, title: `PR ${number}`, html_url: `https://github.com/acme/widget/pull/${number}`,
  head: { sha }, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, created)).toISOString(),
  body: `Description ${number}`, state: 'open',
});

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  // Ephemeral test servers can reuse ports while Undici still holds a socket
  // from the previous closed fixture. Do not pool these short-lived connections.
  const instance = createServer((request,response)=>{response.setHeader('connection','close');handler(request,response);});
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return {
    apiBase: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      instance.closeAllConnections(); instance.close(error => error ? reject(error) : resolve());
    }),
  };
}

function send(res: ServerResponse, rows: unknown, headers: Record<string, string> = {}) {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(rows));
}

function next(req: IncomingMessage, page: number) {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  url.searchParams.set('page', String(page));
  return `<${url.href}>; rel="next"`;
}

function payload(number = 1) {
  return { action: 'opened', number, repository: { full_name: repository }, pull_request: pr(number) };
}

function signed(value: unknown, secret = 'fixture-only') {
  const raw = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { raw, headers: {
    event: 'pull_request', delivery: 'fixture-delivery',
    signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
  } };
}

test('baseline suppresses existing PRs and records a bounded checkpoint', async () => {
  const api = await server((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    assert.equal(url.pathname, '/repos/acme/widget/pulls');
    assert.equal(url.searchParams.get('state'), 'all');
    assert.equal(url.searchParams.get('sort'), 'created');
    assert.equal(url.searchParams.get('direction'), 'desc');
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    send(res, [pr(3), pr(2), pr(1)], { etag: '"first"', 'x-poll-interval': '120' });
  });
  try {
    const state = initial();
    const result = await pollPullRequests({ repository, state, apiBase: api.apiBase, token: 'fixture-token' });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.state.seen, [3]);
    assert.equal(result.state.minPollIntervalSeconds, 120);
    assert.equal(result.state.etag, '"first"');
    assert.deepEqual(state, initial());
  } finally { await api.close(); }
});

test('poll detects a PR opened and closed before polling', async () => {
  const api = await server((_req, res) => send(res, [{ ...pr(2), state: 'closed' }, pr(1)]));
  try {
    const state: PollState = { initialized: true, seen: [1], watermark: pr(1).created_at, boundary: [1] };
    const result = await pollPullRequests({ repository, state, apiBase: api.apiBase });
    assert.deepEqual(result.events.map(x => x.number), [2]);
    assert.equal(result.events[0].id, 'github:acme/widget:pull_request:2:opened');
    assert.equal(result.events[0].body, 'Description 2');
  } finally { await api.close(); }
});

test('enqueue initial scan follows pagination and returns chronological events', async () => {
  const conditionals: (string | string[] | undefined)[] = [];
  const api = await server((req, res) => {
    conditionals.push(req.headers['if-none-match']);
    const page = new URL(req.url!, 'http://localhost').searchParams.get('page');
    if (!page) send(res, [pr(4), pr(3)], { link: next(req, 2), etag: '"page-one"' });
    else send(res, [pr(2), pr(1)], { etag: '"page-two"' });
  });
  try {
    const result = await pollPullRequests({ repository, state: initial(), initialScan: 'enqueue', apiBase: api.apiBase });
    assert.deepEqual(result.events.map(x => x.number), [1, 2, 3, 4]);
    assert.equal(result.state.etag, '"page-one"');
    assert.deepEqual(conditionals, [undefined, undefined]);
  } finally { await api.close(); }
});

test('conditional header applies only to the first page after a checkpoint', async () => {
  const conditionals: (string | string[] | undefined)[] = [];
  const api = await server((req, res) => {
    conditionals.push(req.headers['if-none-match']);
    if (conditionals.length === 1) send(res, [pr(4), pr(3)], { link: next(req, 2), etag: '"new"' });
    else send(res, [pr(2), pr(1)]);
  });
  try {
    const state: PollState = { initialized: true, seen: [1], watermark: pr(1).created_at, etag: '"old"' };
    const result = await pollPullRequests({ repository, state, apiBase: api.apiBase });
    assert.deepEqual(result.events.map(x => x.number), [2, 3, 4]);
    assert.deepEqual(conditionals, ['"old"', undefined]);
  } finally { await api.close(); }
});

test('304 keeps the checkpoint and has no events', async () => {
  const api = await server((req, res) => {
    assert.equal(req.headers['if-none-match'], '"etag"');
    res.writeHead(304); res.end();
  });
  try {
    const state: PollState = { initialized: true, seen: [1], watermark: pr(1).created_at, etag: '"etag"' };
    const result = await pollPullRequests({ repository, state, apiBase: api.apiBase });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.state.seen, [1]);
    assert.equal(result.state.watermark, state.watermark);
    assert.notEqual(result.state.seen, state.seen);
  } finally { await api.close(); }
});

test('page limit fails without advancing state or returning a partial batch', async () => {
  const api = await server((req, res) => send(res, [pr(3)], { link: next(req, 2), etag: '"uncommitted"' }));
  try {
    const state = initial();
    await assert.rejects(pollPullRequests({ repository, state, initialScan: 'enqueue', apiBase: api.apiBase, maxPages: 1 }),
      (error: GitHubEventError) => error.code === 'catchup_limit' && error.statusCode === 409);
    assert.deepEqual(state, initial());
  } finally { await api.close(); }
});

test('same-second boundary protects new PRs and works across pages', async () => {
  const api = await server((req, res) => {
    const page = new URL(req.url!, 'http://localhost').searchParams.get('page');
    if (!page) send(res, [pr(4, 2), pr(3, 2)], { link: next(req, 2) });
    else send(res, [pr(2, 2), pr(1, 1)]);
  });
  try {
    const state: PollState = { initialized: true, seen: [2], watermark: pr(2, 2).created_at, boundary: [2] };
    const result = await pollPullRequests({ repository, state, apiBase: api.apiBase });
    assert.deepEqual(result.events.map(x => x.number), [3, 4]);
    assert.deepEqual(result.state.boundary, [2, 3, 4]);
  } finally { await api.close(); }
});

test('baseline scans all records at the newest timestamp before stopping', async () => {
  let requests = 0;
  const api = await server((req, res) => {
    if (++requests === 1) send(res, [pr(4, 2), pr(3, 2)], { link: next(req, 2) });
    else send(res, [pr(2, 2), pr(1, 1)], { link: next(req, 3) });
  });
  try {
    const result = await pollPullRequests({ repository, state: initial(), apiBase: api.apiBase });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.state.boundary, [2, 3, 4]);
    assert.equal(requests, 2);
  } finally { await api.close(); }
});

test('empty repository can later discover its first PR', async () => {
  let empty = true;
  const api = await server((_req, res) => send(res, empty ? [] : [pr(1)]));
  try {
    const baseline = await pollPullRequests({ repository, state: initial(), apiBase: api.apiBase });
    assert.equal(baseline.state.initialized, true);
    empty = false;
    const result = await pollPullRequests({ repository, state: baseline.state, apiBase: api.apiBase });
    assert.deepEqual(result.events.map(x => x.number), [1]);
  } finally { await api.close(); }
});

test('later-page failure never commits a new ETag or watermark', async () => {
  const api = await server((req, res) => {
    if (!new URL(req.url!, 'http://localhost').searchParams.has('page')) {
      send(res, [pr(3)], { link: next(req, 2), etag: '"new"' });
    } else { res.writeHead(503); res.end('failure'); }
  });
  try {
    const state: PollState = { initialized: true, seen: [1], watermark: pr(1).created_at, etag: '"old"' };
    const before = structuredClone(state);
    await assert.rejects(pollPullRequests({ repository, state, apiBase: api.apiBase }),
      (error: GitHubEventError) => error.status === 503 && error.retryable);
    assert.deepEqual(state, before);
  } finally { await api.close(); }
});

test('stalled response body times out without changing checkpoint and a later scan succeeds', { timeout: 5000 }, async () => {
  let stalled = true;
  let headersArrived = false;
  const api = await server((req, res) => {
    if (!new URL(req.url!, 'http://localhost').searchParams.has('page')) {
      send(res, [pr(3)], { link: next(req, 2), etag: '"new"' });
    } else if (stalled) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('['); headersArrived = true; // Headers arrive, but this body never ends.
    } else send(res, [pr(2), pr(1)]);
  });
  try {
    const state: PollState = { initialized: true, seen: [1], watermark: pr(1).created_at, etag: '"old"' };
    const before = structuredClone(state);
    await assert.rejects(pollPullRequests({ repository, state, apiBase: api.apiBase, timeoutMs: 250 }),
      (error: GitHubEventError) => error.code === 'poll_timeout' && error.status === 504 && error.retryable);
    assert.equal(headersArrived, true);
    assert.deepEqual(state, before);
    stalled = false;
    const result = await pollPullRequests({ repository, state, apiBase: api.apiBase });
    assert.deepEqual(result.events.map(x => x.number), [2, 3]);
    assert.equal(result.state.etag, '"new"');
    assert.deepEqual(state, before);
  } finally { await api.close(); }
});

test('stalled HTTP error body is covered by the poll deadline', { timeout: 5000 }, async () => {
  const api = await server((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' }); res.write('incomplete error');
  });
  try {
    const state = initial();
    await assert.rejects(pollPullRequests({ repository, state, apiBase: api.apiBase, timeoutMs: 250 }),
      (error: GitHubEventError) => error.code === 'poll_timeout' && error.retryable);
    assert.deepEqual(state, initial());
  } finally { await api.close(); }
});

test('caller shutdown aborts body consumption with the original reason', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const reason = new Error('Fixture shutdown');
  const api = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('[');
  });
  try {
    const state = initial();
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      setImmediate(() => controller.abort(reason)); // Abort after fetch delivered the response headers.
      return response;
    };
    await assert.rejects(pollPullRequests({ repository, state, apiBase: api.apiBase, fetch: fetcher, signal: controller.signal, timeoutMs: 2000 }),
      error => error === reason);
    assert.deepEqual(state, initial());
  } finally { await api.close(); }
});

test('invalid poll deadlines are refused before fetching', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; throw new Error('Unexpected request'); };
  for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(pollPullRequests({ repository, state: initial(), fetch: fetcher, timeoutMs }),
      (error: GitHubEventError) => error.code === 'invalid_options');
  }
  assert.equal(requests, 0);
});

test('rate limit honors Retry-After', async () => {
  const api = await server((_req, res) => { res.writeHead(429, { 'retry-after': '120' }); res.end('{}'); });
  try {
    const now = Date.now();
    await assert.rejects(pollPullRequests({ repository, state: initial(), apiBase: api.apiBase }),
      (error: GitHubEventError) => error.code === 'rate_limited' && error.retryable &&
        Date.parse(error.retryAt!) >= now + 119_000);
  } finally { await api.close(); }
});

test('primary rate limit honors reset time', async () => {
  const reset = Math.floor(Date.now() / 1000) + 300;
  const api = await server((_req, res) => {
    res.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }); res.end('{}');
  });
  try {
    await assert.rejects(pollPullRequests({ repository, state: initial(), apiBase: api.apiBase }),
      (error: GitHubEventError) => error.code === 'rate_limited' && Date.parse(error.retryAt!) === reset * 1000);
  } finally { await api.close(); }
});

test('permission failure is not treated as transient or rate limited', async () => {
  const api = await server((_req, res) => { res.writeHead(404); res.end('{}'); });
  try {
    await assert.rejects(pollPullRequests({ repository, state: initial(), apiBase: api.apiBase }),
      (error: GitHubEventError) => error.status === 404 && !error.retryable);
  } finally { await api.close(); }
});

test('unsafe pagination fails before any token can be forwarded', async () => {
  let requests = 0;
  const api = await server((_req, res) => {
    requests++; send(res, [pr(2)], { link: '<https://example.invalid/token-capture>; rel="next"' });
  });
  try {
    await assert.rejects(pollPullRequests({ repository, state: initial(), initialScan: 'enqueue', apiBase: api.apiBase, token: 'fixture-token' }),
      (error: GitHubEventError) => error.code === 'invalid_pagination');
    assert.equal(requests, 1);
  } finally { await api.close(); }
});

test('invalid GitHub payload rejects the whole batch', async () => {
  const api = await server((_req, res) => send(res, [pr(2), { ...pr(1), head: {} }]));
  try {
    const state = initial();
    await assert.rejects(pollPullRequests({ repository, state, initialScan: 'enqueue', apiBase: api.apiBase }),
      (error: GitHubEventError) => error.code === 'invalid_response');
    assert.deepEqual(state, initial());
  } finally { await api.close(); }
});

test('webhook and polling produce the same semantic task key', async () => {
  const message = signed(payload());
  const webhook = parseWebhook(message.raw, message.headers, 'fixture-only');
  const api = await server((_req, res) => send(res, [pr(1)]));
  try {
    const result = await pollPullRequests({ repository, state: initial(), initialScan: 'enqueue', apiBase: api.apiBase });
    assert.equal(webhook?.id, result.events[0].id);
    assert.equal(webhook?.deliveryId, 'fixture-delivery');
    assert.equal(webhook?.repository, 'acme/widget');
  } finally { await api.close(); }
});

test('signed unsupported webhook actions and event types are ignored', () => {
  const closed = signed({ ...payload(), action: 'closed' });
  assert.equal(parseWebhook(closed.raw, closed.headers, 'fixture-only'), null);
  const ping = signed({ zen: 'Keep it logically awesome.' });
  assert.equal(parseWebhook(ping.raw, { ...ping.headers, event: 'ping' }, 'fixture-only'), null);
});

test('webhook verifies raw unicode bytes and rejects tampering', () => {
  const data = payload(); data.pull_request.title = 'Fixture: café / 日本語';
  const message = signed(data);
  assert.equal(parseWebhook(message.raw, message.headers, 'fixture-only')?.title, data.pull_request.title);
  assert.throws(() => parseWebhook(Buffer.concat([message.raw, Buffer.from(' ')]), message.headers, 'fixture-only'),
    (error: GitHubEventError) => error.code === 'invalid_signature' && error.status === 401);
});

test('webhook rejects missing, short, and mismatched signatures without a length error', () => {
  const message = signed(payload());
  for (const signature of [undefined, 'sha256=00', 'sha256=' + '0'.repeat(64)]) {
    assert.throws(() => parseWebhook(message.raw, { ...message.headers, signature }, 'fixture-only'),
      (error: GitHubEventError) => error.code === 'invalid_signature');
  }
  assert.throws(() => parseWebhook(message.raw, message.headers, ''),
    (error: GitHubEventError) => error.code === 'webhook_disabled' && error.status === 503);
});

test('signed malformed JSON and inconsistent PR payloads fail with HTTP 400', () => {
  for (const data of ['{broken', { ...payload(), number: 99 }, { ...payload(), repository: {} },
    { ...payload(), pull_request: { ...pr(1), html_url: 'javascript:alert(1)' } }]) {
    const message = signed(data);
    assert.throws(() => parseWebhook(message.raw, message.headers, 'fixture-only'),
      (error: GitHubEventError) => error.status === 400);
  }
});

test('invalid repository paths and checkpoints are refused before fetching', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; throw new Error('Unexpected request'); };
  for (const name of ['../widget', 'acme/..', 'acme/widget/extra', 'https://github.com/acme/widget']) {
    await assert.rejects(pollPullRequests({ repository: name, state: initial(), fetch: fetcher }),
      (error: GitHubEventError) => error.code === 'invalid_repository');
  }
  await assert.rejects(pollPullRequests({ repository, state: { initialized: true, seen: [0] }, fetch: fetcher }),
    (error: GitHubEventError) => error.code === 'invalid_state');
  assert.equal(requests, 0);
});
