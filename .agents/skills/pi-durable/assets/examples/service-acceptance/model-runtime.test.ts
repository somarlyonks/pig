// Generated project: npm test. Exercise real configuration, ownership and frozen model policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {BACKGROUND_CONTEXT as background,withAbortSignal,awaitWithContext} from '@earendil-works/chord/context';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {Harness,createRegistry,defineExtension} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {getReflectionModelChoice,loadConfig,type ServiceConfig} from '../src/config.js';
import {EvidenceStore,captureVersion} from '../src/evidence.js';
import {EvolutionManager} from '../src/evolution.js';
import {AgentRuntime,createEvidenceHooks} from '../src/runtime.js';
import {configureSubagentProfiles,makeSubagentTool,SubagentProfiles} from '../src/subagents.js';
import {sanitizeCatalogModels} from '../src/model-discovery.js';
import {selectModel} from '../src/model-selection.js';

const bounded=()=>withAbortSignal(AbortSignal.timeout(8000),background);
async function fixture(){
  await mkdir('artifacts',{recursive:true});const project=await mkdtemp(resolve('artifacts/model-runtime-'));
  await mkdir(join(project,'prompts'));await mkdir(join(project,'checks'));await mkdir(join(project,'models'));
  await writeFile(join(project,'prompts/reviewer.md'),'Review the assigned evidence.');
  await writeFile(join(project,'checks/verify.mjs'),'console.log(JSON.stringify({passed:true,score:0,cases:[{id:"one",passed:true,score:0}]}));');
  await writeFile(join(project,'checks/cases.json'),'["one"]');
  const config:ServiceConfig={version:1,host:'127.0.0.1',port:0,dataDir:'state',provider:{kind:'faux'},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'reviewer',name:'Reviewer',instructions:'Fallback',instructionsFile:'prompts/reviewer.md',repositories:[],modelChoice:{task:'coding'},subagents:{roles:[{id:'analyst',instructions:'Analyze evidence.',modelChoice:{model:'latest:sol',task:'review',thinkingLevel:'high'}}]}}]};
  const path=join(project,'config.json');await writeFile(path,JSON.stringify(config));return{project,path,config};
}
function catalogModels(ids:string[]){return sanitizeCatalogModels(ids.map(id=>({id,name:id,provider:'openai',api:'openai-responses',reasoning:true,input:['text'],contextWindow:100000,maxTokens:10000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},thinkingLevelMap:{off:null,minimal:'low',xhigh:'xhigh',max:'max'}})),'openai');}

test('model choices validate known reasoning levels, task profiles and project-local catalog paths',async()=>{
  const {project,path,config}=await fixture();await writeFile(join(project,'models/catalog.json'),'{}');
  config.provider={kind:'openai',model:'latest',thinkingLevel:'medium',catalogMode:'refresh',catalogFile:'models/catalog.json',reflection:{task:'reflection',thinkingLevel:'high'}};
  await writeFile(path,JSON.stringify(config));const loaded=await loadConfig(path);
  assert.equal(loaded.agents[0].subagents!.roles[0].modelChoice!.thinkingLevel,'high');
  (config.provider as any).thinkingLevel='ultra';await writeFile(path,JSON.stringify(config));await assert.rejects(loadConfig(path),/thinkingLevel/);
  config.provider.thinkingLevel='high';(config.agents[0].modelChoice as any).task='invented';await writeFile(path,JSON.stringify(config));await assert.rejects(loadConfig(path),/modelChoice/);
  config.agents[0].modelChoice={task:'routine'};config.provider.catalogFile='../outside.json';await writeFile(path,JSON.stringify(config));await assert.rejects(loadConfig(path),/project-relative/);
});

