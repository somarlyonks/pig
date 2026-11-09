// Run with npm test. Fixtures contain no credentials or live service access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMessages, conversationModel, liveProgress } from '../src/chat-data.js';
import type { DurableSnapshot } from '../src/client.js';

function snapshot(entries: Array<Record<string, unknown>> = [], docs: Record<string, unknown> = {}): DurableSnapshot {
  return { conversation: { id: 7 }, entries, docs };
}
function live(value: Record<string, unknown>) { return snapshot([], { 'pi.live': value }); }

test('public history preserves roles and excludes thinking, tools and nontext blocks', () => {
  const result = publicMessages(snapshot([{ id: 20, model: [
    { role: 'user', content: 'What changed?' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: '**Answer**' }, { type: 'toolCall', name: 'PRIVATE_TOOL', arguments: { secret: 'PRIVATE_ARGUMENTS' } }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }] },
    { role: 'system', content: 'PRIVATE_INSTRUCTIONS' },
  ] }]));
  assert.deepEqual(result, [{ id: 'entry:20:0', role: 'user', text: 'What changed?' }, { id: 'entry:20:1', role: 'assistant', text: '**Answer**' }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('repeated content remains separate and entry keys survive an earlier inserted entry', () => {
  const entries = [{ id: 20, model: [{ role: 'user', content: 'Again' }] }, { id: 21, model: [{ role: 'user', content: 'Again' }] }];
  const original = publicMessages(snapshot(entries));
  const next = publicMessages(snapshot([{ id: 19, model: [{ role: 'assistant', content: 'Earlier' }] }, ...entries]));
  assert.equal(original.length, 2);
  assert.notEqual(original[0].id, original[1].id);
  assert.deepEqual(next.slice(1), original);
});

test('separate messages in one entry have stable distinct keys', () => {
  const result = publicMessages(snapshot([{ id: 8, model: [{ role: 'assistant', content: 'One' }, { role: 'assistant', content: 'Two' }] }]));
  assert.deepEqual(result.map(message => message.id), ['entry:8:0', 'entry:8:1']);
});

test('history retains the most recent 80 public messages', () => {
  const result = publicMessages(snapshot(Array.from({ length: 95 }, (_, index) => ({ id: index + 1, model: [{ role: 'user', content: String(index + 1) }] }))));
  assert.equal(result.length, 80);
  assert.equal(result[0].text, '16');
  assert.equal(result.at(-1)?.text, '95');
});

test('public text preserves CJK and emoji while removing terminal controls and credentials', () => {
  const result = publicMessages(snapshot([{ id: 1, model: [{ role: 'assistant', content: '\u001b[31m進捗 👩🏽‍💻\u001b[0m\nBearer fixture-not-a-real-token\u0007' }] }]));
  assert.equal(result[0].text, '進捗 👩🏽‍💻\nBearer [REDACTED]');
});

test('malformed or empty public messages are ignored and missing entry IDs get deterministic keys', () => {
  const result = publicMessages(snapshot([{ model: [null, { role: 'user', content: [] }, { role: 'assistant', content: [{ type: 'text', text: 12 }] }, { role: 'user', content: 'Visible' }] }, { model: 'invalid' }]));
  assert.deepEqual(result, [{ id: 'entry:index-0:3', role: 'user', text: 'Visible' }]);
});

test('conversation model uses Pi Durable provider/modelId reference', () => {
  assert.equal(conversationModel(snapshot([], { 'pi.agent': { model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' } } })), 'openai-codex/gpt-6.1-sol');
  assert.equal(conversationModel(snapshot([], { 'pi.agent': { model: { provider: 'openai', id: 'wrong-schema' } } })), undefined);
  assert.equal(conversationModel(snapshot()), undefined);
});

test('model header strips multiline terminal control input', () => {
  const model = conversationModel(snapshot([], { 'pi.agent': { model: { provider: 'openai\nlocal', modelId: '\u001b[31mtest\u001b[0m\rmodel' } } }));
  assert.equal(model, 'openai local/test model');
});

test('live partial includes only assistant public text for the watched active submission', () => {
  const result = liveProgress(live({ run: { taskId: 10, inputs: [31, 32] }, generation: { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: 'Partial **reply**' }, { type: 'toolCall', arguments: 'PRIVATE_ARGUMENTS' }] } } }), 32);
  assert.deepEqual(result, { status: 'Agent is working', text: 'Partial **reply**' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('a different or absent live run reports queued without leaking another submission partial or tools', () => {
  const payload = { run: { inputs: [99] }, generation: { message: { role: 'assistant', content: [{ type: 'text', text: 'OTHER_SUBMISSION' }] } }, tools: [{ status: 'running', name: 'OTHER_TOOL' }] };
  assert.deepEqual(liveProgress(live(payload), 32), { status: 'Queued: waiting for this message to run' });
  assert.deepEqual(liveProgress(live({}), 32), { status: 'Queued: waiting for this message to run' });
  assert.equal(liveProgress(snapshot(), 32), undefined);
});

test('live progress exposes bounded tool names and count, excluding arguments and outputs', () => {
  const tools = Array.from({ length: 5 }, (_, index) => ({ status: 'running', name: `tool_${index}`, output: 'PRIVATE_OUTPUT', arguments: { token: 'PRIVATE_ARGUMENTS' }, diagnostics: ['PRIVATE_DIAGNOSTIC'] }));
  const result = liveProgress(live({ run: { inputs: [32] }, tools, nestedTools: [{ status: 'pending', name: 'nested', output: 'PRIVATE_NESTED_OUTPUT' }] }), 32);
  assert.deepEqual(result, { status: 'Running 6 tools: tool_0, tool_1, tool_2' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|nested/);
});

test('retry and deferred status omit provider error details and discard nonassistant partials', () => {
  assert.deepEqual(liveProgress(live({ run: { inputs: [32] }, generation: { retry: { error: 'PRIVATE_PROVIDER_ERROR' }, message: { role: 'user', content: 'PRIVATE_USER_PARTIAL' } } }), 32), { status: 'Retrying the model request' });
  assert.deepEqual(liveProgress(live({ run: { inputs: [32] }, generation: { deferred: { pollAt: 123 } } }), 32), { status: 'Waiting for the model provider' });
});
