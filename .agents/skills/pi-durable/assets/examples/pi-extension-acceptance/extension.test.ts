// Run with npm test from the extension directory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerDurableExtension } from '../extension.js';
import { DurableClientError, DurableSendError, type AdmissionReceipt, type ServiceConnection } from '../src/client.js';

interface Call { service: string; method: string; args: any[] }
function fixture(options: { services?: number; duplicate?: boolean; hasUI?: boolean; creationWizard?:any; operations?:any } = {}) {
  const calls: Call[] = [];
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, Array<(...args: any[]) => any>>();
  const entries: Array<{ type: string; data: any }> = [];
  const notifications: string[] = [];
  const statuses: any[] = [];
  const connections: ServiceConnection[] = Array.from({ length: options.services ?? 1 }, (_, index) => ({
    id: index ? 'other' : 'local', name: index ? 'Other service' : 'Local service',
    configPath: `C:/fixture/service-${index}/config.json`, dataDir: `C:/fixture/service-${index}/state`,
    baseUrl: `http://127.0.0.1:${4792 + index}`,
  }));
  const clients = connections.map(connection => {
    const record = (method: string, args: any[]) => calls.push({ service: connection.id, method, args });
    return {
      connection,
      async list(...args: any[]) { record('list', args); return { agents: [{ id: options.duplicate ? 'shared' : connection.id === 'local' ? 'repo-quality' : 'delivery-watch', name: 'Useful agent', active: 1, pending: 0 }], mode: 'openai-codex' }; },
      async status(...args: any[]) { record('status', args); return { supported: true, provider: 'openai-codex', model: 'gpt-6.1-sol', watching: true }; },
      async jobs(...args: any[]) { record('jobs', args); return { jobs: [{ id: 'job:one', status: 'done', result: 'Observed validation result' }] }; },
      async snapshot(...args: any[]) { record('snapshot', args); return { conversation: { id: 7 }, entries: [{ model: [{ role: 'user', content: 'Explain the result' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'Private reasoning must stay hidden' }, { type: 'text', text: 'Public agent answer' }] }] }] }; },
      async admit(...args: any[]) { record('admit', args); return { conversationId: 7, submissionId: 9, requestId: args[2]?.requestId ?? 'fallback-request' }; },
      async send(...args: any[]) { record('send', args); const requestId = args[2]?.requestId ?? 'fallback-request'; return { requestId, receipt: { conversationId: 7, submissionId: 9, requestId }, submission: { status: 'done', text: 'A real service answer would appear here.' } }; },
      async submission(...args: any[]) { record('submission', args); return { status: 'done', text: 'Retained answer' }; },
      async wait(...args: any[]) { record('wait', args); return { status: 'done', text: 'Retained answer' }; },
      async abort(...args: any[]) { record('abort', args); return { aborted: true }; },
      async evidence(...args: any[]) { record('evidence', args); return { records: [{ id: 'evidence-1', kind: 'decision.recorded', summary: 'Public decision summary' }] }; },
    };
  });
  const pi: any = {
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerEntryRenderer() {},
    appendEntry(type: string, data: any) { entries.push({ type, data }); },
    on(name: string, handler: (...args: any[]) => any) { events.set(name, [...(events.get(name) ?? []), handler]); },
    sendMessage() { assert.fail('Console commands must not insert agent text into the outer model context.'); },
    sendUserMessage() { assert.fail('Console commands must not start an outer model turn.'); },
  };
  const ctx: any = {
    cwd: process.cwd(), mode: options.hasUI === false ? 'print' : 'rpc', hasUI: options.hasUI !== false,
    signal: undefined, sessionManager: { getEntries: () => [], getBranch: () => [] },
    ui: {
      notify(text: string) { notifications.push(text); },
      setStatus(...args: any[]) { statuses.push(args); },
      async select() { return undefined; }, async input() { return undefined; }, async editor() { return undefined; },
      async confirm() { return true; },
    },
  };
  registerDurableExtension(pi, {
    loadConnections: async () => ({ connections }),
    createClient: (connection: ServiceConnection) => clients.find(client => client.connection.id === connection.id)!,
    createRequestId: () => 'stable-request-id', waitTimeoutMs: 2_000, pollIntervalMs: 5,
    creationWizard:options.creationWizard,
    operations:options.operations,
  });
  const output = () => JSON.stringify({ entries, notifications });
  async function command(args: string, name = 'durable') { await commands.get(name).handler(args, ctx); }
  async function tool(params: Record<string, unknown>, signal?: AbortSignal) { return await tools.get('durable_agents').execute('call-1', params, signal, () => {}, ctx); }
  return { commands, tools, events, entries, calls, clients, ctx, output, command, tool, statuses };
}