test('control conversations retain their model and effort after restart while new job threads get current choices',{timeout:20000},async()=>{
  const {path}=await fixture(),config=await loadConfig(path);let runtime=await AgentRuntime.open(config,config.agents[0]);
  const originalModel=(await runtime.root.agent(bounded())).model!;
  const retainedModel={...originalModel,modelId:'stored-historical-model'};
  await runtime.root.configure({model:retainedModel,thinkingLevel:'high'},bounded());await runtime.close();
  runtime=await AgentRuntime.open(config,config.agents[0]);
  try{
    const control=await runtime.root.agent(bounded());assert.deepEqual(control.model,retainedModel);assert.equal(control.thinkingLevel,'high');
    const next=await runtime.conversation('fresh-job'),fresh=await next.agent(bounded());assert.deepEqual(fresh.model,originalModel);assert.notEqual(fresh.model!.modelId,retainedModel.modelId);
    assert.equal(runtime.calls,0);const record=runtime.evidence.list('reviewer').find(item=>item.kind==='model.conversation-profile')!;
    assert.deepEqual(record.details.model,retainedModel);assert.equal(record.details.effort,'high');
  }finally{await runtime.close();}
});

test('a pending parent keeps its frozen specialist model and effort before first delegation across restart',{timeout:25000},async()=>{
  await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/model-parent-profile-'));
  const faux=fauxProvider({tokensPerSecond:Infinity,models:[{id:'faux-1',reasoning:true},{id:'faux-2',reasoning:true}]});const models=createModels();models.setProvider(faux.provider);
  const parentModel={provider:faux.getModel().provider,modelId:'faux-1'},oldProfile={analyst:{model:parentModel,thinkingLevel:'low' as const}};
  const changedProfile={analyst:{model:{...parentModel,modelId:'faux-2'},thinkingLevel:'high' as const}};
  const input={mode:'parallel',tasks:[{role:'analyst',task:'Report the explicit fixture fact.'}]};
  const traces:any[]=[];const hooks=createEvidenceHooks((kind,details,ids)=>traces.push({kind,details,ids}),parentModel);
  const registry=createRegistry();const initialExtension=defineExtension({name:'model-policy-test',tools:[makeSubagentTool({model:parentModel,roleModels:oldProfile,roles:{analyst:'Report the assigned fact.'},tools:[],trace:(kind,details,ids)=>traces.push({kind,details,ids})})],hooks});registry.install(initialExtension);
  let started!:()=>void;const entered=new Promise<void>(done=>{started=done;});
  faux.setResponses([async(_request,options)=>{started();await new Promise<void>((_resolve,reject)=>{if(options?.signal?.aborted)reject(new Error('Closed before delegation.'));else options?.signal?.addEventListener('abort',()=>reject(new Error('Closed before delegation.')),{once:true});});return fauxAssistantMessage('Unreachable');}]);
  const database=join(directory,'harness.sqlite');let harness=await Harness.open(await openNodeSqliteStorage(database),{models,registry,settings:{retry:{enabled:false}}},bounded());
  const root=await harness.root(bounded(),{agent:{model:parentModel,thinkingLevel:'medium',extensions:[initialExtension]}});
  await harness.commit(tx=>configureSubagentProfiles(tx,root.id,oldProfile),bounded());
  const submission=await root.submit({type:'input',content:'PARENT one bounded task',requestId:'parent-request'},bounded());await awaitWithContext(entered,bounded());await harness.close(background);
  const delegate=makeSubagentTool({model:parentModel,roleModels:changedProfile,roles:{analyst:'Report the assigned fact.'},tools:[],trace:(kind,details,ids)=>traces.push({kind,details,ids})});
  const extension=defineExtension({name:'model-policy-test',tools:[delegate],hooks});registry.install(extension);
  faux.setResponses(Array(8).fill((request:any)=>request.messages.at(-1)?.role==='toolResult'?fauxAssistantMessage('Parent synthesis complete.'):request.messages.some((message:any)=>message.role==='user'&&String(message.content).startsWith('PARENT'))?fauxAssistantMessage(fauxToolCall('delegate_tasks',input),{stopReason:'toolUse'}):fauxAssistantMessage('Fixture fact observed.')));
  harness=await Harness.open(await openNodeSqliteStorage(database),{models,registry,settings:{retry:{enabled:false}}},bounded());
  try{
    harness.resume();assert.equal((await(await harness.submission(submission.id,bounded()))!.wait(bounded())).status,'done');
    const admission=traces.find(item=>item.kind==='subagents.admitted')!,child=admission.details.children[0];
    assert.deepEqual(child.model,parentModel);assert.equal(child.effort,'low');
    const actual=(await(await harness.conversation(child.conversationId,bounded()))!.agent(bounded()));assert.deepEqual(actual.model,parentModel);assert.equal(actual.thinkingLevel,'low');
    const requests=traces.filter(item=>item.kind==='model.request'&&item.ids.conversationId===child.conversationId);assert.ok(requests.length);assert.deepEqual(requests[0].details.model,parentModel);assert.equal(requests[0].details.effort,'low');
  }finally{await harness.close(background);}
});

