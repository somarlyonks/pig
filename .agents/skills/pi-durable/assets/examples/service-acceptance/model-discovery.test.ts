// Generated project: npm test. Fake RPC peers exercise discovery without credentials or inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import {discoverPiModels} from '../src/model-discovery.js';

const sample={id:'gpt-6.1-sol',provider:'openai-codex',name:'GPT-6.1 Sol',api:'openai-codex-responses',reasoning:true,input:['text','image'],contextWindow:500000,maxTokens:128000,cost:{input:2,output:10,cacheRead:0.1,cacheWrite:2.5,tiers:[{inputTokensAbove:272000,input:4,output:15,cacheRead:0.2,cacheWrite:5}]},thinkingLevelMap:{off:null,minimal:'low',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'}};
async function peer(body:string){
  await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/model discovery ')),path=join(directory,'fake cli.mjs');
  const source=`import {createInterface} from 'node:readline';
const model=${JSON.stringify(sample)};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
for await(const line of createInterface({input:process.stdin})){const request=JSON.parse(line);const response=models=>({type:'response',command:'get_available_models',id:request.id,success:true,data:{models}});${body}}
`;
  await writeFile(path,source);return path;
}

test('Pi inventory uses read-only no-context flags, exact provider filtering and a safe metadata projection',async()=>{
  const path=await peer(`const required=['--offline','--mode','rpc','--no-session','--no-approve','--no-context-files','--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--no-themes'];if(required.some(flag=>!process.argv.includes(flag))||process.argv.includes('--credentials')||request.type!=='get_available_models')process.exit(4);send(response([{...model,headers:{authorization:'Bearer fixture-secret-value'},baseUrl:'https://example.invalid/?token=fixture-secret-value',credential:'fixture-secret-value'}, {...model,provider:'openrouter',id:'openai/gpt-6.1-sol'}]));`);
  const inventory=await discoverPiModels(path,{provider:'openai-codex'});
  assert.equal(inventory.version,1);assert.equal(inventory.source,'pi-rpc');assert.equal(inventory.availability,'configured-not-probed');assert.ok(Number.isFinite(Date.parse(inventory.observedAt)));
  assert.equal(inventory.models.length,1);assert.equal(inventory.models[0].id,sample.id);assert.deepEqual(inventory.models[0].cost,sample.cost);
  assert.deepEqual(getSupportedThinkingLevels({...inventory.models[0],baseUrl:''}),['minimal','low','medium','high','xhigh','max']);
  assert.doesNotMatch(JSON.stringify(inventory),/fixture-secret|baseUrl|authorization|credential|https:/);
});

test('Pi inventory ignores unsolicited events and responses for other request IDs',async()=>{
  const path=await peer(`send({type:'message_update',message:{text:'irrelevant private fixture'}});send({...response([{...model,id:'wrong-model'}]),id:'unrelated-request'});send(response([model]));`);
  const inventory=await discoverPiModels(path);assert.deepEqual(inventory.models.map(model=>model.id),[sample.id]);assert.doesNotMatch(JSON.stringify(inventory),/irrelevant private/);
});

test('Pi inventory rejects duplicated matching responses and ambiguous model identities',async()=>{
  const duplicated=await peer(`const value=response([model]);process.stdout.write(JSON.stringify(value)+'\\n'+JSON.stringify(value)+'\\n');`);
  await assert.rejects(discoverPiModels(duplicated),/duplicate responses/);
  const models=await peer(`send(response([model,model]));`);
  await assert.rejects(discoverPiModels(models),/invalid model metadata/);
});

test('Pi inventory errors never expose peer stderr, raw RPC errors or credential-like model text',async()=>{
  const failing=await peer(`process.stderr.write('Bearer fixture-secret-value');send({type:'response',command:'get_available_models',id:request.id,success:false,error:'Bearer fixture-secret-value'});`);
  await assert.rejects(discoverPiModels(failing),error=>error instanceof Error&&error.message==='Pi model inventory request failed.'&&!error.message.includes('fixture-secret'));
  const credential=await peer(`send(response([{...model,name:'Bearer fixture-secret-value'}]));`);
  await assert.rejects(discoverPiModels(credential),error=>error instanceof Error&&error.message==='Pi model inventory returned invalid model metadata.');
});

test('Pi inventory validates model shapes and rejects invalid JSON or a mismatched RPC command',async()=>{
  for(const body of [`send(response([{...model,contextWindow:-1}]));`,`send(response([{...model,thinkingLevelMap:{off:{secret:'fixture'}}}]));`,`process.stdout.write('not-json\\n');`,`send({...response([model]),command:'prompt'});`]){
    await assert.rejects(discoverPiModels(await peer(body)),/invalid model metadata|invalid JSON|request failed/);
  }
});

test('Pi inventory times out or cancels a nonresponding peer and cleans up its process',{timeout:10000},async()=>{
  const path=await peer(`setInterval(()=>{},1000);`),started=Date.now();
  await assert.rejects(discoverPiModels(path,{timeoutMs:150}),/timed out/);assert.ok(Date.now()-started<5000);
  const controller=new AbortController(),waiting=discoverPiModels(path,{signal:controller.signal});setTimeout(()=>controller.abort(),100);
  await assert.rejects(waiting,/cancelled/);
  await assert.rejects(discoverPiModels(path,{signal:AbortSignal.abort()}),/cancelled/);
});

test('Pi inventory bounds output and fails closed on missing responses',{timeout:10000},async()=>{
  const excessive=await peer(`process.stdout.write('x'.repeat(9*1024*1024));`);
  await assert.rejects(discoverPiModels(excessive),/output limit/);
  const missing=await peer(`process.exit(0);`);
  await assert.rejects(discoverPiModels(missing),/without a matching response/);
});

test('Pi inventory requires a bounded exact provider, absolute JS entry and bounded deadline',async()=>{
  await assert.rejects(discoverPiModels('pi.cmd'),/absolute installed Pi/);
  const path=await peer(`send(response([]));`);
  await assert.rejects(discoverPiModels(path,{provider:'openai*'}),/exact bounded provider/);
  await assert.rejects(discoverPiModels(path,{timeoutMs:0}),/timeoutMs/);
  assert.deepEqual((await discoverPiModels(path,{provider:'missing'})).models,[]);
});
