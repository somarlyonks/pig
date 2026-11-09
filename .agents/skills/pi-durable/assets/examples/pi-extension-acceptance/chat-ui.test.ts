// Exercise the real Pi editor and Markdown renderer with an in-memory terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { initTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, getKeybindings, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import {
  DurableChatView, type ChatMemory, type ChatMessage, type ChatProgress,
  type ChatReply, type ChatRequest, type ChatViewOptions,
} from '../src/chat-ui.js';

initTheme('dark', false);
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const keys = { enter: '\r', escape: '\x1b', cancel: '\x03', retry: '\x12', pageUp: '\x1b[5~', pageDown: '\x1b[6~', latest: '\x1b[1;5F', newline: '\x1b\r' };

interface ExchangeCall {
  request: ChatRequest;
  signal: AbortSignal;
  progress: (value: ChatProgress) => void;
  resolve: (reply: ChatReply) => void;
  reject: (error: unknown) => void;
}
function fixture(input: { rows?: number; draft?: string; messages?: ChatMessage[]; jobId?: string } = {}) {
  const terminal = { rows: input.rows ?? 24 };
  let renders = 0, closes = 0, nextId = 0;
  const calls: ExchangeCall[] = [];
  const memory: ChatMemory = { draft: input.draft ?? '' };
  const external = new AbortController();
  const tui = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
  const options: ChatViewOptions = {
    target: 'local/repo-quality', agentName: 'Repo quality', jobId: input.jobId,
    conversationId: 7, model: 'openai-codex/gpt-6.1-sol', messages: input.messages ?? [], memory,
    signal: external.signal, createRequestId: () => `request-${++nextId}`,
    exchange: (request, signal, progress) => new Promise((resolve, reject) => { calls.push({ request, signal, progress, resolve, reject }); }),
    describeError: error => ({ message: error instanceof Error ? error.message : 'Local request failed' }),
  };
  const view = new DurableChatView(tui, plainTheme, getKeybindings(), () => { closes++; }, options);
  const frame = (width = 80) => view.render(width);
  const text = (width = 80) => frame(width).map(line => stripVTControlCharacters(line)).join('\n');
  return { view, memory, terminal, calls, external, frame, text, counts: () => ({ renders, closes }) };
}
function reply(call: ExchangeCall, text = 'FINAL_RESPONSE'): ChatReply {
  return { text, status: 'done', receipt: call.request.receipt ?? { conversationId: 7, submissionId: 42, requestId: call.request.requestId } };
}
async function settle() { await new Promise<void>(accept => setImmediate(accept)); }

test('real Markdown and editor stay within terminal rows and visible columns across widths', () => {
  const text = [
    '# Result 進捗 👩🏽‍💻', '**Ready** to continue.',
    '| Item | Status |', '| --- | --- |', '| 作業 | ✅ done |',
    '```ts', `const address = "https://example.test/${'long-path-'.repeat(16)}";`, '```',
    'A paragraph '.repeat(35),
  ].join('\n');
  for (const width of [40, 80, 120]) for (const rows of [1, 2, 4, 7, 12, 24]) {
    const f = fixture({ rows, draft: 'Follow-up 質問 👋', messages: [{ id: 'answer', role: 'assistant', text }] });
    f.view.focused = true;
    const lines = f.frame(width);
    assert.ok(lines.length > 0 && lines.length <= rows, `${width} columns / ${rows} rows`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `Overflow at ${width}x${rows}: ${visibleWidth(line)}`);
    assert.equal(lines.filter(line => line.includes(CURSOR_MARKER)).length, 1, `Missing visible editor cursor at ${width}x${rows}`);
    f.view.dispose();
  }
});

test('header identifies selected target, task, conversation and model at normal narrow width', () => {
  const f = fixture({ jobId: 'job-17' });
  const frame = f.text(40);
  assert.match(frame, /local\/repo-quality/);
  assert.match(frame, /Task job-17/);
  assert.match(frame, /Conversation 7/);
  assert.match(frame, /gpt-6\.1-sol/);
  assert.equal(f.calls.length, 0, 'Opening or rendering must not send messages');
  f.view.dispose();
});

