// Pi Durable 1.5 conversation views carry a window of public entries plus separate live state.
import type { ChatMessage, ChatProgress } from './chat-ui.js';
import type { DurableSnapshot } from './client.js';
import { safeText } from './display.js';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function label(value: string, limit: number): string {
  return safeText(value.replace(/[\r\n\t]/g, ' '), limit).replace(/[\r\n\t]/g, ' ').trim();
}

function publicText(content: unknown): string {
  if (typeof content === 'string') return safeText(content);
  if (!Array.isArray(content)) return '';
  return safeText(content
    .filter((block): block is Record<string, unknown> => object(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string).join('\n'));
}

/** Keep turn identity, including repeated text, without exposing thinking or tools. */
export function publicMessages(snapshot: DurableSnapshot): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (!Array.isArray(snapshot.entries)) return messages;
  for (const [entryIndex, entry] of snapshot.entries.entries()) {
    if (!object(entry) || !Array.isArray(entry.model)) continue;
    const entryId = typeof entry.id === 'number' || typeof entry.id === 'string' ? String(entry.id) : `index-${entryIndex}`;
    for (const [messageIndex, message] of entry.model.entries()) {
      if (!object(message) || (message.role !== 'user' && message.role !== 'assistant')) continue;
      const text = publicText(message.content);
      if (text.trim()) messages.push({ id: `entry:${entryId}:${messageIndex}`, role: message.role, text });
    }
  }
  return messages.slice(-80);
}

/** Read the selected conversation's model rather than the host's current default. */
export function conversationModel(snapshot: DurableSnapshot): string | undefined {
  if (!object(snapshot.docs) || !object(snapshot.docs['pi.agent'])) return;
  const model = snapshot.docs['pi.agent'].model;
  if (!object(model) || typeof model.provider !== 'string' || typeof model.modelId !== 'string') return;
  const provider = label(model.provider, 100);
  const modelId = label(model.modelId, 160);
  return provider && modelId ? `${provider}/${modelId}` : undefined;
}

/** Live output belongs to the active run, not necessarily the submission being watched. */
export function liveProgress(snapshot: DurableSnapshot, submissionId: number): ChatProgress | undefined {
  if (!object(snapshot.docs) || !object(snapshot.docs['pi.live'])) return;
  const live = snapshot.docs['pi.live'];
  if (!object(live.run) || !Array.isArray(live.run.inputs) || !live.run.inputs.includes(submissionId)) {
    return { status: 'Queued: waiting for this message to run' };
  }
  const generation = object(live.generation) ? live.generation : undefined;
  const message = generation && object(generation.message) ? generation.message : undefined;
  const text = message?.role === 'assistant' ? publicText(message.content) : '';
  const tools = [
    ...(Array.isArray(live.tools) ? live.tools : []),
    ...(Array.isArray(live.nestedTools) ? live.nestedTools : []),
  ].filter((tool): tool is Record<string, unknown> => object(tool) && (tool.status === 'pending' || tool.status === 'running'));
  let status = 'Agent is working';
  if (generation && object(generation.retry)) status = 'Retrying the model request';
  else if (tools.length) {
    const names = [...new Set(tools.slice(0, 16).map(tool => typeof tool.name === 'string'
      ? label(tool.name, 48) : 'tool'))].filter(Boolean).slice(0, 3);
    status = `Running ${tools.length} tool${tools.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}`;
  } else if (generation && object(generation.deferred)) status = 'Waiting for the model provider';
  return { status, ...(text.trim() ? { text } : {}) };
}
