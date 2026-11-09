// Generated project: npm test. Offline catalogs, recovery definitions and real CLI argv.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {access,mkdir,mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {buildModelRuntime,fetchPublicModelCatalog,loadModelCatalog,type ModelCatalog} from '../src/model-runtime.js';
import {sanitizeCatalogModels,type CatalogModel} from '../src/model-discovery.js';
import {hasDynamicModels,loadConfig,type ServiceConfig} from '../src/config.js';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';

test('the pinned Codex request builder serializes actual model efforts before any network access',async()=>{
  const provider=openaiCodexProvider();
  const credential=`fixture.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')}.signature`;
  const original=globalThis.fetch;let network=0;globalThis.fetch=async()=>{network++;throw new Error('Unexpected network access.');};
  try{
    for(const [id,requested,effective] of [['gpt-6.1-sol','medium','medium'],['gpt-6-astra','high','high'],['gpt-6-luna','low','low'],['gpt-6.1-sol','minimal','low']] as const){
      const model=provider.getModels().find(item=>item.id===id)!;assert.ok(model);let sent:unknown;
      const stream=provider.streamSimple(model,{messages:[{role:'user',content:'Offline request serialization fixture.',timestamp:0}]},{apiKey:credential,reasoning:requested,transport:'sse',onPayload:(body)=>{const payload=body as any;sent={model:payload.model,effort:payload.reasoning?.effort};throw new Error('Stop after inspecting public request metadata.');}});
      await stream.result();assert.deepEqual(sent,{model:id,effort:effective});
    }
    assert.equal(network,0);
  }finally{globalThis.fetch=original;}
});

const execute=promisify(execFile);
const descriptor=(id:string,extra:Record<string,unknown>={}):CatalogModel=>({
  id,name:id,provider:'openai',api:'openai-responses',reasoning:true,input:['text'],contextWindow:200000,maxTokens:32000,
  cost:{input:1,output:2,cacheRead:0.1,cacheWrite:0},
  thinkingLevelMap:{off:null,minimal:'low',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'},...extra,
} as CatalogModel);
function snapshot(models:CatalogModel[]):ModelCatalog{
  const clean=sanitizeCatalogModels(models,'openai');
  const digest=createHash('sha256').update(JSON.stringify([...clean].sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex');
  return {version:1,source:'snapshot',provider:'openai',observedAt:'2026-10-25T12:00:00.000Z',models:clean,digest,availability:'catalog-only'};
}
async function fixture(models:CatalogModel[]=[descriptor('gpt-6.8-sol')]){
  await mkdir('artifacts',{recursive:true});const project=await mkdtemp(resolve('artifacts/model-catalog-'));
  await writeFile(join(project,'catalog.json'),JSON.stringify(snapshot(models)));
  const config={version:1,host:'127.0.0.1',port:0,dataDir:'state',provider:{kind:'openai',model:'latest',catalogFile:'catalog.json',reflection:{model:'latest:astra',thinkingLevel:'xhigh'}},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'coordinator',name:'Coordinator',instructions:'Produce private cited analysis.',repositories:[],modelChoice:{task:'coding'},subagents:{roles:[{id:'worker',instructions:'Read only the assigned facts.',modelChoice:{task:'routine'}},{id:'reviewer',instructions:'Review only the assigned facts.',modelChoice:{task:'review',thinkingLevel:'high'}}]}}]};
  const path=join(project,'config.json');await writeFile(path,JSON.stringify(config));return{project,path,config:await loadConfig(path)};
}

test('public catalog refresh uses its fixed provider URL without credentials and sanitizes metadata',async()=>{
  let calls=0;const raw={...descriptor('gpt-6.8-sol'),baseUrl:'https://private.invalid',headers:{Authorization:'Bearer fixture-secret-value'},privateData:'not part of the model contract'};
  const fetched=await fetchPublicModelCatalog('openai',async(input,options)=>{
    calls++;assert.equal(String(input),'https://pi.dev/api/models/providers/openai?types=chat');
    assert.equal(options?.redirect,'error');assert.deepEqual(options?.headers,{accept:'application/json'});assert.ok(options?.signal);
    return new Response(JSON.stringify([raw]),{headers:{'last-modified':'Sun, 25 Oct 2026 11:00:00 GMT'}});
  });
  assert.equal(calls,1);assert.equal(fetched.source,'pi-public');assert.equal(fetched.availability,'catalog-only');
  assert.equal(fetched.lastModified,'2026-10-25T11:00:00.000Z');assert.equal(fetched.models[0].id,'gpt-6.8-sol');
  assert.doesNotMatch(JSON.stringify(fetched),/private\.invalid|Authorization|Bearer|privateData/);
  assert.equal(fetched.digest,snapshot([descriptor('gpt-6.8-sol')]).digest);
  await assert.rejects(fetchPublicModelCatalog('openai?token=fixture',async()=>{throw new Error('Must not run.');}),/configured providers/);
});

test('public refresh rejects redirects, bad JSON, empty transports and bounded response overflow',async()=>{
  await assert.rejects(fetchPublicModelCatalog('openai',async()=>new Response('',{status:302,headers:{location:'https://other.invalid'}})),/refresh failed/);
  await assert.rejects(fetchPublicModelCatalog('openai',async()=>new Response('not-json')),/not valid JSON/);
  await assert.rejects(fetchPublicModelCatalog('openai',async()=>new Response(JSON.stringify([descriptor('gpt-6.8-sol',{api:'openai-completions'})]))),/no model compatible/);
  await assert.rejects(fetchPublicModelCatalog('openai',async()=>new Response('[]',{headers:{'content-length':String(2*1024*1024+1)}})),/size limit/);
  let cancelled=false;
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){cancelled=true;}});
  await assert.rejects(fetchPublicModelCatalog('openai',async()=>new Response(body)),/size limit/);assert.equal(cancelled,true);
});

