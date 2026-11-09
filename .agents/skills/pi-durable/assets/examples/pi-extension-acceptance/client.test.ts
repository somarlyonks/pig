// Run with npm test. Test state stays inside the project artifacts directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { DurableClient, DurableClientError, DurableSendError, loadConnections, type ServiceConnection } from '../src/client.js';

const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);
const artifactRoot = resolve(process.cwd(), '../artifacts/extension-client-tests');
async function temporary() {
  await mkdir(artifactRoot, { recursive: true });
  const path = await mkdtemp(join(artifactRoot, 'case-'));
  return { path, async close() { assert.ok(resolve(path).startsWith(artifactRoot + sep)); await rm(path, { recursive: true, force: true }); } };
}
async function jsonFile(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
function json(response: ServerResponse, value: unknown, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
async function body(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const temp = await temporary();
  await writeFile(join(temp.path, 'console-token'), tokenA);
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => { if (!response.headersSent) json(response, {}, 500); else response.end(); }); });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const connection: ServiceConnection = { id: 'test-service', name: 'Test Service', configPath: join(temp.path, 'config.json'), dataDir: temp.path, baseUrl: `http://127.0.0.1:${address.port}` };
  return { connection, async close() { server.closeAllConnections(); await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); await temp.close(); } };
}

test('configuration discovers nearest project file and resolves each path from its owner', async () => {
  const temp = await temporary();
  try {
    const root = join(temp.path, 'project with spaces');
    const service = join(root, 'services', 'agent host', 'config.local.json');
    await jsonFile(service, { version: 1, host: '127.0.0.1', port: 4792, dataDir: '../../state directory', provider: { kind: 'openai-codex', model: 'gpt-6.1-sol' } });
    const connections = join(root, '.pi', 'durable-agents.json');
    await jsonFile(connections, { version: 1, services: [{ id: 'pilot', name: 'My Agents', configPath: '../services/agent host/config.local.json' }] });
    const cwd = join(root, 'nested', 'deep'); await mkdir(cwd, { recursive: true });
    const result = await loadConnections({ cwd, env: {} });
    assert.equal(result.configPath, connections);
    assert.deepEqual(result.connections, [{ id: 'pilot', name: 'My Agents', configPath: service, dataDir: join(root, 'state directory'), baseUrl: 'http://127.0.0.1:4792' }]);
    // Native path handling must preserve drive letters and spaces on Windows.
    if (process.platform === 'win32') assert.match(result.connections[0].configPath, /^[A-Za-z]:\\/);
  } finally { await temp.close(); }
});

test('explicit configuration wins over discovery and a missing explicit file fails', async () => {
  const temp = await temporary();
  try {
    await jsonFile(join(temp.path, '.pi', 'durable-agents.json'), { version: 1, services: [] });
    await jsonFile(join(temp.path, 'custom.json'), { version: 1, services: [] });
    assert.equal((await loadConnections({ cwd: temp.path, env: { PI_DURABLE_CONNECTIONS: 'custom.json' } })).configPath, join(temp.path, 'custom.json'));
    await assert.rejects(loadConnections({ cwd: temp.path, env: { PI_DURABLE_CONNECTIONS: 'missing.json' } }), (error: unknown) => error instanceof DurableClientError && error.code === 'config_unavailable' && !error.message.includes(temp.path));
    await assert.rejects(loadConnections({ cwd: temp.path, env: { PI_DURABLE_CONNECTIONS: ' ' } }), { code: 'config_invalid' });
  } finally { await temp.close(); }
});

