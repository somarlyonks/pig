// Generated project: npm test. These evidence probes are offline and use real SQLite/Harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels,fauxProvider,fauxAssistantMessage,fauxThinking,fauxToolCall } from '@earendil-works/pi-ai';
import { obj } from '@earendil-works/pi-schema';
import { Harness,createRegistry,defineExtension,defineTool } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { EvidenceStore,captureVersion,fingerprint,versionReference,sanitizeEvidence } from '../src/evidence.js';
import { AgentRuntime,createDecisionTool,createListEvidenceTool,createEvidenceHooks } from '../src/runtime.js';
import { createReadPullRequestTool } from '../src/tools/read-pull-request.js';
import type { AgentConfig,ServiceConfig } from '../src/config.js';
import type { Job } from '../src/catalog.js';

await mkdir('artifacts',{recursive:true});
const agent:AgentConfig={id:'reviewer',name:'Reviewer',instructions:'Review privately and record public decision summaries.',repositories:['owner/repo']};
async function temporary(){return mkdtemp(resolve('artifacts/evidence-'));}
async function project(){const directory=await temporary();await mkdir(join(directory,'src/tools'),{recursive:true});await mkdir(join(directory,'prompts'));await writeFile(join(directory,'src/tools/inspect.ts'),'export const version = 1;\n');await writeFile(join(directory,'prompts/reviewer.md'),'Review the observed data.\n');await writeFile(join(directory,'package-lock.json'),'{"lockfileVersion":3}\n');return directory;}
const job=(number:number):Job=>({id:`job-${number}`,agentId:agent.id,status:'queued',event:{id:`github:owner/repo:pull_request:${number}:opened`,type:'pull_request.opened',repository:'owner/repo',number,title:'Offline fixture',url:`https://github.com/owner/repo/pull/${number}`,headSha:'abcdef',createdAt:'2026-10-24T12:00:00Z'}});