test('registers only Durable-namespaced commands and a tool without model messaging', async () => {
  const f = fixture();
  assert.deepEqual([...f.commands.keys()].sort(), ['durable', 'durable-chat']);
  assert.equal(f.commands.has('agents'), false); assert.equal(f.commands.has('agent'), false);
  assert.ok(f.tools.has('durable_agents'));
  await f.command('help');
  assert.equal(f.calls.length, 0);
  assert.match(f.output(), /send|chat/);
});

test('new and create route to a local creation wizard without a model or an existing service',async()=>{
  const starts:any[]=[];
  const f=fixture({services:0,creationWizard:async(_ctx:any,options:any)=>{starts.push(options);return undefined;}});
  await f.command('new');await f.command('create');
  assert.equal(starts.length,2);assert.equal(f.calls.length,0);
  assert.ok(starts[0].signal instanceof AbortSignal);
  assert.equal(starts[0].connectionsFile,undefined);
  assert.ok(f.commands.get('durable').getArgumentCompletions('n').some((item:any)=>item.value==='new'));
  assert.equal(f.statuses.at(-1)[1],undefined);
});

test('terminal manager and empty chat picker expose creation with a base folder',async()=>{
  let count=0;
  const f=fixture({services:0,creationWizard:async()=>{count++;return undefined;}});
  f.ctx.mode='tui';
  f.ctx.ui.select=async(title:string,choices:string[])=>{
    assert.match(title,/Pi Durable/);assert.ok(choices.some(value=>/Create new agent.*base folder/.test(value)));
    return choices.find(value=>value.startsWith('+ Create'));
  };
  await f.command('');await f.command('','durable-chat');
  assert.equal(count,2);assert.equal(f.calls.length,0);
});

test('creation reports the independent folder and running process and offers chat',async()=>{
  const f=fixture({creationWizard:async()=>({target:'new-agent/new-agent',baseDir:'C:/My workspace',projectDir:'C:/My workspace/.pi/durable/new-agent',configPath:'C:/My workspace/.pi/durable/new-agent/config.json',pid:12345,status:'running'})});
  f.ctx.ui.select=async(title:string,choices:string[])=>{assert.match(title,/ready/);assert.ok(choices.includes('Open chat now'));return 'Back to Pi';};
  await f.command('new');
  assert.match(f.output(),/Created and running: new-agent\/new-agent/);
  assert.match(f.output(),/C:\/My workspace/);assert.match(f.output(),/12345/);
  assert.equal(f.calls.length,0);
});

test('creation rejects noninteractive use and unexpected arguments before mutation',async()=>{
  let count=0;const f=fixture({hasUI:false,creationWizard:async()=>{count++;}});
  await f.command('new');assert.match(f.output(),/needs Pi UI/);
  await f.command('new C:/ambiguous');assert.match(f.output(),/creation form/);
  assert.equal(count,0);
});

test('stopped configured agents stay visible and can be started from the manager',async()=>{
  let started=0;const f=fixture({operations:{
    readConfiguredAgents:async()=>[{id:'repo-quality',name:'Useful agent'}],
    inspectManaged:async()=>({managed:true,state:'stopped',project:{projectDir:'C:/fixture/managed'}}),
    startManaged:async()=>{started++;return {managed:true,state:'running'};},
  }});
  f.clients[0].list=async()=>{throw new DurableClientError('network_error','Offline owner');};
  await f.command('list');assert.match(f.output(),/local\/repo-quality.*stopped/);
  f.ctx.mode='tui';f.ctx.ui.custom=async()=>true;
  f.ctx.ui.select=async(title:string,values:string[])=>title.startsWith('Pi Durable agents')?values.find(value=>value.includes('local/repo-quality')):values.includes('Owner controls')?'Owner controls':'Start owner';
  await f.command('');assert.equal(started,1);assert.match(f.output(),/running/);
});