test('configuration rejects non-loopback hosts, injected credentials, duplicate IDs, and URL connections', async () => {
  const temp = await temporary();
  try {
    const servicePath = join(temp.path, 'service.json');
    const path = join(temp.path, 'connections.json');
    const entry = { id: 'pilot', configPath: './service.json' };
    const good = { version: 1, host: '127.0.0.1', port: 4792, dataDir: './state' };
    await jsonFile(path, { version: 1, services: [entry] });
    for (const extra of [{ host: '0.0.0.0' }, { host: 'localhost' }, { host: '127.0.0.1.evil.test' }, { token: tokenA }, { authorization: `Bearer ${tokenA}` }, { port: 0 }, { port: 65536 }]) {
      await jsonFile(servicePath, { ...good, ...extra });
      await assert.rejects(loadConnections({ cwd: temp.path, env: { PI_DURABLE_CONNECTIONS: path } }), { code: 'config_invalid' });
    }
    await jsonFile(servicePath, good);
    for (const services of [[entry, entry], [{ id: 'pilot', configPath: './service.json', url: 'http://user:secret@127.0.0.1:4792' }], [{ id: 'pilot', configPath: './service.json', token: tokenA }]]) {
      await jsonFile(path, { version: 1, services });
      await assert.rejects(loadConnections({ cwd: temp.path, env: { PI_DURABLE_CONNECTIONS: path } }), { code: 'config_invalid' });
    }
  } finally { await temp.close(); }
});

test('invalid JSON and oversized configuration errors never include source content', async () => {
  const temp = await temporary();
  try {
    const path = join(temp.path, 'connections.json');
    for (const text of [`{"secret":"${tokenA}"`, 'x'.repeat(300_000)]) {
      await writeFile(path, text);
      await assert.rejects(loadConnections({ cwd: temp.path, env: { PI_DURABLE_CONNECTIONS: path } }), (error: unknown) => error instanceof DurableClientError && error.code === 'config_invalid' && !error.message.includes(tokenA));
    }
  } finally { await temp.close(); }
});

test('extension fallback loads when discovery is absent', async () => {
  const temp = await temporary();
  try {
    const extensionDir = join(temp.path, 'extension');
    await jsonFile(join(extensionDir, 'durable-agents.json'), { version: 1, services: [] });
    // Discovery at the drive/filesystem root avoids inheriting the real repository connection file.
    assert.equal((await loadConnections({ cwd: parse(temp.path).root, extensionDir, env: {} })).configPath, join(extensionDir, 'durable-agents.json'));
  } finally { await temp.close(); }
});

test('token rotates per request; authorization and redirect restrictions are enforced', async () => {
  const seen: string[] = [];
  const host = await fixture((request, response) => { seen.push(request.headers.authorization ?? ''); json(response, { agents: [{ id: 'agent-one', name: 'Agent One' }] }); });
  try {
    const client = new DurableClient(host.connection);
    await client.list();
    await writeFile(join(host.connection.dataDir, 'console-token'), tokenB);
    await client.list();
    assert.deepEqual(seen, [`Bearer ${tokenA}`, `Bearer ${tokenB}`]);
    await writeFile(join(host.connection.dataDir, 'console-token'), 'secret-that-must-not-leak');
    await assert.rejects(client.list(), (error: unknown) => error instanceof DurableClientError && error.code === 'token_unavailable' && !error.message.includes('secret-that-must-not-leak'));
    assert.equal(seen.length, 2);
  } finally { await host.close(); }
});

test('client rejects arbitrary URLs even if caller bypasses the loader', async () => {
  const temp = await temporary();
  try {
    const base: ServiceConnection = { id: 'pilot', name: 'Pilot', configPath: join(temp.path, 'config.json'), dataDir: temp.path, baseUrl: 'http://127.0.0.1:4792' };
    for (const baseUrl of ['http://example.com:4792', 'http://user:secret@127.0.0.1:4792', 'https://127.0.0.1:4792', 'http://127.0.0.1:4792/path', 'http://127.0.0.1:4792/?token=secret', 'http://127.0.0.1:4792/#secret']) assert.throws(() => new DurableClient({ ...base, baseUrl }), { code: 'config_invalid' });
  } finally { await temp.close(); }
});

