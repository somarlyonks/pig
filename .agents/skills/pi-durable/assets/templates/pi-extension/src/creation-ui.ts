// Pi loads this module directly. All mutations happen after the final review.
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { isAbsolute } from 'node:path';
import {
  prepareAgentCreation, createAgent,
  type AgentCreationInput, type CreatedAgentReceipt,
} from './agent-creation.js';
import { safeText } from './display.js';
import { DurableCreationReview } from './creation-review.js';

export interface CreationWizardOptions {
  extensionDir: string;
  connectionsFile?: string;
  signal?: AbortSignal;
  prepare?: typeof prepareAgentCreation;
  create?: typeof createAgent;
  onProgress?: (message: string) => void;
}
const TASKS = new Map<string, AgentCreationInput['task']>([
  ['Coding and coordination · latest Sol, medium reasoning', 'coding'],
  ['Routine work and classification · latest Luna, low reasoning', 'routine'],
  ['Code review · latest Astra, high reasoning', 'review'],
  ['Research · latest Astra, xhigh reasoning', 'research'],
]);
const MODELS = new Map<string, string>([
  ['Latest recommended model for this task', 'latest'],
  ['Latest Sol · balanced capability', 'latest:sol'],
  ['Latest Astra · highest capability', 'latest:astra'],
  ['Latest Luna · efficient routine work', 'latest:luna'],
]);
const EXACT_MODEL = 'Enter an exact model ID';
const MANUAL = 'Manual · wait for messages and explicit tasks';
const PULL_REQUEST = 'Pull requests · watch one GitHub repository';
const RESERVED_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function suggestedId(name: string): string {
  const slug = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return /^[a-z]/.test(slug) && !RESERVED_ID.test(slug) ? slug : 'durable-agent';
}
function publicError(error: unknown): string {
  return safeText(error instanceof Error ? error.message : 'The creation plan could not be prepared.', 3000);
}