test('focus forwards to the real editor and cropped multiline drafts retain one IME cursor', () => {
  const f = fixture({ rows: 7, draft: Array.from({ length: 30 }, (_, index) => `Draft line ${index} 中文`).join('\n') });
  assert.equal(f.view.focused, false);
  assert.equal(f.frame(40).some(line => line.includes(CURSOR_MARKER)), false);
  f.view.focused = true;
  assert.equal(f.view.focused, true);
  assert.equal(f.frame(40).filter(line => line.includes(CURSOR_MARKER)).length, 1);
  f.view.handleInput(' final');
  assert.match(f.memory.draft, /Draft line 29 中文 final$/);
  f.view.dispose();
  assert.match(f.memory.draft, /Draft line 29 中文 final$/);
});

test('Enter preserves message whitespace while empty drafts and backslash-newline do not submit', () => {
  const blank = fixture({ draft: '   ' });
  blank.view.handleInput(keys.enter);
  assert.equal(blank.calls.length, 0);
  assert.equal(blank.memory.draft, '   ');
  blank.view.dispose();

  const f = fixture({ draft: '  first line\\' });
  f.view.handleInput(keys.enter);
  assert.equal(f.calls.length, 0);
  assert.equal(f.memory.draft, '  first line\n');
  f.view.handleInput('second line  ');
  f.view.handleInput(keys.enter);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.message, '  first line\nsecond line  ');
  assert.equal(f.memory.draft, '');
  f.view.dispose();
});

test('Shift+Enter composes a newline without sending', () => {
  const f = fixture({ draft: 'First' });
  f.view.handleInput(keys.newline);
  f.view.handleInput('Second');
  assert.equal(f.memory.draft, 'First\nSecond');
  assert.equal(f.calls.length, 0);
  f.view.dispose();
});

test('busy typing and Enter keep the next draft rather than clearing it or sending twice', async () => {
  const f = fixture({ draft: 'Original request' });
  f.view.handleInput(keys.enter);
  const first = f.calls[0];
  f.view.handleInput('A later question');
  f.view.handleInput(keys.enter);
  assert.equal(f.calls.length, 1);
  assert.equal(f.memory.draft, 'A later question');
  assert.match(f.text(120), /Your draft is kept/);
  first.resolve(reply(first));
  await settle();
  assert.equal(f.memory.draft, 'A later question');
  f.view.handleInput(keys.enter);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].request.message, 'A later question');
  f.view.dispose();
});

test('failed waits preserve the request, receipt and new draft for stable Ctrl+R resume', async () => {
  const f = fixture({ draft: 'Original request' });
  f.view.handleInput(keys.enter);
  const first = f.calls[0];
  const receipt = { conversationId: 7, submissionId: 81, requestId: first.request.requestId };
  first.request.receipt = receipt;
  f.view.handleInput('Keep this draft');
  first.reject(new Error('Connection interrupted'));
  await settle();
  assert.equal(f.memory.draft, 'Keep this draft');
  assert.equal(f.memory.pending, first.request);
  assert.match(f.memory.error ?? '', /Connection interrupted/);
  f.view.handleInput(keys.retry);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].request, first.request);
  assert.equal(f.calls[1].request.requestId, 'request-1');
  assert.equal(f.calls[1].request.receipt, receipt);
  f.calls[1].resolve(reply(f.calls[1]));
  await settle();
  assert.equal(f.memory.pending, undefined);
  assert.equal(f.memory.error, undefined);
  assert.equal(f.memory.draft, 'Keep this draft');
  f.view.dispose();
});

test('an ambiguous admission keeps original content and request ID for one retry', async () => {
  const f = fixture({ draft: '  Important request with whitespace  ' });
  f.view.handleInput(keys.enter);
  const first = f.calls[0];
  first.reject(new Error('Admission response was interrupted'));
  await settle();
  assert.equal(f.memory.pending?.message, '  Important request with whitespace  ');
  assert.equal(f.memory.pending?.receipt, undefined);
  f.view.handleInput(keys.retry);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].request.requestId, first.request.requestId);
  assert.equal(f.calls[1].request.message, first.request.message);
  f.calls[1].resolve(reply(f.calls[1]));
  await settle();
  assert.equal(f.text(120).split('Important request with whitespace').length - 1, 1);
  f.view.dispose();
});