test('status unsupported on an older host does not break agent listing', async () => {
  const host = await fixture((request, response) => request.url === '/v1/status' ? json(response, { error: tokenA }, 404) : json(response, { agents: [{ id: 'agent-one', name: 'Agent One' }] }));
  try {
    const client = new DurableClient(host.connection);
    assert.deepEqual(await client.status(), { supported: false });
    assert.equal((await client.list()).agents[0].id, 'agent-one');
  } finally { await host.close(); }
});

test('redirect is not followed and HTTP errors never expose response bodies', async () => {
  let redirected = 0;
  const host = await fixture((request, response) => {
    if (request.url === '/v1/status') { response.writeHead(302, { Location: '/stolen' }); response.end(); return; }
    if (request.url === '/stolen') redirected++;
    json(response, { error: `private ${tokenA}` }, 401);
  });
  try {
    const client = new DurableClient(host.connection);
    await assert.rejects(client.status(), (error: unknown) => error instanceof DurableClientError && error.code === 'network_error' && !error.message.includes(tokenA));
    assert.equal(redirected, 0);
    await assert.rejects(client.list(), (error: unknown) => error instanceof DurableClientError && error.status === 401 && !error.message.includes(tokenA));
  } finally { await host.close(); }
});

test('both declared and streamed response sizes are bounded', async () => {
  let requests = 0;
  const host = await fixture((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'application/json', ...(requests === 1 ? { 'Content-Length': '2048' } : {}) });
    response.end('x'.repeat(2048));
  });
  try {
    const client = new DurableClient(host.connection, { maxResponseBytes: 1024 });
    await assert.rejects(client.list(), { code: 'response_too_large' });
    await assert.rejects(client.list(), { code: 'response_too_large' });
  } finally { await host.close(); }
});

test('request timeout covers slow response bodies', async () => {
  const host = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); });
  try { await assert.rejects(new DurableClient(host.connection, { requestTimeoutMs: 50 }).list(), { code: 'request_timeout' }); }
  finally { await host.close(); }
});

test('ambiguous admission retries once with the same stable request ID', async () => {
  const requests: Array<Record<string, unknown>> = [];
  let stored = false;
  const host = await fixture(async (request, response) => {
    const value = await body(request); requests.push(value);
    if (!stored) { stored = true; request.socket.destroy(); return; }
    json(response, { conversationId: 7, submissionId: 9 }, 202);
  });
  try {
    const receipt = await new DurableClient(host.connection).admit('agent-one', 'Hello');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].requestId, requests[1].requestId);
    assert.match(receipt.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(receipt.requestId, requests[0].requestId);
    assert.equal(receipt.submissionId, 9);
  } finally { await host.close(); }
});

test('admission retries are bounded and preserve recovery request ID on failure', async () => {
  let attempts = 0;
  const host = await fixture(request => { attempts++; request.socket.destroy(); });
  try {
    await assert.rejects(new DurableClient(host.connection).admit('agent-one', 'Hello', { requestId: 'stable-test-request' }), (error: unknown) => error instanceof DurableSendError && error.requestId === 'stable-test-request' && error.code === 'network_error' && !error.receipt);
    assert.equal(attempts, 2);
  } finally { await host.close(); }
});

test('admission HTTP errors are not retried', async () => {
  let attempts = 0;
  const host = await fixture((_request, response) => { attempts++; json(response, { error: tokenA }, 409); });
  try {
    await assert.rejects(new DurableClient(host.connection).admit('agent-one', 'Hello'), (error: unknown) => error instanceof DurableSendError && error.status === 409 && !error.message.includes(tokenA));
    assert.equal(attempts, 1);
  } finally { await host.close(); }
});