test('real improvement requests reject dynamic model selection and protect the locked catalog snapshot',async()=>{
  const {project,path,config}=await fixture();
  config.provider={kind:'openai',model:'latest'};await writeFile(path,JSON.stringify(config));
  let manager=await EvolutionManager.open(project,path);
  const request={agentId:'reviewer',goal:'Improve cited evidence.',allowedPaths:['prompts/reviewer.md'],verifierPath:'checks/verify.mjs',fixturePaths:['checks/cases.json']};
  try{await assert.rejects(manager.request(request),/models lock/);}finally{manager.close();}
  config.provider={kind:'openai',model:'gpt-6.1-sol',catalogMode:'pi-cache'};config.agents[0].subagents!.roles[0].modelChoice!.model='gpt-6-astra';await writeFile(path,JSON.stringify(config));
  manager=await EvolutionManager.open(project,path);
  try{await assert.rejects(manager.request(request),/models lock/);}finally{manager.close();}
  config.provider.catalogMode='bundled';await writeFile(path,JSON.stringify(config));manager=await EvolutionManager.open(project,path);
  try{await assert.rejects(manager.request(request),/Collect agent/);}finally{manager.close();}
  config.provider={kind:'faux',catalogFile:'models/catalog.json'};await writeFile(join(project,'models/catalog.json'),'{"fixture":1}');await writeFile(path,JSON.stringify(config));
  const loaded=await loadConfig(path),evidence=await EvidenceStore.open(loaded.dataDir);evidence.append({agentId:'reviewer',kind:'feedback.recorded',details:{summary:'Observed a missing citation.'}});evidence.close();
  manager=await EvolutionManager.open(project,path);
  try{
    const admitted=await manager.request(request);assert.ok(admitted.source.some(file=>file.path==='models/catalog.json'));
    await writeFile(join(project,'models/catalog.json'),'{"fixture":2}');await assert.rejects(manager.reflect(admitted.id),/Source changed/);
  }finally{manager.close();}
});

test('version evidence binds resolved model effort and per-role choices without retaining private reasoning',async()=>{
  const {project,path}=await fixture(),config=await loadConfig(path),agent=config.agents[0];
  const catalog={source:'snapshot',digest:'a'.repeat(64),availability:'catalog-only'};
  const selection={catalog,selected:{model:{provider:'openai-codex',modelId:'gpt-6.1-sol'},effort:'medium',reason:'Latest compatible balanced model.'},roles:[{role:'analyst',model:{provider:'openai-codex',modelId:'gpt-6-astra'},effort:'high',reason:'Review profile.'}]};
  const first=await captureVersion(project,agent,config.provider,selection);
  const changed=await captureVersion(project,agent,config.provider,{...selection,selected:{...selection.selected,effort:'high'}});assert.notEqual(first.digest,changed.digest);
  const store=await EvidenceStore.open(config.dataDir);
  try{const record=store.append({agentId:'reviewer',kind:'model.selected',details:selection});assert.equal((record.details.selected as any).effort,'medium');assert.equal((record.details.roles as any)[0].effort,'high');}
  finally{store.close();}
});

