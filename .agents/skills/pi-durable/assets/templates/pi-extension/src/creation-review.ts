// Bounded final review for Pi terminals, including compact and resized windows.
import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type TUI,
} from '@earendil-works/pi-tui';
import { safeText } from './display.js';

export interface CreationReviewOptions { text: string; signal?: AbortSignal; title?:string; confirmLabel?:string }

/** Keep the review title and explicit Cancel/Create choices visible while content scrolls. */
export class DurableCreationReview implements Component, Focusable {
  focused = false;
  private readonly text: string;
  private selectedCreate = false;
  private scrollTop = 0;
  private contentHeight = 0;
  private viewportHeight = 0;
  private renderWidth = 0;
  private disposed = false;
  private readonly onAbort = () => this.finish(false);

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (confirmed: boolean) => void,
    private readonly options: CreationReviewOptions,
  ) {
    // Configuration is literal data: Markdown would consume Windows path separators.
    this.text = safeText(options.text, 32000);
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (options.signal?.aborted) queueMicrotask(this.onAbort);
  }

  invalidate(): void { /* Layout is recomputed from the current terminal on every render. */ }
  private requestRender(): void { if (!this.disposed) this.tui.requestRender(); }
  private fit(text: string, width: number): string {
    return visibleWidth(text) > width ? truncateToWidth(text, width, '') : text;
  }
  private get canCreate(): boolean {
    const liveColumns = this.tui.terminal.columns;
    return this.renderWidth >= 32 && (liveColumns === undefined || liveColumns >= 32)
      && this.tui.terminal.rows >= 7 && this.viewportHeight >= 3;
  }

  render(width: number): string[] {
    const columns = Math.max(0, Math.floor(width));
    const rows = Math.max(0, Math.floor(this.tui.terminal.rows));
    this.renderWidth = columns;
    if (!columns || !rows) { this.viewportHeight = 0; return []; }
    // Keep cancellation available even when there is no useful review viewport.
    if (columns < 4 || rows < 3) {
      this.viewportHeight = 0;
      return [this.fit(this.theme.fg('warning', 'Resize to review · Esc cancel'), columns)];
    }
    const headerCount = rows >= 8 ? 2 : 1;
    const footerCount = rows >= 8 ? 4 : rows >= 5 ? 3 : 1;
    this.viewportHeight = Math.max(0, rows - headerCount - footerCount);
    // Native wrapping preserves complete paths, Unicode and user-supplied punctuation.
    const content = wrapTextWithAnsi(this.text, columns);
    this.contentHeight = content.length;
    const maximum = Math.max(0, content.length - this.viewportHeight);
    this.scrollTop = Math.min(maximum, Math.max(0, this.scrollTop));
    const body = content.slice(this.scrollTop, this.scrollTop + this.viewportHeight);
    while (body.length < this.viewportHeight) body.push('');
    const title = this.theme.bold(this.theme.fg('accent', safeText(this.options.title??'Create Durable agent · Review',120)));
    const divider = this.theme.fg('borderMuted', '─'.repeat(columns));
    const range = this.viewportHeight && content.length
      ? `${this.scrollTop + 1}-${Math.min(content.length, this.scrollTop + this.viewportHeight)}/${content.length}` : '0/0';
    const position = this.theme.fg('muted', `Review lines ${range} · PgUp/PgDn scroll`);
    const cancel = this.selectedCreate ? '  Cancel  ' : '[ Cancel ]';
    const label=safeText(this.options.confirmLabel??'Create agent',18);
    const create = this.selectedCreate ? `[ ${label} ]` : `  ${label}  `;
    const buttons = this.theme.fg(!this.selectedCreate ? 'accent' : 'muted', cancel) + '   '
      + this.theme.fg(this.selectedCreate ? this.canCreate ? 'success' : 'warning' : 'muted', create);
    const help = this.theme.fg(this.canCreate ? 'dim' : 'warning', this.canCreate
      ? 'Tab/←/→ choose · Enter select · Esc cancel' : 'Resize terminal to create · Esc cancel');
    const footer = footerCount === 4 ? [position, divider, buttons, help]
      : footerCount === 3 ? [position, buttons, help] : [buttons];
    return [title, ...(headerCount === 2 ? [divider] : []), ...body, ...footer]
      .slice(0, rows).map(line => this.fit(line, columns));
  }

  private scroll(delta: number): void {
    this.scrollTop = Math.max(0, Math.min(Math.max(0, this.contentHeight - this.viewportHeight), this.scrollTop + delta));
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) { this.finish(false); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      this.selectedCreate = !this.selectedCreate; this.requestRender(); return;
    }
    if (matchesKey(data, Key.left)) { this.selectedCreate = false; this.requestRender(); return; }
    if (matchesKey(data, Key.right)) { this.selectedCreate = true; this.requestRender(); return; }
    if (matchesKey(data, Key.pageUp)) { this.scroll(-Math.max(1, this.viewportHeight - 1)); return; }
    if (matchesKey(data, Key.pageDown)) { this.scroll(Math.max(1, this.viewportHeight - 1)); return; }
    if (matchesKey(data, Key.up)) { this.scroll(-1); return; }
    if (matchesKey(data, Key.down)) { this.scroll(1); return; }
    if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl('home'))) { this.scroll(-this.contentHeight); return; }
    if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl('end'))) { this.scroll(this.contentHeight); return; }
    if (matchesKey(data, Key.enter)) {
      if (!this.selectedCreate) this.finish(false);
      else if (this.canCreate) this.finish(true);
    }
  }

  private finish(confirmed: boolean): void {
    if (this.disposed) return;
    this.dispose();
    this.done(confirmed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.signal?.removeEventListener('abort', this.onAbort);
  }
}
