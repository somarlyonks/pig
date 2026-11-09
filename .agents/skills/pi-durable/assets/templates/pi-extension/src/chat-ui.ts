// Pi 1.5.1 custom conversation view. Run npm run check to verify the public TUI API.
import { getMarkdownTheme, getSelectListTheme, type Theme } from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER, Editor, Key, Markdown, matchesKey, truncateToWidth, visibleWidth,
  type Component, type Focusable, type KeybindingsManager, type TUI,
} from '@earendil-works/pi-tui';
import type { AdmissionReceipt } from './client.js';
import { safeText } from './display.js';

export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'notice'; text: string }
export interface ChatRequest { message: string; requestId: string; receipt?: AdmissionReceipt }
export interface ChatMemory { draft: string; pending?: ChatRequest; error?: string }
export interface ChatReply { text: string; status: string; receipt: AdmissionReceipt }
export interface ChatProgress { text?: string; status: string }
export interface ChatViewOptions {
  target: string;
  agentName?: string;
  jobId?: string;
  conversationId: number;
  model?: string;
  messages: ChatMessage[];
  memory: ChatMemory;
  signal: AbortSignal;
  createRequestId: () => string;
  exchange: (request: ChatRequest, signal: AbortSignal, progress: (value: ChatProgress) => void) => Promise<ChatReply>;
  describeError: (error: unknown) => { message: string; receipt?: AdmissionReceipt; requestId?: string };
}

interface MessageLayout { text: string; width: number; lines: string[] }

