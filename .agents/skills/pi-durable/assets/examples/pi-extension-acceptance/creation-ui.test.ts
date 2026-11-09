// Run with npm test from the independently generated extension directory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { runCreationWizard, type CreationWizardOptions } from '../src/creation-ui.js';
import type { AgentCreationInput, CreatedAgentReceipt } from '../src/agent-creation.js';

type Dialog = { kind: string; title: string; value?: string; choices?: string[]; options?: unknown };
function fixture(options: {
  signal?: AbortSignal;
  hasUI?: boolean;
  respond?: (dialog: Dialog, index: number) => unknown;
  prepareError?: (input: AgentCreationInput, attempt: number) => Error | undefined;
  createError?: Error;
} = {}) {
  const dialogs: Dialog[] = [], notifications: string[] = [], progress: string[] = [];
  const prepared: AgentCreationInput[] = [], contexts: unknown[] = [], created: unknown[] = [];
  const cwd = resolve('workspace with spaces');
  const connectionsFile = join(cwd, '.pi', 'durable-agents.json');
  const respond = (dialog: Dialog): any => {
    dialogs.push(dialog);
    if (options.respond) {
      const result = options.respond(dialog, dialogs.length - 1);
      if (result !== 'USE_DEFAULT') return result;
    }
    if (dialog.kind === 'confirm') return true;
    if (dialog.kind === 'select') return dialog.choices![0];
    if (dialog.kind === 'editor') return dialog.value;
    if (dialog.title.includes('Name')) return 'Code Helper';
    if (dialog.title.startsWith('GitHub repository')) return 'My-Org/My-Repository';
    if (dialog.title.startsWith('Exact model')) return 'gpt-6.1-sol';
    return undefined;
  };
  const ctx: any = {
    hasUI: options.hasUI ?? true, cwd, mode: 'rpc',
    ui: {
      input: async (title: string, value?: string, settings?: unknown) => respond({ kind: 'input', title, value, options: settings }),
      editor: async (title: string, value?: string) => respond({ kind: 'editor', title, value }),
      select: async (title: string, choices: string[], settings?: unknown) => respond({ kind: 'select', title, choices, options: settings }),
      confirm: async (title: string, value: string, settings?: unknown) => respond({ kind: 'confirm', title, value, options: settings }),
      notify: (message: string) => notifications.push(message),
    },
  };
  const settings: CreationWizardOptions = {
    extensionDir: resolve('extension'), connectionsFile, signal: options.signal,
    onProgress: message => progress.push(message),
    prepare: async (input, context) => {
      prepared.push({ ...input }); contexts.push(context);
      const error = options.prepareError?.(input, prepared.length);
      if (error) throw error;
      const projectDir = join(input.baseDir, '.pi', 'durable', input.id);
      return Object.freeze({
        ...input, instructions: input.instructions, projectDir,
        configPath: join(projectDir, 'config.json'), connectionsFile,
        target: `${input.id}/${input.id}`, provider: 'openai-codex',
        requestedModel: input.model ?? 'latest', task: input.task ?? 'coding',
      }) as any;
    },
    create: async (plan, createOptions) => {
      created.push(plan);
      if (options.createError) throw options.createError;
      createOptions?.onProgress?.('Independent service is ready.');
      return { target: plan.target, configPath: plan.configPath, projectDir: plan.projectDir,
        baseDir: plan.baseDir, connectionsFile: plan.connectionsFile, pid: 12345, status: 'running', requestedModel: plan.requestedModel,
        task: plan.task } as CreatedAgentReceipt;
    },
  };
  return { ctx, settings, dialogs, prepared, contexts, created, notifications, progress, cwd, connectionsFile,
    run: () => runCreationWizard(ctx, settings) };
}