test('a retained root version reports its frozen role choices while new jobs receive a newer role model',{timeout:20000},async()=>{
  const {project,path,config}=await fixture();
  config.provider={kind:'openai',model:'latest',catalogFile:'models/catalog.json'};
  config.agents[0].modelChoice={task:'coding'};config.agents[0].subagents!.roles[0].modelChoice={task:'review'};
  const writeCatalog=async(ids:string[])=>{const models=catalogModels(ids);await writeFile(join(project,'models/catalog.json'),JSON.stringify({version:1,provider:'openai',observedAt:'2026-10-25T12:00:00Z',models,digest:createHash('sha256').update(JSON.stringify([...models].sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex')}));};
  await writeCatalog(['gpt-6.1-sol','gpt-6-astra']);await writeFile(path,JSON.stringify(config));
  const previousKey=process.env.OPENAI_API_KEY,previousFetch=globalThis.fetch;process.env.OPENAI_API_KEY='fixture-configured-no-inference';globalThis.fetch=async()=>{throw new Error('This profile-only test must not perform network requests.');};
  let runtime:AgentRuntime|undefined;
  try{
    let loaded=await loadConfig(path);runtime=await AgentRuntime.open(loaded,loaded.agents[0]);assert.equal(runtime.calls,0);await runtime.close();runtime=undefined;
    await writeCatalog(['gpt-6.1-sol','gpt-6.2-astra']);loaded=await loadConfig(path);runtime=await AgentRuntime.open(loaded,loaded.agents[0]);
    const controlVersion=runtime.versionForConversation(runtime.root.id).conversationVersion as any;
    assert.equal(controlVersion.modelSelection.selected.model.modelId,'gpt-6.1-sol');assert.equal(controlVersion.modelSelection.roles[0].model.modelId,'gpt-6-astra');
    assert.equal(runtime.version.policy.modelSelection!.roles![0].model.modelId,'gpt-6.2-astra');
    const fresh=await runtime.conversation('new-model-job'),profiles=await runtime.harness.snapshot(SubagentProfiles,fresh.id,bounded());assert.equal(profiles!.roles.analyst.model.modelId,'gpt-6.2-astra');assert.equal(profiles!.roles.analyst.thinkingLevel,'high');assert.equal(runtime.calls,0);
  }finally{await runtime?.close();globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;}
});

test('service reflection resolution remains identical after locking despite a resident-agent model override',async()=>{
  const {config}=await fixture();config.provider={kind:'openai',model:'latest'};config.agents[0].modelChoice={model:'gpt-6.1-sol',task:'coding',thinkingLevel:'medium'};
  const models=catalogModels(['gpt-6.1-sol','gpt-6-astra','gpt-6-luna']);
  const resident=selectModel(models,config.agents[0].modelChoice,config.provider.model);
  const reflection=selectModel(models,getReflectionModelChoice(config),config.provider.model);assert.equal(resident.model.modelId,'gpt-6.1-sol');assert.equal(reflection.model.modelId,'gpt-6-astra');assert.equal(reflection.thinkingLevel,'high');
  config.provider.reflection={model:reflection.model.modelId,thinkingLevel:reflection.thinkingLevel,task:'reflection'};
  const locked=selectModel(models,getReflectionModelChoice(config),config.provider.model);assert.deepEqual(locked.model,reflection.model);assert.equal(locked.thinkingLevel,reflection.thinkingLevel);
  config.provider={kind:'openai',model:'gpt-6.1-sol'};assert.equal(selectModel(models,getReflectionModelChoice(config),config.provider.model).model.modelId,'gpt-6.1-sol');
});