test('history stays paused across live progress and completion until the user requests latest', async () => {
  const messages = Array.from({ length: 45 }, (_, index): ChatMessage => ({ id: String(index), role: 'assistant', text: `ROW_${String(index).padStart(2, '0')} historical content` }));
  const f = fixture({ rows: 24, draft: 'Question', messages });
  f.frame(80);
  f.view.handleInput(keys.enter);
  f.frame(80);
  f.view.handleInput(keys.pageUp);
  const earlier = f.text(80);
  const firstVisible = earlier.match(/ROW_\d+/)?.[0];
  assert.ok(firstVisible, 'PageUp should show earlier transcript messages');
  f.calls[0].progress({ status: 'Working', text: 'LIVE_TAIL_RESPONSE' });
  assert.equal(f.text(80).match(/ROW_\d+/)?.[0], firstVisible);
  f.calls[0].resolve(reply(f.calls[0], 'FINAL_TAIL_RESPONSE'));
  await settle();
  assert.equal(f.text(80).match(/ROW_\d+/)?.[0], firstVisible);
  assert.doesNotMatch(f.text(80), /FINAL_TAIL_RESPONSE/);
  f.view.handleInput(keys.latest);
  assert.match(f.text(80), /FINAL_TAIL_RESPONSE/);
  f.view.dispose();
});

test('Ctrl+C stops only the local operation and retains the receipt for retry', async () => {
  const f = fixture({ draft: 'Question' });
  f.view.handleInput(keys.enter);
  const first = f.calls[0];
  first.request.receipt = { conversationId: 7, submissionId: 91, requestId: first.request.requestId };
  f.view.handleInput('Unsent next draft');
  f.view.handleInput(keys.cancel);
  assert.equal(first.signal.aborted, true);
  assert.equal(f.counts().closes, 0);
  assert.equal(f.memory.pending?.receipt?.submissionId, 91);
  assert.equal(f.memory.draft, 'Unsent next draft');
  assert.match(f.memory.error ?? '', /locally.*continues/);
  f.view.handleInput(keys.retry);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].request, first.request);
  assert.equal(f.calls[1].signal.aborted, false);
  first.resolve(reply(first, 'STALE_CANCELLED_RESPONSE'));
  await settle();
  assert.doesNotMatch(f.text(), /STALE_CANCELLED_RESPONSE/);
  f.calls[1].resolve(reply(f.calls[1], 'RESUMED_RESPONSE'));
  await settle();
  assert.match(f.text(), /RESUMED_RESPONSE/);
  f.view.dispose();
});

test('Escape closes locally once, preserves drafts and ignores late progress and completion', async () => {
  const f = fixture({ draft: 'Question' });
  f.view.handleInput(keys.enter);
  const first = f.calls[0];
  first.request.receipt = { conversationId: 7, submissionId: 71, requestId: first.request.requestId };
  f.view.handleInput('Draft for reopening');
  f.view.handleInput(keys.escape);
  assert.equal(first.signal.aborted, true);
  assert.equal(f.counts().closes, 1);
  assert.equal(f.memory.draft, 'Draft for reopening');
  assert.equal(f.memory.pending?.receipt?.submissionId, 71);
  const renders = f.counts().renders;
  first.progress({ status: 'Late', text: 'LATE_PARTIAL' });
  first.resolve(reply(first, 'LATE_FINAL'));
  await settle();
  assert.equal(f.counts().renders, renders);
  assert.equal(f.memory.pending?.receipt?.submissionId, 71);
  f.view.handleInput(keys.escape);
  assert.equal(f.counts().closes, 1);
});

test('external shutdown closes the custom view without starting another exchange', async () => {
  const f = fixture({ draft: 'Unsent draft' });
  f.external.abort();
  await settle();
  assert.equal(f.counts().closes, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.memory.draft, 'Unsent draft');
});

test('public partial is replaced by exactly one final response', async () => {
  const f = fixture({ draft: 'Question' });
  f.view.handleInput(keys.enter);
  const call = f.calls[0];
  call.progress({ status: 'Working', text: 'PARTIAL_ONLY' });
  assert.equal(f.text().split('PARTIAL_ONLY').length - 1, 1);
  call.resolve(reply(call, 'FINAL_ONCE'));
  await settle();
  const complete = f.text();
  assert.doesNotMatch(complete, /PARTIAL_ONLY/);
  assert.equal(complete.split('FINAL_ONCE').length - 1, 1);
  f.view.handleInput(keys.retry);
  assert.equal(f.calls.length, 1, 'Ctrl+R without a pending receipt must not resend');
  assert.equal(f.memory.pending, undefined);
  f.view.dispose();
});
