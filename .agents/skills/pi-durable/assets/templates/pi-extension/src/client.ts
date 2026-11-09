// Check with npm run check; Pi loads TypeScript directly. Uses Node.js and the service HTTP API.
import { randomUUID } from 'node:crypto';
import { open, access } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface ServiceConnection {
  id: string;
  name: string;
  configPath: string;
  dataDir: string;
  baseUrl: string;
}
export interface ConnectionLoadResult { connections: ServiceConnection[]; configPath?: string }
export interface LoadConnectionsOptions { cwd: string; extensionDir?: string; env?: Record<string, string | undefined> }
export type DurableErrorCode = 'config_invalid' | 'config_unavailable' | 'token_unavailable' | 'request_failed' | 'response_too_large' | 'invalid_response' | 'request_timeout' | 'cancelled' | 'network_error' | 'wait_timeout' | 'input_invalid';
export class DurableClientError extends Error {
  constructor(readonly code: DurableErrorCode, message: string, readonly status?: number) { super(message); this.name = 'DurableClientError'; }
}
export interface RequestOptions { signal?: AbortSignal }
export interface ConversationOptions extends RequestOptions { jobId?: string }
export type WhenBusy = 'followUp' | 'steer' | 'reject';
export interface AdmissionOptions extends ConversationOptions { requestId?: string; whenBusy?: WhenBusy }
export interface WaitOptions extends ConversationOptions { waitTimeoutMs?: number; pollIntervalMs?: number }
export interface SendOptions extends AdmissionOptions, WaitOptions {}
export interface AdmissionReceipt { conversationId: number; submissionId: number; requestId: string }
export interface SubmissionRecord { status: string; text?: string; reason?: string; [key: string]: unknown }
export interface SendResult { receipt: AdmissionReceipt; submission: SubmissionRecord; requestId: string }
export class DurableSendError extends DurableClientError {
  constructor(error: DurableClientError, readonly requestId: string, readonly receipt?: AdmissionReceipt) {
    super(error.code, error.message, error.status); this.name = 'DurableSendError';
  }
}
export interface DurableAgent { id: string; name: string; active?: number | boolean; [key: string]: unknown }
export interface DurableJob { id: string; agentId?: string; status: string; event?: Record<string, unknown>; result?: string; error?: string; [key: string]: unknown }
export interface DurableSnapshot { conversation: { id: number; [key: string]: unknown }; entries: Array<Record<string, unknown>>; [key: string]: unknown }
export interface ClientOptions { fetch?: typeof fetch; requestTimeoutMs?: number; maxResponseBytes?: number }

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function configError() { return new DurableClientError('config_invalid', 'The durable connection configuration is invalid. Use version 1 with local service config paths.'); }
function inputError() { return new DurableClientError('input_invalid', 'The durable request arguments are invalid.'); }
async function boundedFile(path: string, limit: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw configError();
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}
async function present(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new DurableClientError('config_unavailable', 'The durable connection configuration cannot be read.'); }
}
/** Discover explicit configuration first, then the nearest project configuration. No credentials are accepted here. */
export async function loadConnections(options: LoadConnectionsOptions): Promise<ConnectionLoadResult> {
  const cwd = resolve(options.cwd);
  const explicit = (options.env ?? process.env).PI_DURABLE_CONNECTIONS;
  let configPath: string | undefined;
  if (explicit !== undefined) {
    if (!explicit.trim()) throw configError();
    configPath = resolve(cwd, explicit);
  } else {
    let cursor = cwd;
    while (true) {
      const candidate = join(cursor, '.pi', 'durable-agents.json');
      if (await present(candidate)) { configPath = candidate; break; }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!configPath && options.extensionDir) {
      const candidate = resolve(options.extensionDir, 'durable-agents.json');
      if (await present(candidate)) configPath = candidate;
    }
  }
  if (!configPath) return { connections: [] };
  try {
    const value: unknown = JSON.parse(await boundedFile(configPath, MAX_CONFIG_BYTES));
    if (!record(value) || value.version !== 1 || !Array.isArray(value.services) || value.services.length > 32 || Object.keys(value).some(key => !['version', 'services'].includes(key))) throw configError();
    const ids = new Set<string>();
    const connections: ServiceConnection[] = [];
    for (const entry of value.services) {
      if (!record(entry) || typeof entry.id !== 'string' || !ID.test(entry.id) || ids.has(entry.id) || typeof entry.configPath !== 'string' || !entry.configPath.trim() || entry.configPath.length > 4096 || Object.keys(entry).some(key => !['id', 'name', 'configPath'].includes(key))) throw configError();
      if (entry.name !== undefined && (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 120 || /[\r\n\x00-\x1f]/.test(entry.name))) throw configError();
      // Resolve each service path against the connections file, and its state against the service config.
      const target = resolve(dirname(configPath), entry.configPath);
      const service: unknown = JSON.parse(await boundedFile(target, MAX_CONFIG_BYTES));
      if (!record(service) || service.version !== 1 || service.host !== '127.0.0.1' || !Number.isInteger(service.port) || Number(service.port) < 1 || Number(service.port) > 65535 || typeof service.dataDir !== 'string' || !service.dataDir.trim() || service.dataDir.length > 4096) throw configError();
      if (['url', 'baseUrl', 'token', 'authorization', 'username', 'password'].some(key => key in service)) throw configError();
      ids.add(entry.id);
      connections.push({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id, configPath: target, dataDir: resolve(dirname(target), service.dataDir), baseUrl: `http://127.0.0.1:${service.port}` });
    }
    return { connections, configPath };
  } catch (error) {
    if (error instanceof DurableClientError) throw error;
    if ((error as NodeJS.ErrnoException).code) throw new DurableClientError('config_unavailable', 'A durable connection configuration or service config cannot be read.');
    throw configError();
  }
}