test('send waits for completion and preserves agent/job addressing', async () => {
  const paths: string[] = [];
  let polls = 0;
  const host = await fixture(async (request, response) => {
    paths.push(request.url ?? '');
    if (request.method === 'POST') { assert.equal((await body(request)).whenBusy, 'steer'); json(response, { conversationId: 7, submissionId: 9 }, 202); return; }
    json(response, ++polls > 1 ? { status: 'done', text: 'The completed answer.' } : { status: 'pending' });
  });
  try {
    const result = await new DurableClient(host.connection).send('agent-one', 'Hello', { requestId: 'stable-request', jobId: 'github:owner/repo:1:agent-one', whenBusy: 'steer', pollIntervalMs: 5 });
    assert.equal(result.submission.text, 'The completed answer.');
    assert.equal(result.receipt.submissionId, 9);
    assert.equal(result.requestId, 'stable-request');
    assert.ok(paths.every(path => path.startsWith('/v1/agents/agent-one/') && path.endsWith('?jobId=github%3Aowner%2Frepo%3A1%3Aagent-one')));
  } finally { await host.close(); }
});

test('unanswered is a terminal result without an implicit retry', async () => {
  let polls = 0;
  const host = await fixture((_request, response) => { polls++; json(response, { status: 'unanswered', reason: 'Conversation cancelled.' }); });
  try {
    const result = await new DurableClient(host.connection).wait('agent-one', { conversationId: 7, submissionId: 9, requestId: 'request' });
    assert.equal(result.status, 'unanswered');
    assert.equal(polls, 1);
  } finally { await host.close(); }
});

test('cancelling a wait preserves receipt and never calls abort', async () => {
  const paths: string[] = [];
  const controller = new AbortController();
  const host = await fixture((request, response) => {
    paths.push(request.url ?? '');
    if (request.method === 'POST') json(response, { conversationId: 7, submissionId: 9 }, 202);
    else { json(response, { status: 'pending' }); controller.abort(); }
  });
  try {
    await assert.rejects(new DurableClient(host.connection).send('agent-one', 'Hello', { signal: controller.signal, requestId: 'known-request', pollIntervalMs: 5 }), (error: unknown) => error instanceof DurableSendError && error.code === 'cancelled' && error.receipt?.submissionId === 9 && error.requestId === 'known-request');
    assert.ok(paths.some(path => path.includes('/submissions/9')));
    assert.ok(paths.every(path => !path.includes('/abort')));
  } finally { await host.close(); }
});

test('wait limit preserves admitted work and never calls abort', async () => {
  const paths: string[] = [];
  const host = await fixture((request, response) => { paths.push(request.url ?? ''); json(response, { status: 'pending' }); });
  try {
    const receipt = { conversationId: 7, submissionId: 9, requestId: 'known-request' };
    await assert.rejects(new DurableClient(host.connection).wait('agent-one', receipt, { waitTimeoutMs: 40, pollIntervalMs: 5 }), (error: unknown) => error instanceof DurableSendError && error.code === 'wait_timeout' && error.receipt === receipt);
    assert.ok(paths.length > 0);
    assert.ok(paths.every(path => !path.includes('/abort')));
  } finally { await host.close(); }
});

test('explicit abort, jobs, snapshot and evidence use bounded service routes', async () => {
  const paths: string[] = [];
  const host = await fixture((request, response) => {
    paths.push(request.url ?? '');
    if (request.url?.includes('/jobs')) json(response, { jobs: [{ id: 'job', status: 'done' }] });
    else if (request.url?.includes('/chat')) json(response, { conversation: { id: 1 }, entries: [] });
    else if (request.url?.includes('/evidence')) json(response, { records: [{ id: 'evidence' }] });
    else json(response, { aborted: true });
  });
  try {
    const client = new DurableClient(host.connection);
    assert.equal((await client.jobs('agent-one')).jobs[0].id, 'job');
    assert.equal((await client.snapshot('agent-one', { jobId: 'job' })).conversation.id, 1);
    assert.equal((await client.evidence('agent-one', { limit: 7 })).records[0].id, 'evidence');
    assert.equal((await client.abort('agent-one', { jobId: 'job' })).aborted, true);
    assert.ok(paths.includes('/v1/agents/agent-one/abort?jobId=job'));
    await assert.rejects(client.jobs('../other-agent'), { code: 'input_invalid' });
    await assert.rejects(client.evidence('agent-one', { limit: 10001 }), { code: 'input_invalid' });
    assert.equal(paths.length, 4);
  } finally { await host.close(); }
});