test('verification and lifecycle commands resolve stopped configured identities without a live owner',async()=>{
  const calls:any[]=[];const f=fixture({operations:{
    readConfiguredAgents:async()=>[{id:'repo-quality',name:'Useful agent'}],
    inspectManaged:async()=>({managed:true,state:'stopped',project:{projectDir:'C:/fixture/managed'}}),
    verifyAgent:async(connection:any,options:any)=>{calls.push({connection,options});return {status:'inconclusive',reason:'The selected result is not terminal.'};},
  }});
  f.clients[0].list=async()=>{throw new DurableClientError('network_error','Offline owner');};
  await f.command('verify local/repo-quality --job job:one --submission 9');
  assert.equal(calls[0].options.jobId,'job:one');assert.equal(calls[0].options.submissionId,9);assert.match(f.output(),/inconclusive/);
  assert.ok(f.commands.get('durable').getArgumentCompletions('e').some((value:any)=>value.value==='evolve'));
});

test('background abort needs explicit review and is never implied by ordinary cancellation',async()=>{
  const f=fixture();f.ctx.ui.confirm=async()=>false;
  await f.command('abort local/repo-quality --background');assert.equal(f.calls.some(call=>call.method==='abort'),false);
  f.ctx.ui.confirm=async()=>true;await f.command('abort local/repo-quality --background');
  assert.equal(f.calls.find(call=>call.method==='abort')?.args[1]?.background,true);
});

test('lists agents across configured services and reports service status', async () => {
  const f = fixture({ services: 2 });
  await f.command('');
  assert.deepEqual(f.calls.filter(call => call.method === 'list').map(call => call.service).sort(), ['local', 'other']);
  assert.match(f.output(), /repo-quality/); assert.match(f.output(), /delivery-watch/);
  assert.equal(f.calls.some(call => call.method === 'send'), false);
  await f.command('status local');
  assert.equal(f.calls.filter(call => call.method === 'status').at(-1)?.service, 'local');
  assert.match(f.output(), /gpt-6\.1-sol/);
});

test('reads job-specific history without exposing reasoning blocks', async () => {
  const f = fixture();
  await f.command('read local/repo-quality --job job:one');
  const call = f.calls.find(call => call.method === 'snapshot');
  assert.equal(call?.args[0], 'repo-quality'); assert.equal(call?.args[1]?.jobId, 'job:one');
  assert.match(f.output(), /Public agent answer/);
  assert.doesNotMatch(f.output(), /Private reasoning must stay hidden/);
});

test('sends a direct message with stable request identity and job context', async () => {
  const f = fixture();
  await f.command('local/repo-quality --job job:one Explain the latest result, please.', 'durable-chat');
  const call = f.calls.find(call => call.method === 'send');
  assert.equal(call?.args[0], 'repo-quality');
  assert.equal(call?.args[1], 'Explain the latest result, please.');
  assert.equal(call?.args[2]?.jobId, 'job:one'); assert.equal(call?.args[2]?.requestId, 'stable-request-id');
  assert.equal(call?.args[2]?.whenBusy, 'followUp');
  assert.equal(call?.args[2]?.waitTimeoutMs, 2_000);
  assert.match(f.output(), /real service answer/);
});

test('steering is explicit and preserves the message content', async () => {
  const f = fixture();
  await f.command('steer local/repo-quality Focus on the failing checks.');
  const call = f.calls.find(call => call.method === 'send');
  assert.equal(call?.args[1], 'Focus on the failing checks.'); assert.equal(call?.args[2]?.whenBusy, 'steer');
});

test('ambiguous agent names do not send a message to an arbitrary service', async () => {
  const f = fixture({ services: 2, duplicate: true });
  await f.command('send shared Please explain.');
  assert.equal(f.calls.some(call => call.method === 'send'), false);
  assert.match(f.output(), /ambiguous|qualif|service|target/i);
});