function validConnection(connection: ServiceConnection) {
  try {
    const url = new URL(connection.baseUrl);
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(connection.baseUrl) || Number(url.port || '80') < 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !isAbsolute(connection.dataDir)) throw configError();
  } catch { throw configError(); }
}
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function agentPath(agentId: string) { if (!ID.test(agentId)) throw inputError(); return `/v1/agents/${agentId}`; }
function conversationSuffix(options: ConversationOptions) {
  if (options.jobId === undefined) return '';
  if (typeof options.jobId !== 'string' || !options.jobId || options.jobId.length > 4096) throw inputError();
  return `?jobId=${encodeURIComponent(options.jobId)}`;
}
function safeError(error: unknown): DurableClientError {
  return error instanceof DurableClientError ? error : new DurableClientError('network_error', 'The local durable service could not be reached.');
}
function cancelled() { return new DurableClientError('cancelled', 'Waiting was cancelled. The durable task continues in the service.'); }
async function pause(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
  await new Promise<void>((accept, reject) => {
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); accept(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class DurableClient {
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  constructor(readonly connection: ServiceConnection, options: ClientOptions = {}) {
    validConnection(connection);
    this.fetcher = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (!positiveInteger(this.requestTimeoutMs) || this.requestTimeoutMs > 60_000 || !positiveInteger(this.maxResponseBytes) || this.maxResponseBytes > MAX_RESPONSE_BYTES) throw inputError();
  }
  private async request(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    validConnection(this.connection);
    if (options.signal?.aborted) throw cancelled();
    let token: string;
    try {
      token = (await boundedFile(join(this.connection.dataDir, 'console-token'), 256)).trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error();
    } catch { throw new DurableClientError('token_unavailable', 'The local service console token is unavailable or invalid.'); }
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(this.connection.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DurableClientError('request_failed', `The local durable service request failed (HTTP ${response.status}).`, response.status);
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > this.maxResponseBytes)) {
        await response.body?.cancel();
        throw new DurableClientError('response_too_large', 'The local durable service response exceeds the size limit.');
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.length;
            if (length > this.maxResponseBytes) {
              await reader.cancel();
              throw new DurableClientError('response_too_large', 'The local durable service response exceeds the size limit.');
            }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new DurableClientError('invalid_response', 'The local durable service returned an invalid JSON response.'); }
    } catch (error) {
      if (options.signal?.aborted) throw cancelled();
      if (timeout.aborted) throw new DurableClientError('request_timeout', 'The local durable service request timed out.');
      throw safeError(error);
    }
  }
  async list(options: RequestOptions = {}): Promise<{ agents: DurableAgent[]; mode?: string }> {
    const value = await this.request('/v1/agents', undefined, options);
    if (!record(value) || !Array.isArray(value.agents) || value.agents.some(agent => !record(agent) || typeof agent.id !== 'string' || !ID.test(agent.id) || typeof agent.name !== 'string')) throw new DurableClientError('invalid_response', 'The local durable service returned an invalid agent list.');
    return value as unknown as { agents: DurableAgent[]; mode?: string };
  }
  async status(options: RequestOptions = {}): Promise<Record<string, unknown> & { supported: boolean }> {
    try {
      const value = await this.request('/v1/status', undefined, options);
      if (!record(value)) throw new DurableClientError('invalid_response', 'The local durable service returned an invalid status.');
      return { ...value, supported: true };
    } catch (error) { if (error instanceof DurableClientError && error.status === 404) return { supported: false }; throw error; }
  }
  async jobs(agentId: string, options: RequestOptions = {}): Promise<{ jobs: DurableJob[] }> {
    const value = await this.request(agentPath(agentId) + '/jobs', undefined, options);
    if (!record(value) || !Array.isArray(value.jobs) || value.jobs.some(job => !record(job) || typeof job.id !== 'string' || typeof job.status !== 'string')) throw new DurableClientError('invalid_response', 'The local durable service returned an invalid job list.');
    return value as unknown as { jobs: DurableJob[] };
  }
  async snapshot(agentId: string, options: ConversationOptions = {}): Promise<DurableSnapshot> {
    const value = await this.request(agentPath(agentId) + '/chat' + conversationSuffix(options), undefined, options);
    if (!record(value) || !record(value.conversation) || !positiveInteger(value.conversation.id) || !Array.isArray(value.entries)) throw new DurableClientError('invalid_response', 'The local durable service returned an invalid conversation.');
    return value as unknown as DurableSnapshot;
  }
  async admit(agentId: string, content: string, options: AdmissionOptions = {}): Promise<AdmissionReceipt> {
    if (typeof content !== 'string' || !content.trim() || content.length > 100_000) throw inputError();
    const requestId = options.requestId ?? randomUUID();
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 512 || !['followUp', 'steer', 'reject'].includes(options.whenBusy ?? 'followUp')) throw inputError();
    const path = agentPath(agentId) + '/messages' + conversationSuffix(options);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = await this.request(path, { content, requestId, whenBusy: options.whenBusy ?? 'followUp' }, options);
        if (!record(value) || !positiveInteger(value.conversationId) || !positiveInteger(value.submissionId)) throw new DurableClientError('invalid_response', 'The local durable service returned an invalid admission receipt.');
        return { conversationId: value.conversationId, submissionId: value.submissionId, requestId };
      } catch (error) {
        const failure = safeError(error);
        if (attempt === 0 && ['network_error', 'request_timeout'].includes(failure.code) && !options.signal?.aborted) continue;
        throw new DurableSendError(failure, requestId);
      }
    }
    throw new DurableSendError(new DurableClientError('network_error', 'The local durable service could not be reached.'), requestId);
  }
  async submission(agentId: string, submissionId: number, options: ConversationOptions = {}): Promise<SubmissionRecord> {
    if (!positiveInteger(submissionId)) throw inputError();
    const value = await this.request(agentPath(agentId) + `/submissions/${submissionId}` + conversationSuffix(options), undefined, options);
    if (!record(value) || typeof value.status !== 'string') throw new DurableClientError('invalid_response', 'The local durable service returned an invalid submission.');
    return value as SubmissionRecord;
  }
  async wait(agentId: string, receipt: AdmissionReceipt, options: WaitOptions = {}): Promise<SubmissionRecord> {
    const waitTimeoutMs = options.waitTimeoutMs ?? 120_000;
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    if (!positiveInteger(waitTimeoutMs) || waitTimeoutMs > 30 * 60_000 || !positiveInteger(pollIntervalMs) || pollIntervalMs > 60_000 || !positiveInteger(receipt.submissionId)) throw inputError();
    const deadline = AbortSignal.timeout(waitTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      while (true) {
        const value = await this.submission(agentId, receipt.submissionId, { ...options, signal });
        if (value.status === 'done' || value.status === 'unanswered') return value;
        await pause(pollIntervalMs, signal);
      }
    } catch (error) {
      const failure = options.signal?.aborted ? cancelled() : deadline.aborted ? new DurableClientError('wait_timeout', 'The wait limit was reached. The durable task continues; reconnect using the submission ID.') : safeError(error);
      throw new DurableSendError(failure, receipt.requestId, receipt);
    }
  }
  async send(agentId: string, content: string, options: SendOptions = {}): Promise<SendResult> {
    const receipt = await this.admit(agentId, content, options);
    const submission = await this.wait(agentId, receipt, options);
    return { receipt, submission, requestId: receipt.requestId };
  }
  async abort(agentId: string, options: ConversationOptions & {background?:boolean} = {}): Promise<{ aborted: boolean }> {
    if(options.background!==undefined&&typeof options.background!=='boolean')throw inputError();
    const value = await this.request(agentPath(agentId) + '/abort' + conversationSuffix(options), options.background?{background:true}:{}, options);
    if (!record(value) || value.aborted !== true) throw new DurableClientError('invalid_response', 'The local durable service returned an invalid cancellation receipt.');
    return { aborted: true };
  }
  async evidence(agentId: string, options: RequestOptions & { limit?: number } = {}): Promise<{ records: Record<string, unknown>[] }> {
    const limit = options.limit ?? 100;
    if (!positiveInteger(limit) || limit > 10_000) throw inputError();
    const value = await this.request(agentPath(agentId) + `/evidence?limit=${limit}`, undefined, options);
    if (!record(value) || !Array.isArray(value.records) || value.records.some(entry => !record(entry))) throw new DurableClientError('invalid_response', 'The local durable service returned invalid evidence.');
    return value as { records: Record<string, unknown>[] };
  }
}