test('project snapshots verify provider identity, observation time and exact safe metadata digest',async()=>{
  const {project,config}=await fixture();
  const good=await loadModelCatalog(config);assert.equal(good.source,'snapshot');assert.equal(good.models[0].id,'gpt-6.8-sol');
  const file=join(project,'catalog.json'),original=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...original,digest:'0'.repeat(64)}));await assert.rejects(loadModelCatalog(config),/digest mismatch/);
  await writeFile(file,JSON.stringify({...original,provider:'anthropic'}));await assert.rejects(loadModelCatalog(config),/identity/);
  await writeFile(file,JSON.stringify({...original,observedAt:'not-a-date'}));await assert.rejects(loadModelCatalog(config),/observation time/);
  await writeFile(file,JSON.stringify(snapshot([])));await assert.rejects(loadModelCatalog(config),/empty provider/);
});

test('runtime retains historical definitions but new selection uses only current catalog without inference',async()=>{
  const {project,config}=await fixture([descriptor('gpt-6.7-sol')]);
  const previousKey=process.env.OPENAI_API_KEY,previousFetch=globalThis.fetch;
  process.env.OPENAI_API_KEY='fixture-key-no-model-request';let fetchCalls=0;
  globalThis.fetch=async()=>{fetchCalls++;throw new Error('No network or inference is permitted in this test.');};
  try{
    const first=await buildModelRuntime(config);assert.equal(first.selection.model.modelId,'gpt-6.7-sol');
    assert.equal(first.catalog.availability,'configured-not-probed');
    await writeFile(join(project,'catalog.json'),JSON.stringify(snapshot([descriptor('gpt-6.8-sol')])));
    const next=await buildModelRuntime(config);assert.equal(next.selection.model.modelId,'gpt-6.8-sol');
    assert.ok(next.models.getModel('openai','gpt-6.7-sol'));assert.ok(next.models.getModel('openai','gpt-6.8-sol'));
    assert.throws(()=>next.select({model:'gpt-6.7-sol'}),/exact model is absent/);
    assert.equal((await readdir(join(config.dataDir,'model-catalog/openai'))).filter(name=>name.endsWith('.json')).length,2);
    assert.equal(fetchCalls,0);
    const oldFile=join(config.dataDir,'model-catalog/openai',`${first.catalog.digest}.json`),altered=JSON.parse(await readFile(oldFile,'utf8'));
    altered.models[0].name='Altered historical metadata';await writeFile(oldFile,JSON.stringify(altered));
    await assert.rejects(buildModelRuntime(config),/digest mismatch/);
  }finally{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;}
});