test('the structured tool forwards trusted context and cancellation signal', async () => {
  const f = fixture(); const controller = new AbortController();
  const result = await f.tool({ action: 'send', service: 'local', agent: 'repo-quality', message: 'Check the retained report.', jobId: 'job:one', requestId: 'caller-request-id' }, controller.signal);
  const call = f.calls.find(call => call.method === 'send');
  assert.equal(call?.args[2]?.jobId, 'job:one'); assert.equal(call?.args[2]?.requestId, 'caller-request-id');
  assert.ok(call?.args[2]?.signal instanceof AbortSignal);
  assert.match(JSON.stringify(result), /real service answer/);
});

test('a timed out admitted message retains its receipt for reconnection', async () => {
  const f = fixture(); const receipt: AdmissionReceipt = { conversationId: 7, submissionId: 91, requestId: 'stable-request-id' };
  f.clients[0].send = async () => { throw new DurableSendError(new DurableClientError('wait_timeout', 'A bounded wait elapsed.'), receipt.requestId, receipt); };
  await f.command('send local/repo-quality Explain the report.');
  assert.match(f.output(), /91/); assert.match(f.output(), /stable-request-id/);
  assert.match(f.output(), /wait_timeout|wait|continues|reconnect/i);
  assert.equal(f.calls.some(call => call.method === 'abort'), false);
});

test('explicit wait reconnects to a submission without another admission', async () => {
  const f = fixture();
  await f.command('wait local/repo-quality 91');
  const call = f.calls.find(call => call.method === 'wait');
  assert.equal(call?.args[0], 'repo-quality'); assert.equal(call?.args[1]?.submissionId, 91);
  assert.equal(f.calls.some(call => call.method === 'send'), false);
});

test('explicit remote abort preserves the chosen job', async () => {
  const f = fixture();
  await f.command('abort local/repo-quality --job job:one');
  const call = f.calls.find(call => call.method === 'abort');
  assert.equal(call?.args[0], 'repo-quality'); assert.equal(call?.args[1]?.jobId, 'job:one');
});

test('unflagged job IDs cannot silently target the control conversation', async () => {
  const f = fixture();
  await f.command('abort local/repo-quality job:one');
  await f.command('read local/repo-quality job:one');
  assert.equal(f.calls.some(call => call.method === 'abort'), false);
  assert.equal(f.calls.some(call => call.method === 'snapshot'), false);
  assert.match(f.output(), /--job/);
});

test('cancel aborts only local waiting and keeps remote work alive', async () => {
  const f = fixture(); let admitted!: () => void;
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  f.clients[0].send = async (...args: any[]) => {
    const signal = args[2].signal as AbortSignal; admitted();
    return await new Promise<any>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DurableSendError(new DurableClientError('cancelled', 'Waiting cancelled.'), 'stable-request-id', { conversationId: 7, submissionId: 91, requestId: 'stable-request-id' })), { once: true }));
  };
  const waiting = f.command('send local/repo-quality Read the report.');
  await ready; await f.command('cancel'); await waiting;
  assert.equal(f.calls.some(call => call.method === 'abort'), false);
  assert.match(f.output(), /cancel/i);
});

test('cancelling chooser or editor never submits an empty message', async () => {
  const f = fixture();
  await f.command('', 'durable-chat');
  await f.command('local/repo-quality', 'durable-chat');
  assert.equal(f.calls.some(call => call.method === 'send'), false);
});

test('invalid operations and missing messages fail without service mutation', async () => {
  const f = fixture();
  await f.command('unknown-operation');
  await f.command('send local/repo-quality');
  assert.equal(f.calls.some(call => ['send', 'abort'].includes(call.method)), false);
  assert.match(f.output(), /help|usage|message|operation/i);
});

test('unexpected service errors are redacted from durable console output', async () => {
  const f = fixture();
  f.clients[0].list = async () => { throw new Error('secret-token-should-never-appear C:/private-account/secret.json'); };
  await f.command('list');
  assert.doesNotMatch(f.output(), /secret-token-should-never-appear|private-account/);
});