test('append-only evidence survives reopen, bounds payloads, and redacts credentials and private fields',async()=>{
  const directory=await temporary();let store=await EvidenceStore.open(directory);const previous=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture-secret-credential-1234';
  try{
    const record=store.append({agentId:agent.id,kind:'tool.completed',details:{authorization:'Bearer abc',apiKey:'bad',nested:{thinking:'private chain',text:'fixture-secret-credential-1234 and ghp_fixtureSecret12345678'},summary:'x'.repeat(100000),items:Array(100).fill('item')}});
    assert.ok(JSON.stringify(record).length<20000);assert.doesNotMatch(JSON.stringify(record),/private chain|fixture-secret-credential-1234|ghp_fixtureSecret12345678/);
    assert.equal((record.details.nested as any).thinking,'[REDACTED]');assert.equal(record.details.authorization,'[REDACTED]');assert.equal(store.has('other',record.id),false);assert.equal(store.get(agent.id,record.id)?.id,record.id);
    let nested:unknown=Array(32).fill(123456789);for(let i=0;i<5;i++)nested=Array(32).fill(nested);assert.ok(JSON.stringify(sanitizeEvidence(nested)).length<20000);
    store.close();store=await EvidenceStore.open(directory);assert.equal(store.list(agent.id)[0].id,record.id);
    const raw=new DatabaseSync(join(directory,'evidence.sqlite'));try{assert.throws(()=>raw.prepare('UPDATE evidence SET kind=? WHERE id=?').run('changed',record.id),/append-only/);assert.throws(()=>raw.prepare('DELETE FROM evidence WHERE id=?').run(record.id),/append-only/);}finally{raw.close();}
  }finally{store.close();if(previous===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=previous;}
});

test('portable source versions detect prompt, tool, dependency and policy changes while excluding state',async()=>{
  const directory=await project();await mkdir(join(directory,'state'));await writeFile(join(directory,'state/environment.env'),'SECRET=never-version-this');
  const first=await captureVersion(directory,agent,{kind:'faux'});assert.ok(first.files.every(file=>!file.path.includes('state')&&!file.path.includes(directory)));assert.match(first.digest,/^[a-f0-9]{64}$/);
  await writeFile(join(directory,'state/environment.env'),'SECRET=changed');assert.equal((await captureVersion(directory,agent,{kind:'faux'})).digest,first.digest);
  await writeFile(join(directory,'prompts/reviewer.md'),'Review with a concrete regression case.\n');const prompt=await captureVersion(directory,agent,{kind:'faux'});assert.notEqual(prompt.digest,first.digest);
  await writeFile(join(directory,'src/tools/inspect.ts'),'export const version = 2;\n');const tool=await captureVersion(directory,agent,{kind:'faux'});assert.notEqual(tool.digest,prompt.digest);
  assert.notEqual((await captureVersion(directory,{...agent,instructions:'Updated prompt'},{kind:'faux'})).digest,tool.digest);
  await writeFile(join(directory,'package-lock.json'),'{"lockfileVersion":3,"version":"2"}\n');const dependency=await captureVersion(directory,agent,{kind:'faux'});assert.notEqual(dependency.digest,tool.digest);
  const store=await EvidenceStore.open(join(directory,'state'));try{store.saveVersion(dependency);store.saveVersion(dependency);assert.deepEqual(JSON.parse(await readFile(join(directory,'state/versions',dependency.digest+'.json'),'utf8')),dependency);const record=store.append({agentId:agent.id,kind:'runtime.opened',details:{summary:'x'.repeat(100000)},version:{hostVersion:versionReference(dependency)}});assert.equal((record.version as any).hostVersion.digest,dependency.digest);}finally{store.close();}
});

test('public decisions require same-agent trace references and replay the recorded receipt',async()=>{
  const store=await EvidenceStore.open(await temporary());try{
    const evidence=store.append({agentId:agent.id,kind:'job.completed',details:{publicSummary:'Observed offline outcome'}});const foreign=store.append({agentId:'other',kind:'job.completed',details:{}});
    const tool=createDecisionTool(agent.id,store);let memo:unknown;const api:any={conversationId:1,taskId:2,callId:'decision-1',memo:async(_key:string,value:unknown,third?:unknown)=>{if(third!==undefined){memo=value;return value;}return memo;}};
    await assert.rejects(tool.execute({summary:'Use a smaller query',evidenceRefs:[foreign.id]},api,context),/this agent/);await assert.rejects(tool.execute({summary:'Use a smaller query',evidenceRefs:['missing']},api,context),/this agent/);
    const first=await tool.execute({summary:'Use a smaller query because the observed result exceeded the size bound.',evidenceRefs:[evidence.id]},api,context);const duplicate=await tool.execute({summary:'Use a smaller query because the observed result exceeded the size bound.',evidenceRefs:[evidence.id]},api,context);assert.deepEqual(duplicate,first);assert.equal(store.list(agent.id).filter(r=>r.kind==='decision.recorded').length,1);
  }finally{store.close();}
});

test('real runtime hooks record tool success/failure and public model output without raw tool data or thinking',{timeout:15000},async()=>{
  const directory=await temporary();const store=await EvidenceStore.open(directory);const faux=fauxProvider({tokensPerSecond:Infinity});const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();
  const otherConversation=store.append({agentId:agent.id,kind:'job.completed',conversationId:999999,details:{publicSummary:'OTHER_CONVERSATION_PRIVATE_MARKER'}});
  const inspect=defineTool({name:'inspect',description:'Offline inspection',parameters:obj({}),replay:'safe',execute:async()=>({output:[{type:'text',text:'RAW_TOOL_PAYLOAD_MARKER'}]})});
  const fail=defineTool({name:'fail',description:'Offline failure',parameters:obj({}),replay:'safe',execute:async()=>{throw new Error('RAW_FAILURE_PAYLOAD_MARKER');}});
  const list=createListEvidenceTool(agent.id,store);const decide=createDecisionTool(agent.id,store);const tools=[inspect,fail,list,decide];
  const ref={provider:model.provider,modelId:model.id};const extension=defineExtension({name:'evidence-test',tools,hooks:createEvidenceHooks((kind,details,ids)=>store.append({agentId:agent.id,kind,details,...ids}),ref)});const registry=createRegistry();registry.install(extension);
  faux.setResponses([fauxAssistantMessage(fauxToolCall('inspect',{}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxToolCall('fail',{}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxToolCall('list_evidence',{limit:20}),{stopReason:'toolUse'}),(request)=>{const result=[...request.messages].reverse().find(m=>m.role==='toolResult'&&m.toolName==='list_evidence') as any;assert.ok(result);const visible=JSON.parse(result.content.find((block:any)=>block.type==='text').text);assert.ok(visible.evidence.every((item:any)=>item.id!==otherConversation.id));assert.doesNotMatch(JSON.stringify(visible),/OTHER_CONVERSATION_PRIVATE_MARKER/);const basis=visible.evidence.find((item:any)=>item.kind==='tool.completed');assert.ok(basis);return fauxAssistantMessage(fauxToolCall('record_decision',{summary:'Use the observed successful inspection and report the failure explicitly.',evidenceRefs:[basis.id]}),{stopReason:'toolUse'});},fauxAssistantMessage([fauxThinking('PRIVATE_REASONING_MARKER'),{type:'text',text:'Public conclusion from the observed tool outcome.'}])]);
  const harness=await Harness.open(await openNodeSqliteStorage(join(directory,'harness.sqlite')),{models,registry},context);
  try{const conversation=await harness.root(context,{agent:{model:ref,extensions:[extension],tools}});const submission=await conversation.submit({type:'input',content:'Inspect the offline fixture',requestId:'fixture-1'},context);assert.equal((await submission.wait(context)).status,'done');const records=store.list(agent.id,100);assert.equal(records.filter(r=>r.kind==='model.request').length,5);assert.equal(records.filter(r=>r.kind==='tool.completed').length,3);assert.equal(records.filter(r=>r.kind==='tool.failed').length,1);assert.equal(records.filter(r=>r.kind==='decision.recorded').length,1);assert.match(JSON.stringify(records),/Public conclusion/);assert.doesNotMatch(JSON.stringify(records),/RAW_TOOL_PAYLOAD_MARKER|RAW_FAILURE_PAYLOAD_MARKER|PRIVATE_REASONING_MARKER/);const completed=records.find(r=>r.kind==='tool.completed'&&r.details.tool==='inspect')!;assert.equal((completed.details.output as any).sha256,fingerprint([{type:'text',text:'RAW_TOOL_PAYLOAD_MARKER'}]).sha256);}
  finally{await harness.close(context);store.close();}
});

test('agent evidence records jobs, human and cancellation boundaries and preserves old conversation versions',{timeout:20000},async()=>{
  const projectDir=await project();const config:ServiceConfig&{projectDir:string}={version:1,host:'127.0.0.1',port:0,projectDir,dataDir:join(projectDir,'state'),provider:{kind:'faux'},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[agent]};
  let runtime=await AgentRuntime.open(config,agent);const originalVersion=runtime.version.digest;let originalConversation=0;
  try{assert.equal((await runtime.run(job(1),(id)=>{originalConversation=id;})).status,'done');assert.equal(runtime.evidence.list(agent.id).filter(r=>r.kind==='job.completed').length,1);assert.equal(runtime.evidence.list(agent.id).filter(r=>r.kind==='model.request').length,1);await runtime.abort('job-1');}
  finally{await runtime.close();}
  await writeFile(join(projectDir,'prompts/reviewer.md'),'Updated prompt artifact\n');const revised={...agent,instructions:'Updated active prompt.'};runtime=await AgentRuntime.open({...config,agents:[revised]},revised);
  try{assert.notEqual(runtime.version.digest,originalVersion);assert.equal((await runtime.conversation('job-1')).id,originalConversation);assert.equal((runtime.versionForConversation(originalConversation).conversationVersion as any).digest,originalVersion);assert.equal(runtime.versionForConversation(originalConversation).hostVersion.digest,runtime.version.digest);assert.equal(runtime.calls,0);assert.equal((await runtime.run(job(1),()=>{})).status,'done');assert.equal(runtime.calls,0);assert.equal((await runtime.run(job(2),()=>{})).status,'done');const receipt=await runtime.submitHuman({content:'Explain the observed outcome',requestId:'human-1'});const submission=await runtime.harness.submission(receipt.submissionId as any,context);await submission!.wait(context);const records=runtime.evidence.list(agent.id,100);assert.ok(records.some(r=>r.kind==='human.submitted'));assert.ok(records.some(r=>r.kind==='cancellation.requested'));assert.ok(records.some(r=>r.kind==='runtime.closed'));assert.equal(records.filter(r=>r.kind==='runtime.opened').length,2);}
  finally{await runtime.close();}
});

test('extracted read tool preserves allowlist and bounded read behavior without network',async()=>{
  const tool=createReadPullRequestTool(agent);const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('offline PR metadata',{status:200});};
  try{await assert.rejects(tool.execute({repository:'foreign/repo',number:1},{} as any,context),/allowlist/);assert.equal(calls,0);const result=await tool.execute({repository:'OWNER/REPO',number:1},{} as any,context);assert.equal((result.output![0] as any).text,'offline PR metadata');assert.equal(calls,1);globalThis.fetch=async()=>new Response('x'.repeat(2*1024*1024+1));await assert.rejects(tool.execute({repository:'owner/repo',number:1},{} as any,context),/2 MiB/);}
  finally{globalThis.fetch=previous;}
});