/** Collect a complete reviewable plan without touching the registry or starting a service. */
export async function runCreationWizard(
  ctx: ExtensionCommandContext,
  options: CreationWizardOptions,
): Promise<CreatedAgentReceipt | undefined> {
  if (!ctx.hasUI) throw new Error('Creating an agent needs Pi UI. Run /durable new in an interactive Pi session.');
  const signal = options.signal;
  const cancelled = () => signal?.aborted === true;
  if (cancelled()) return;
  const notify = (message: string) => { if (!cancelled()) ctx.ui.notify(safeText(message), 'warning'); };
  const dialogOptions = signal ? { signal } : undefined;

  async function text(
    title: string, initial: string | undefined, validate: (value: string) => string | undefined,
    editor = false,
  ): Promise<string | undefined> {
    let current = initial;
    for (let attempt = 0; attempt < 3 && !cancelled(); attempt++) {
      const value = editor ? await ctx.ui.editor(title, current) : await ctx.ui.input(title, current, dialogOptions);
      if (value === undefined || cancelled()) return;
      const clean = value.trim();
      const error = validate(clean);
      if (!error) return clean;
      notify(error);
      if (editor) current = value;
    }
    notify('Creation cancelled after three invalid entries. Start again with /durable new.');
    return;
  }
  const validName = (value: string) => !value || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)
    ? 'Enter a name from 1 to 120 characters on one line.' : undefined;
  const validId = (value: string) => !/^[a-z][a-z0-9-]{0,47}$/.test(value) || RESERVED_ID.test(value)
    ? 'Use a lowercase agent ID starting with a letter, up to 48 letters, digits or hyphens. Device names are reserved.' : undefined;
  const validFolder = (value: string) => !isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)
    ? 'Enter one absolute existing folder path. Paths with spaces are supported.' : undefined;
  const name = await text('Create Durable agent · 1/8 · Name', 'For example: Repository reviewer', validName);
  if (name === undefined) return;
  let id = await text('Create Durable agent · 2/8 · Agent ID', suggestedId(name), validId, true);
  if (id === undefined) return;
  let baseDir = await text('Create Durable agent · 3/8 · Base folder (edit the path, then submit)', ctx.cwd, validFolder, true);
  if (baseDir === undefined) return;
  const instructions = await text('Create Durable agent · 4/8 · What should this agent do?',
    'Help with this workspace. Inspect relevant files, explain findings with evidence, and ask for a specific task when needed.',
    value => !value || value.length > 24000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)
      ? 'Enter a nonempty purpose of at most 24,000 characters.' : undefined, true);
  if (instructions === undefined) return;
  const taskLabel = await ctx.ui.select('Create Durable agent · 5/8 · Task profile', [...TASKS.keys()], dialogOptions);
  if (!taskLabel || cancelled()) return;
  const task = TASKS.get(taskLabel);
  if (!task) return;
  const modelLabel = await ctx.ui.select('Create Durable agent · 6/8 · Model policy', [...MODELS.keys(), EXACT_MODEL], dialogOptions);
  if (!modelLabel || cancelled()) return;
  let model = MODELS.get(modelLabel);
  if (modelLabel === EXACT_MODEL) model = await text('Exact model ID (pinned for new conversations)', 'For example: gpt-6.1-sol',
    value => !value || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value) || value.startsWith('latest')
      ? 'Enter an exact model ID without whitespace. Choose a latest policy from the previous menu instead.' : undefined);
  if (!model || cancelled()) return;
  const trigger = await ctx.ui.select('Create Durable agent · 7/8 · When should it work?', [MANUAL, PULL_REQUEST], dialogOptions);
  if (!trigger || cancelled()) return;
  let repository: string | undefined;
  if (trigger === PULL_REQUEST) {
    repository = await text('GitHub repository to watch (owner/name)', 'For example: my-org/my-repository',
      value => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value) || value.length > 240
        ? 'Enter one GitHub repository as owner/name.' : undefined);
    if (repository === undefined) return;
    repository = repository.toLowerCase();
  }
  const prepare = options.prepare ?? prepareAgentCreation;
  const create = options.create ?? createAgent;
  // Preparation only validates inputs and computes paths. It never starts a process.
  for (let attempt = 0; attempt < 3 && !cancelled(); attempt++) {
    let plan;
    try {
      plan = await prepare({ id, name, baseDir, instructions, task, model, ...(repository ? { repository } : {}) },
        { cwd: ctx.cwd, extensionDir: options.extensionDir, ...(options.connectionsFile ? { connectionsFile: options.connectionsFile } : {}) });
    } catch (error) {
      if (cancelled()) return;
      notify(publicError(error));
      if (attempt === 2) return;
      const edit = await ctx.ui.select('Creation plan needs an update', ['Edit base folder', 'Edit agent ID', 'Cancel'], dialogOptions);
      if (cancelled() || !edit || edit === 'Cancel') return;
      if (edit === 'Edit base folder') {
        const folder = await text('Base folder (absolute existing directory)', baseDir, validFolder, true);
        if (folder === undefined) return;
        baseDir = folder;
      } else if (edit === 'Edit agent ID') {
        const nextId = await text('Agent ID', id, validId, true);
        if (nextId === undefined) return;
        id = nextId;
      } else return;
      continue;
    }
    if (cancelled()) return;
    const review = [
      `Name: ${plan.name}`,
      `Agent: ${plan.target}`,
      `Base folder: ${plan.baseDir}`,
      `Project and local state: ${plan.projectDir}`,
      `Model policy: ${plan.requestedModel}`,
      `Task profile: ${plan.task}; reasoning is checked against the selected model.`,
      `Trigger: ${plan.repository ? `New pull requests in ${plan.repository}; baseline existing PRs` : 'Manual messages and explicit tasks'}`,
      `Console registry: ${plan.connectionsFile}`,
      '',
      'Create the independent project, install its pinned dependencies, build it, start its own background service and add it to the console.',
      'Local tools can list and read files within the base folder. Shell execution and file changes are not enabled.',
      'The process survives closing Pi. Automatic start at login is not installed.',
      '',
      `Purpose:\n${plan.instructions}`,
    ].join('\n');
    const confirmed = ctx.mode === 'tui'
      ? await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) =>
        new DurableCreationReview(tui, theme, done, { text: review, signal }),
      { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'center' } })
      : await ctx.ui.confirm('Create Durable agent · 8/8 · Review and create', safeText(review, 32000), dialogOptions);
    if (!confirmed || cancelled()) return;
    options.onProgress?.('Creating the independent agent project…');
    if (cancelled()) return;
    return await create(plan, { signal, onProgress: options.onProgress });
  }
  return;
}