async function cliFixture(){
  const all=[descriptor('gpt-6.7-sol'),descriptor('gpt-6.8-sol'),descriptor('gpt-6-astra'),descriptor('gpt-6-luna')];
  const item=await fixture(all),value=JSON.parse(await readFile(item.path,'utf8'));
  value.agents.push({id:'watcher',name:'Watcher',instructions:'Read only event facts.',repositories:[],modelChoice:{model:'gpt-6.7-sol',thinkingLevel:'low'}});
  await writeFile(item.path,JSON.stringify(value));
  const guard=join(item.project,'no-network.mjs');await writeFile(guard,"globalThis.fetch=async()=>{throw new Error('Unexpected network access in a snapshot-only CLI test.');};\n");
  const env={...process.env,OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',TSX_DISABLE_CACHE:'1'};
  const cli=resolve('src/models-cli.ts');
  const run=async(args:string[],ok=true)=>{
    let result;
    try{
      result=await execute(process.execPath,['--import',pathToFileURL(guard).href,'--import','tsx',cli,...args,'--config',item.path],{cwd:item.project,env,timeout:20000,maxBuffer:2*1024*1024});
    }catch(error){
      if(ok)throw error;
      const failure=error as Error&{code?:number;stderr?:string};assert.equal(typeof failure.code,'number');assert.notEqual(failure.code,0);return failure.stderr??failure.message;
    }
    assert.equal(ok,true,`CLI unexpectedly succeeded: ${args.join(' ')}`);return JSON.parse(result.stdout);
  };
  return {...item,run};
}

test('real model CLI lists and resolves a snapshot without account credentials, inference or state mutation',async()=>{
  const {config,run}=await cliFixture();
  const listed=await run(['list']);assert.equal(listed.source,'snapshot');assert.equal(listed.availability,'catalog-only');
  assert.match(listed.entitlement,/No model inference/);assert.equal(listed.models.length,4);
  assert.equal(listed.models.find((model:any)=>model.id==='gpt-6-astra').capabilityTier,'frontier');
  const role=await run(['resolve','--agent','coordinator','--role','reviewer']);
  assert.equal(role.selection.model.modelId,'gpt-6-astra');assert.equal(role.selection.thinkingLevel,'high');assert.equal(role.inferencePerformed,false);
  const exact=await run(['resolve','--agent','watcher']);assert.equal(exact.selection.model.modelId,'gpt-6.7-sol');
  assert.match(await run(['resolve','--agent','missing'],false),/Unknown configured agent/);
  assert.match(await run(['resolve','--role','worker'],false),/existing --agent and --role/);
  await assert.rejects(access(config.dataDir),{code:'ENOENT'});
});

test('model CLI lock pins all resident, specialist and reflection choices and protects existing files',async()=>{
  const {project,path,run}=await cliFixture(),original=await readFile(path,'utf8');
  const receipt=await run(['lock','--output','config.resolved.json']);assert.equal(receipt.sourceActivated,false);assert.equal(receipt.inferencePerformed,false);
  const locked=await loadConfig(join(project,'config.resolved.json'));assert.equal(hasDynamicModels(locked),false);
  assert.equal(locked.provider.model,'gpt-6.8-sol');assert.equal(locked.provider.thinkingLevel,'medium');
  assert.equal(locked.provider.reflection?.model,'gpt-6-astra');assert.equal(locked.provider.reflection?.thinkingLevel,'xhigh');
  assert.equal(locked.agents[0].modelChoice?.model,'gpt-6.8-sol');assert.equal(locked.agents[1].modelChoice?.model,'gpt-6.7-sol');
  assert.equal(locked.agents[0].subagents?.roles[0].modelChoice?.model,'gpt-6-luna');assert.equal(locked.agents[0].subagents?.roles[1].modelChoice?.model,'gpt-6-astra');
  assert.equal(receipt.selections.length,4);assert.equal(locked.provider.catalogFile,'config.resolved.models.json');
  const frozen=await loadModelCatalog(locked);assert.equal(frozen.digest,receipt.catalogDigest);assert.equal(frozen.availability,'catalog-only');
  assert.equal(await readFile(path,'utf8'),original);
  assert.match(await run(['lock','--output','config.json'],false),/new sibling JSON/);
  const lockedBefore=await readFile(join(project,'config.resolved.json'),'utf8');
  await run(['lock','--output','config.resolved.json'],false);assert.equal(await readFile(join(project,'config.resolved.json'),'utf8'),lockedBefore);
  await writeFile(join(project,'occupied.json'),'KEEP-CONFIG');
  await run(['lock','--output','occupied.json'],false);assert.equal(await readFile(join(project,'occupied.json'),'utf8'),'KEEP-CONFIG');
  await assert.rejects(access(join(project,'occupied.models.json')),{code:'ENOENT'});
  await writeFile(join(project,'catalog-taken.models.json'),'KEEP-CATALOG');
  await run(['lock','--output','catalog-taken.json'],false);assert.equal(await readFile(join(project,'catalog-taken.models.json'),'utf8'),'KEEP-CATALOG');
  await assert.rejects(access(join(project,'catalog-taken.json')),{code:'ENOENT'});
  assert.match(await run(['lock','--output','nested/config.json'],false),/new sibling JSON/);
});