test('creation review includes the exact folder and independent process before any mutation', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ respond: (dialog) => {
    if (dialog.kind === 'confirm') {
      assert.equal(f.created.length, 0);
      assert.equal(f.prepared.length, 1);
      assert.match(dialog.value!, /Base folder:/);
      assert.ok(dialog.value!.includes(f.cwd));
      assert.ok(dialog.value!.includes(join(f.cwd, '.pi', 'durable', 'code-helper')));
      assert.match(dialog.value!, /Model policy: latest/);
      assert.match(dialog.value!, /Task profile: coding/);
      assert.match(dialog.value!, /Shell execution and file changes are not enabled/);
      assert.match(dialog.value!, /background service/);
      assert.match(dialog.value!, /Automatic start at login is not installed/);
    }
    return 'USE_DEFAULT';
  } });
  const result = await f.run();
  assert.equal(result?.target, 'code-helper/code-helper');
  assert.equal(result?.status, 'running');
  assert.equal(f.created.length, 1);
  assert.equal(f.prepared[0].baseDir, f.cwd);
  assert.equal(f.prepared[0].model, 'latest');
  assert.equal(f.prepared[0].task, 'coding');
  assert.equal(f.prepared[0].repository, undefined);
  assert.equal(f.prepared[0].thinkingLevel, undefined);
  assert.equal((f.contexts[0] as any).connectionsFile, f.connectionsFile);
  assert.equal(f.progress.at(-1), 'Independent service is ready.');
});

test('base folder is an editable prefilled path and spaces remain data', async () => {
  const f = fixture(); await f.run();
  const folder = f.dialogs.find(dialog => dialog.title.includes('Base folder'))!;
  assert.equal(folder.kind, 'editor');
  assert.equal(folder.value, f.cwd);
  assert.ok(f.prepared[0].baseDir.includes('workspace with spaces'));
});

test('cancelling any required dialog leaves files, processes and registry untouched', async () => {
  for (let cancelAt = 0; cancelAt < 8; cancelAt++) {
    const f = fixture({ respond: (dialog, index) => index === cancelAt
      ? dialog.kind === 'confirm' ? false : undefined : 'USE_DEFAULT' });
    assert.equal(await f.run(), undefined, `Cancellation at dialog ${cancelAt}`);
    assert.equal(f.created.length, 0);
    assert.equal(f.dialogs.length, cancelAt + 1);
    assert.equal(f.prepared.length, cancelAt === 7 ? 1 : 0);
  }
});

test('noninteractive use and an already cancelled wizard cannot prepare or create', async () => {
  const withoutUI = fixture({ hasUI: false });
  await assert.rejects(withoutUI.run(), /interactive Pi session/);
  assert.equal(withoutUI.dialogs.length, 0);
  const controller = new AbortController(); controller.abort();
  const cancelled = fixture({ signal: controller.signal });
  assert.equal(await cancelled.run(), undefined);
  assert.equal(cancelled.dialogs.length, 0);
  assert.equal(cancelled.prepared.length, 0);
  assert.equal(cancelled.created.length, 0);
});

test('abort during a dialog or final confirmation prevents creation', async () => {
  for (const at of [4, 7]) {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal, respond: (_dialog, index) => {
      if (index === at) controller.abort();
      return 'USE_DEFAULT';
    } });
    assert.equal(await f.run(), undefined);
    assert.equal(f.created.length, 0);
    assert.ok(f.dialogs.filter(dialog => dialog.kind !== 'editor').every(dialog => (dialog.options as any)?.signal === controller.signal));
  }
});

test('folder validation rejects multiline and relative paths before a valid retry', async () => {
  let attempts = 0;
  const f = fixture({ respond: dialog => {
    if (!dialog.title.includes('3/8')) return 'USE_DEFAULT';
    return ++attempts === 1 ? 'relative/folder' : attempts === 2 ? `${resolve('one')}\n${resolve('two')}` : resolve('valid folder');
  } });
  assert.equal((await f.run())?.baseDir, resolve('valid folder'));
  assert.equal(f.notifications.length, 2);
  assert.equal(f.prepared.length, 1);
});

test('invalid IDs including Windows device names are rejected with a bounded retry', async () => {
  let attempts = 0;
  const f = fixture({ respond: dialog => dialog.title.includes('2/8')
    ? ['CON', 'com1', 'valid-agent'][attempts++] : 'USE_DEFAULT' });
  assert.equal((await f.run())?.target, 'valid-agent/valid-agent');
  assert.equal(f.notifications.length, 2);
  const invalid = fixture({ respond: dialog => dialog.title.includes('2/8') ? '../escape' : 'USE_DEFAULT' });
  assert.equal(await invalid.run(), undefined);
  assert.equal(invalid.created.length, 0);
  assert.equal(invalid.dialogs.filter(dialog => dialog.title.includes('2/8')).length, 3);
  assert.match(invalid.notifications.at(-1)!, /three invalid entries/);
});