/** Keep the conversation and composer visible while asynchronous agent work continues. */
export class DurableChatView implements Component, Focusable {
  private readonly editor: Editor;
  private readonly messages: ChatMessage[];
  private readonly layouts = new Map<string, MessageLayout>();
  private hiddenMessageCount = 0;
  private disposed = false;
  private busy = false;
  private operationId = 0;
  private controller?: AbortController;
  private progress: ChatProgress = { status: 'Ready' };
  private hint?: string;
  private followingEnd = true;
  private scrollTop = 0;
  private contentHeight = 0;
  private viewportHeight = 0;
  private conversationId: number;
  private readonly onExternalAbort = () => this.close();

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    private readonly options: ChatViewOptions,
  ) {
    this.messages = options.messages.slice(-80);
    this.hiddenMessageCount = Math.max(0, options.messages.length - this.messages.length);
    this.conversationId = options.conversationId;
    this.editor = new Editor(tui, {
      borderColor: text => theme.fg('borderAccent', text),
      selectList: getSelectListTheme(),
    }, { paddingX: 1 });
    this.editor.setText(options.memory.draft);
    this.editor.onChange = () => {
      options.memory.draft = this.editor.getExpandedText();
      this.hint = undefined;
      this.requestRender();
    };
    // The input handler captures submit before Editor trims or clears the text.
    this.editor.onSubmit = text => this.submit(text);
    if (options.memory.pending && !options.memory.error) {
      options.memory.error = 'A previous wait ended. Ctrl+R resumes the same request; admitted work continues.';
    }
    options.signal.addEventListener('abort', this.onExternalAbort, { once: true });
    if (options.signal.aborted) queueMicrotask(this.onExternalAbort);
  }

  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }

  private requestRender(): void {
    if (!this.disposed) this.tui.requestRender();
  }

  invalidate(): void {
    this.layouts.clear();
    this.editor.invalidate();
  }

  private line(text: string): string { return safeText(text).replace(/[\r\n]+/g, ' '); }

  private fit(text: string, width: number): string {
    return visibleWidth(text) > width ? truncateToWidth(text, width, '') : text;
  }

  private messageLines(message: ChatMessage, width: number): string[] {
    const text = safeText(message.text);
    const key = `${message.role}:${message.id}`;
    const cached = this.layouts.get(key);
    if (cached && cached.width === width && cached.text === text) return cached.lines;
    const label = message.role === 'user' ? 'You'
      : message.role === 'assistant' ? this.line(this.options.agentName ?? this.options.target) : 'Notice';
    const color = message.role === 'user' ? 'accent' : message.role === 'assistant' ? 'success' : 'muted';
    const heading = this.theme.bold(this.theme.fg(color, label));
    const body = new Markdown(text, width >= 5 ? 1 : 0, 0, getMarkdownTheme()).render(width);
    const lines = [heading, ...body, ''].map(line => this.fit(line, width));
    this.layouts.set(key, { text, width, lines });
    return lines;
  }

  private transcript(width: number): string[] {
    const lines: string[] = [];
    if (this.hiddenMessageCount) {
      lines.push(this.theme.fg('muted', 'Showing the latest 80 messages in this panel.'), '');
    }
    for (const message of this.messages) lines.push(...this.messageLines(message, width));
    if (this.progress.text && this.options.memory.pending) {
      lines.push(...this.messageLines({
        id: 'current-response', role: 'assistant', text: this.progress.text,
      }, width));
    }
    if (!lines.length) {
      lines.push(this.theme.fg('muted', 'Start a conversation with this durable agent.'));
    }
    return lines;
  }

  private appendMessage(message: ChatMessage): void {
    this.messages.push(message);
    if (this.messages.length > 80) {
      this.hiddenMessageCount += this.messages.length - 80;
      this.messages.splice(0, this.messages.length - 80);
      this.layouts.clear();
    }
  }

  /** Crop an unusually tall draft around its cursor, retaining the IME cursor marker. */
  private composer(width: number, available: number): string[] {
    const lines = this.editor.render(width);
    if (lines.length <= available) return lines;
    const body = lines.slice(1, -1);
    const cursor = Math.max(0, body.findIndex(line => line.includes(CURSOR_MARKER)));
    const count = Math.max(1, available - 2);
    const start = Math.max(0, Math.min(body.length - count, cursor - count + 1));
    const selected = body.slice(start, start + count);
    if (available === 1) return [body[cursor] ?? lines[0]];
    if (available === 2) return [body[cursor] ?? lines[0], lines.at(-1)!];
    return [lines[0], ...selected, lines.at(-1)!];
  }

  render(width: number): string[] {
    const rows = Math.max(0, Math.floor(this.tui.terminal.rows));
    if (width <= 0 || rows <= 0) return [];
    // The Editor wraps wide graphemes recursively below four columns.
    // Keep a valid cursor instead of invoking that upstream layout edge case.
    if (width < 4) return [`${this.focused ? CURSOR_MARKER : ''} `];
    const headerCount = rows >= 18 ? 4 : rows >= 14 ? 3 : rows >= 9 ? 2 : rows >= 5 ? 1 : 0;
    const footerCount = rows >= 7 ? 1 : 0;
    const statusCount = rows >= 4 ? 1 : 0;
    const editorRoom = Math.max(1, rows - headerCount - footerCount - statusCount - 1);
    const editorLimit = Math.min(editorRoom, rows >= 12 ? 8 : rows >= 7 ? 4 : 1);
    const editor = this.composer(width, editorLimit);
    const historyRoom = Math.max(0, rows - headerCount - footerCount - statusCount - editor.length);
    const history = this.transcript(width);
    this.contentHeight = history.length;
    this.viewportHeight = historyRoom;
    const maximum = Math.max(0, history.length - historyRoom);
    this.scrollTop = this.followingEnd ? maximum : Math.min(maximum, Math.max(0, this.scrollTop));

    const mode = this.busy ? 'WORKING' : this.options.memory.pending ? 'WAIT PAUSED' : 'CONNECTED';
    const header = [this.theme.bold(this.theme.fg('accent', `Pi Durable  ${this.line(this.options.target)}  ${mode}`))];
    if (headerCount > 1) {
      const scope = this.options.jobId ? `Task ${this.line(this.options.jobId)}` : 'Control chat';
      const compactScope = truncateToWidth(scope, Math.max(1, width - 20));
      header.push(this.theme.fg('muted', `${compactScope} · Conversation ${this.conversationId}`));
    }
    if (headerCount > 2) {
      const model = this.options.model ? this.line(this.options.model) : 'unknown';
      const label = width < 60 ? model.split('/').at(-1)! : model;
      header.push(this.theme.fg('muted', `Model ${label}`));
    }
    if (headerCount > 3) header.push(this.theme.fg('borderMuted', '─'.repeat(width)));
    const body = history.slice(this.scrollTop, this.scrollTop + historyRoom);
    while (body.length < historyRoom) body.push('');
    const pending = this.options.memory.pending;
    const receipt = pending?.receipt ? ` · submission ${pending.receipt.submissionId}` : '';
    const position = this.followingEnd ? 'Latest' : `History ${this.scrollTop + 1}-${Math.min(history.length, this.scrollTop + historyRoom)}/${history.length}`;
    const state = this.options.memory.error ?? this.hint ?? this.progress.status;
    const status = this.theme.fg(this.options.memory.error ? 'warning' : this.busy ? 'accent' : 'muted',
      `${this.busy ? '●' : pending ? '!' : '○'} ${this.line(state)}${receipt} · ${position}`);
    const help = pending && !this.busy
      ? width < 60 ? 'Ctrl+R resume · Esc close · PgUp/PgDn' : 'Ctrl+R resume same request · Esc close · PgUp/PgDn history · Ctrl+End latest'
      : this.busy
        ? width < 60 ? 'Ctrl+C stop wait · Esc close · PgUp/PgDn' : 'Draft kept · Ctrl+C stop wait · Esc close · PgUp/PgDn history'
        : width < 60 ? 'Enter send · Esc close · PgUp/PgDn' : 'Enter send · Shift+Enter newline · Esc close · PgUp/PgDn history';
    const lines = [
      ...header.slice(0, headerCount), ...body,
      ...(statusCount ? [status] : []), ...editor,
      ...(footerCount ? [this.theme.fg('dim', help)] : []),
    ];
    return lines.slice(0, rows).map(line => this.fit(line, width));
  }

  private moveHistory(delta: number): void {
    const maximum = Math.max(0, this.contentHeight - this.viewportHeight);
    const start = this.followingEnd ? maximum : this.scrollTop;
    this.scrollTop = Math.min(maximum, Math.max(0, start + delta));
    this.followingEnd = this.scrollTop === maximum;
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.escape)) { this.close(); return; }
    if (matchesKey(data, Key.ctrl('c'))) { this.cancelWait(); return; }
    if (matchesKey(data, Key.ctrl('r'))) {
      if (!this.busy && this.options.memory.pending) void this.exchange(this.options.memory.pending);
      return;
    }
    if (matchesKey(data, Key.pageUp)) { this.moveHistory(-Math.max(1, this.viewportHeight - 1)); return; }
    if (matchesKey(data, Key.pageDown)) { this.moveHistory(Math.max(1, this.viewportHeight - 1)); return; }
    if (matchesKey(data, Key.ctrl('end'))) {
      this.followingEnd = true;
      this.requestRender();
      return;
    }
    const newline = this.keybindings.matches(data, 'tui.input.newLine') || matchesKey(data, Key.shift('enter'));
    if (!newline && this.keybindings.matches(data, 'tui.input.submit')) {
      // Keep Pi's backslash+Enter multiline fallback when the terminal lacks Shift+Enter.
      const cursor = this.editor.getCursor();
      const before = this.editor.getLines()[cursor.line]?.slice(0, cursor.col);
      if (!before?.endsWith('\\')) {
        this.submit(this.editor.getExpandedText());
        return;
      }
    }
    this.editor.handleInput(data);
    this.requestRender();
  }

  private submit(message: string): void {
    if (this.disposed) return;
    if (!message.trim()) return;
    if (message.trim() === '/exit') { this.close(); return; }
    if (this.busy || this.options.memory.pending) {
      this.hint = this.busy ? 'The agent is responding. Your draft is kept.' : 'Ctrl+R resumes the previous request. Your new draft is kept.';
      this.requestRender();
      return;
    }
    const request: ChatRequest = { message, requestId: this.options.createRequestId() };
    this.options.memory.pending = request;
    this.editor.addToHistory(message);
    this.appendMessage({ id: `user:${request.requestId}`, role: 'user', text: message });
    this.editor.setText('');
    this.options.memory.draft = '';
    this.followingEnd = true;
    void this.exchange(request);
  }

  private async exchange(request: ChatRequest): Promise<void> {
    if (this.disposed || this.busy) return;
    const operation = ++this.operationId;
    this.controller = new AbortController();
    this.busy = true;
    this.editor.disableSubmit = true;
    this.hint = undefined;
    this.options.memory.error = undefined;
    this.progress = { status: request.receipt ? 'Reconnecting to admitted work…' : 'Sending message…' };
    this.requestRender();
    try {
      const reply = await this.options.exchange(request, this.controller.signal, progress => {
        if (this.disposed || operation !== this.operationId) return;
        this.progress = progress;
        this.requestRender();
      });
      if (this.disposed || operation !== this.operationId) return;
      request.receipt = reply.receipt;
      this.conversationId = reply.receipt.conversationId;
      const id = `assistant:${request.requestId}`;
      if (!this.messages.some(message => message.id === id)) {
        this.appendMessage({ id, role: 'assistant', text: reply.text || 'Completed without final text.' });
      }
      this.options.memory.pending = undefined;
      this.options.memory.error = undefined;
      this.progress = { status: reply.status === 'done' ? 'Ready' : `Finished: ${reply.status}` };
    } catch (error) {
      if (this.disposed || operation !== this.operationId) return;
      let detail: ReturnType<ChatViewOptions['describeError']>;
      try { detail = this.options.describeError(error); }
      catch { detail = { message: 'The local wait failed. Ctrl+R retries the same request.' }; }
      if (detail.receipt) request.receipt = detail.receipt;
      if (detail.requestId) request.requestId = detail.requestId;
      this.options.memory.pending = request;
      this.options.memory.error = detail.message;
    } finally {
      if (!this.disposed && operation === this.operationId) {
        this.busy = false;
        this.editor.disableSubmit = false;
        this.controller = undefined;
        this.requestRender();
      }
    }
  }

  private cancelWait(): void {
    if (!this.busy) return;
    ++this.operationId;
    this.controller?.abort();
    this.controller = undefined;
    this.busy = false;
    this.editor.disableSubmit = false;
    this.options.memory.error = 'Stopped waiting locally. The agent continues; Ctrl+R resumes the same request.';
    this.requestRender();
  }

  private close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    if (this.disposed) return;
    this.options.memory.draft = this.editor.getExpandedText();
    if (this.busy && this.options.memory.pending) {
      this.options.memory.error = 'Chat closed locally. The agent continues; Ctrl+R resumes the same request.';
    }
    this.disposed = true;
    ++this.operationId;
    this.controller?.abort();
    this.controller = undefined;
    this.options.signal.removeEventListener('abort', this.onExternalAbort);
    this.layouts.clear();
  }
}
