// Exercise Pi's real text wrapping and keyboard helpers at compact terminal sizes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { initTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { DurableCreationReview } from '../src/creation-review.js';

initTheme('dark', false);
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const keys = { enter: '\r', escape: '\x1b', cancel: '\x03', tab: '\t', right: '\x1b[C', left: '\x1b[D',
  up: '\x1b[A', down: '\x1b[B', pageUp: '\x1b[5~', pageDown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F' };
const folder = 'C:/workspaces/folder with spaces/進捗-👩🏽‍💻/a-very-long-unbroken-repository-directory-name';
const review = [
  'Name: Workspace helper', 'Agent: workspace-helper/workspace-helper',
  `Base folder: ${folder}`, `Project and local state: ${folder}/.pi/durable/workspace-helper`,
  'Model policy: latest:sol', 'Task profile: coding; reasoning is checked against the selected model.',
  'Trigger: Manual messages and explicit tasks', 'Console registry: C:/console/durable-agents.json',
  '', '**Purpose**', ...Array.from({ length: 60 }, (_, index) => `Instruction ${index + 1}: Inspect scoped files and explain the observed result.`),
].join('\n\n');

function fixture(options: { rows?: number; text?: string; signal?: AbortSignal;title?:string;confirmLabel?:string } = {}) {
  const terminal = { rows: options.rows ?? 20 };
  const results: boolean[] = [];
  let renders = 0;
  const tui = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
  const view = new DurableCreationReview(tui, plainTheme, result => results.push(result), {
    text: options.text ?? review, signal: options.signal,title:options.title,confirmLabel:options.confirmLabel,
  });
  const frame = (width = 48) => view.render(width);
  const text = (width = 48) => frame(width).map(line => stripVTControlCharacters(line)).join('\n');
  return { terminal, results, view, frame, text, renders: () => renders };
}

test('review stays within all terminal row and column budgets, including Unicode and tiny sizes', () => {
  for (const width of [0, 1, 2, 3, 10, 28, 48, 110]) for (const rows of [0, 1, 2, 3, 5, 7, 12, 20, 38]) {
    const f = fixture({ rows });
    const lines = f.frame(width);
    assert.ok(lines.length <= rows, `${width}x${rows}: ${lines.length} lines`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}x${rows}: ${visibleWidth(line)} columns`);
    f.view.handleInput(keys.pageDown);
    for (const line of f.frame(width)) assert.ok(visibleWidth(line) <= width);
    f.view.dispose();
  }
});

test('lifecycle mutation review uses its literal operation title and still defaults to Cancel',()=>{
  const f=fixture({title:'Durable stop · Review',confirmLabel:'Apply action',text:'Project: C:\\work\\.pi\\durable\\helper\nDrain accepted work before stopping.'});
  assert.match(f.text(),/Durable stop/);assert.match(f.text(),/Apply action/);
  assert.match(f.text(),/\\\.pi\\durable/);f.view.handleInput(keys.enter);assert.deepEqual(f.results,[false]);
});

test('fixed title, cancel/create actions and scroll help remain visible at native sizes', () => {
  for (const [width, rows] of [[48, 20], [110, 38]]) {
    const f = fixture({ rows });
    for (let page = 0; page < 5; page++) {
      const lines = f.frame(width), text = lines.join('\n');
      assert.equal(lines[0], 'Create Durable agent · Review');
      assert.match(text, /\[ Cancel \]/);
      assert.match(text, /Create agent/);
      assert.match(text, /PgUp\/PgDn scroll/);
      assert.match(text, /Enter select · Esc cancel/);
      f.view.handleInput(keys.pageDown);
    }
    assert.equal(f.results.length, 0);
    f.view.dispose();
  }
});

test('every character in an unbroken Unicode folder and model policy remains reachable by scrolling', () => {
  const f = fixture();
  const frames: string[] = [];
  for (let index = 0; index < 90; index++) { frames.push(f.text()); f.view.handleInput(keys.down); }
  const combined = frames.join('\n').replace(/\s/g, '');
  assert.ok(combined.includes(folder.replace(/\s/g, '')));
  assert.ok(combined.includes('Modelpolicy:latest:sol'));
  assert.ok(combined.includes('Taskprofile:coding;'));
  assert.equal(f.results.length, 0);
  f.view.dispose();
});

test('configuration paths render literally with Windows separators and Markdown punctuation', () => {
  const path = String.raw`C:\workspaces\_private\[copy]\code*review\folder\.pi\durable`;
  const f = fixture({ rows: 38, text: `Base folder: ${path}\nModel policy: latest:sol` });
  assert.ok(f.text(110).includes(path));
  assert.match(f.text(110), /Model policy: latest:sol/);
  f.view.dispose();
});

test('Enter defaults to cancellation and only an explicitly selected Create can confirm', () => {
  const cancel = fixture(); cancel.frame(); cancel.view.handleInput(keys.enter);
  assert.deepEqual(cancel.results, [false]);
  cancel.view.handleInput(keys.right); cancel.view.handleInput(keys.enter);
  assert.deepEqual(cancel.results, [false]);

  const create = fixture(); create.frame(); create.view.handleInput(keys.right);
  assert.match(create.text(), /\[ Create agent \]/);
  create.view.handleInput(keys.enter);
  assert.deepEqual(create.results, [true]);
  create.view.handleInput(keys.enter);
  assert.deepEqual(create.results, [true]);
});

test('scrolling never changes the chosen action and tab/left/right update it explicitly', () => {
  const f = fixture(); f.frame();
  for (const key of [keys.pageDown, keys.down, keys.end, keys.pageUp, keys.up, keys.home]) f.view.handleInput(key);
  assert.match(f.text(), /\[ Cancel \]/);
  f.view.handleInput(keys.tab); assert.match(f.text(), /\[ Create agent \]/);
  f.view.handleInput(keys.left); assert.match(f.text(), /\[ Cancel \]/);
  f.view.handleInput(keys.right); assert.match(f.text(), /\[ Create agent \]/);
  f.view.handleInput(keys.tab); assert.match(f.text(), /\[ Cancel \]/);
  assert.equal(f.results.length, 0);
  f.view.dispose();
});

test('Home/End reach review boundaries and resizing preserves a bounded readable panel', () => {
  const f = fixture(); f.frame(); f.view.handleInput(keys.end);
  assert.match(f.text(), /Instruction 60/);
  f.terminal.rows = 38;
  const expanded = f.frame(110);
  assert.equal(expanded.length, 38);
  assert.match(expanded.join('\n'), /Instruction 60/);
  f.terminal.rows = 12;
  const compact = f.frame(32);
  assert.equal(compact.length, 12);
  assert.ok(compact.every(line => visibleWidth(line) <= 32));
  f.view.handleInput(keys.home);
  assert.match(f.text(48), /Name: Workspace helper/);
  assert.match(f.text(48), /Review lines 1-/);
  f.view.dispose();
});

test('a terminal too small to display the actions cannot confirm creation', () => {
  for (const [width, rows] of [[20, 2], [28, 3], [32, 5]]) {
    const f = fixture({ rows }); f.frame(width); f.view.handleInput(keys.right); f.view.handleInput(keys.enter);
    assert.deepEqual(f.results, []);
    f.terminal.rows = 20; f.frame(48); f.view.handleInput(keys.enter);
    assert.deepEqual(f.results, [true]);
  }
});

test('Escape, Ctrl+C and external abort cancel once and disposed views ignore late input', async () => {
  for (const key of [keys.escape, keys.cancel]) {
    const f = fixture(); f.frame(); f.view.handleInput(key); f.view.handleInput(keys.enter);
    assert.deepEqual(f.results, [false]);
  }
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal }); f.frame(); controller.abort();
  f.view.handleInput(keys.right); f.view.handleInput(keys.enter);
  assert.deepEqual(f.results, [false]);
  const preAborted = new AbortController(); preAborted.abort();
  const already = fixture({ signal: preAborted.signal });
  await new Promise<void>(accept => setImmediate(accept));
  assert.deepEqual(already.results, [false]);
});