test('task choice and exact model pins reach the creation backend unchanged', async () => {
  const f = fixture({ respond: dialog => {
    if (dialog.title.includes('5/8')) return dialog.choices!.find(value => value.startsWith('Research'));
    if (dialog.title.includes('6/8')) return dialog.choices!.find(value => value.startsWith('Enter an exact'));
    return 'USE_DEFAULT';
  } });
  await f.run();
  assert.equal(f.prepared[0].task, 'research');
  assert.equal(f.prepared[0].model, 'gpt-6.1-sol');
  assert.equal(f.prepared[0].thinkingLevel, undefined);
});

test('GitHub polling is explicit and review identifies baseline behavior', async () => {
  const f = fixture({ respond: dialog => dialog.title.includes('7/8') ? dialog.choices![1] : 'USE_DEFAULT' });
  await f.run();
  assert.equal(f.prepared[0].repository, 'my-org/my-repository');
  assert.match(f.dialogs.at(-1)!.value!, /New pull requests in my-org\/my-repository; baseline existing PRs/);
  const cancelled = fixture({ respond: dialog => dialog.title.includes('7/8') ? dialog.choices![1]
    : dialog.title.startsWith('GitHub repository') ? undefined : 'USE_DEFAULT' });
  assert.equal(await cancelled.run(), undefined);
  assert.equal(cancelled.prepared.length, 0);
  assert.equal(cancelled.created.length, 0);
});

test('failed preparation can repair the folder without losing other choices', async () => {
  const changed = resolve('repaired folder');
  const f = fixture({ prepareError: (_input, attempt) => attempt === 1 ? new Error('The selected folder does not exist.') : undefined,
    respond: dialog => dialog.title.startsWith('Base folder (absolute') ? changed : 'USE_DEFAULT' });
  assert.equal((await f.run())?.baseDir, changed);
  assert.equal(f.prepared.length, 2);
  assert.equal(f.created.length, 1);
  assert.equal(f.prepared[0].baseDir, f.cwd);
  assert.equal(f.prepared[1].baseDir, changed);
  assert.equal(f.prepared[1].instructions, f.prepared[0].instructions);
  assert.equal(f.prepared[1].model, f.prepared[0].model);
});

test('failed preparation can repair the ID and cancellation makes no changes', async () => {
  const f = fixture({ prepareError: (_input, attempt) => attempt === 1 ? new Error('The project already exists.') : undefined,
    respond: dialog => dialog.title === 'Creation plan needs an update' ? 'Edit agent ID'
      : dialog.title === 'Agent ID' ? 'another-agent' : 'USE_DEFAULT' });
  assert.equal((await f.run())?.target, 'another-agent/another-agent');
  const cancelled = fixture({ prepareError: () => new Error('Invalid folder.'),
    respond: dialog => dialog.title === 'Creation plan needs an update' ? 'Cancel' : 'USE_DEFAULT' });
  assert.equal(await cancelled.run(), undefined);
  assert.equal(cancelled.created.length, 0);
});

test('creation failure is surfaced once without replaying the mutation', async () => {
  const error = Object.assign(new Error('Build failed. Inspect the retained project log.'), { projectDir: resolve('created-project') });
  const f = fixture({ createError: error });
  await assert.rejects(f.run(), failure => failure === error);
  assert.equal(f.created.length, 1);
  assert.equal(f.prepared.length, 1);
});

test('cancellation after preparation or progress cannot start the backend mutation', async () => {
  for (const phase of ['prepare', 'progress']) {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    if (phase === 'prepare') {
      const original = f.settings.prepare!;
      f.settings.prepare = async (...args) => { const plan = await original(...args); controller.abort(); return plan; };
    } else f.settings.onProgress = () => controller.abort();
    assert.equal(await f.run(), undefined);
    assert.equal(f.prepared.length, 1);
    assert.equal(f.created.length, 0);
    assert.equal(f.dialogs.some(dialog => dialog.kind === 'confirm'), phase === 'progress');
  }
});
