// Generated console: npm test. Real Node argv and project files; no real model or external service.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configureVerification, freezeModelsForEvolution, inspectQuality, rebuildAgent, runEvolution, verifyAgent } from '../src/agent-quality.js';
import type { ServiceConnection } from '../src/client.js';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
  await mkdir('artifacts',{recursive:true});const project=await mkdtemp(resolve('artifacts/quality-'));
  await mkdir(join(project,'state'));await mkdir(join(project,'dist/src'),{recursive:true});const host='// Owned fixture host.\n';await writeFile(join(project,'agent-host.mjs'),host);
  await writeFile(join(project,'managed-agent.json'),JSON.stringify({version:1,kind:'pi-durable-console-managed',agentId:'worker',serviceId:'fixture',configFile:'config.json',dataDir:'state',hostFile:'agent-host.mjs',hostSha256:sha(host)}));
  await writeFile(join(project,'config.json'),JSON.stringify({version:1,host:'127.0.0.1',port:47997,dataDir:'state',provider:{kind:'faux'},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'worker',name:'Worker',instructions:'Inspect the selected workspace.',repositories:[]}]}));
  const script=`import{readFile,writeFile}from'node:fs/promises';const args=process.argv.slice(2),inputIndex=args.indexOf('--input'),input=inputIndex>=0?JSON.parse(await readFile(args[inputIndex+1],'utf8')):undefined;await writeFile('last-operation.json',JSON.stringify({args,input}));console.log(JSON.stringify({passed:true,args,input}));`;
  const verification=script.replace('console.log(JSON.stringify({passed:true,args,input}));',`console.log(JSON.stringify(args[0]==='inspect'?{configured:false,contract:{version:1,enabled:false,assertions:[]},receipts:[]}:args[0]==='configure'?{configured:true,contractSha256:'a'.repeat(64)}:{version:1,id:'fixture-receipt',at:'2026-10-25T00:00:00Z',reason:'Fixture observation.',evidenceIds:[],agentId:'worker',status:'inconclusive',checks:[],jobId:args.includes('--job')?args[args.indexOf('--job')+1]:undefined,submissionId:args.includes('--submission')?Number(args[args.indexOf('--submission')+1]):undefined}));`);
  await writeFile(join(project,'dist/src/verify-cli.js'),verification);await writeFile(join(project,'dist/src/evolve-cli.js'),script);await writeFile(join(project,'package.json'),'{"type":"module"}');
  const connection:ServiceConnection={id:'fixture',name:'Fixture',configPath:join(project,'config.json'),dataDir:join(project,'state'),baseUrl:'http://127.0.0.1:47997'};
  return {project,connection,last:async()=>JSON.parse(await readFile(join(project,'last-operation.json'),'utf8'))};
}
test('quality operations route exact selected identities and bounded JSON through explicit Node argv',async()=>{
  const f=await fixture();await inspectQuality(f.connection);assert.deepEqual((await f.last()).args,['inspect','--config',f.connection.configPath,'--agent','worker']);
  const contract={version:1,enabled:true,agentId:'worker',goal:'Observe a concrete result; $(never execute)',assertions:[{id:'result',kind:'output-contains',value:'PASS'}]};
  await configureVerification(f.connection,contract);assert.deepEqual((await f.last()).input,contract);
  await verifyAgent(f.connection,{jobId:'event:with spaces; $(literal)',submissionId:17});assert.deepEqual((await f.last()).args,['verify','--config',f.connection.configPath,'--agent','worker','--job','event:with spaces; $(literal)','--submission','17']);
});
test('quality bridge rejects wrong agents, invalid identities and oversized inputs before starting work',async()=>{
  const f=await fixture();await assert.rejects(configureVerification(f.connection,{agentId:'other'}),/selected managed agent/);await assert.rejects(verifyAgent(f.connection,{submissionId:0}),/positive/);
  await assert.rejects(runEvolution(f.connection,{action:'request',input:{agentId:'other'}}),/target this agent/);
  await assert.rejects(runEvolution(f.connection,{action:'request',input:{agentId:'worker',goal:'x'.repeat(600000)}}),/512 KiB/);
  await assert.rejects(runEvolution(f.connection,{action:'reflect',requestId:'../outside'}),/exact request/);
  await assert.rejects(runEvolution(f.connection,{action:'evaluate',proposalId:'one',generate:true}),/supported evolution/);
});
test('evolution command bridge preserves explicit reflection generation and complete inactive proposal input',async()=>{
  const f=await fixture();await runEvolution(f.connection,{action:'history'});assert.equal((await f.last()).args[0],'history');
  await runEvolution(f.connection,{action:'reflect',requestId:'request-one'});assert.ok(!(await f.last()).args.includes('--generate'));
  await runEvolution(f.connection,{action:'reflect',requestId:'request-one',generate:true});assert.ok((await f.last()).args.includes('--generate'));
  const candidate={requestId:'request-one',changes:[{path:'prompts/worker.md',content:'Literal $() text',beforeHash:'a'.repeat(64)}]};await runEvolution(f.connection,{action:'propose',requestId:'request-one',input:candidate});assert.deepEqual((await f.last()).input,candidate);
  await assert.rejects(runEvolution(f.connection,{action:'propose',requestId:'request-two',input:candidate}),/cite the selected request/);
});
test('activation and model freezing require a verified stopped owner and never kill a recorded PID',async()=>{
  const f=await fixture();await writeFile(join(f.project,'state/console-token'),'a'.repeat(64));await writeFile(join(f.project,'state/creation-owner.json'),JSON.stringify({version:1,pid:process.pid,nonce:randomUUID(),configPath:f.connection.configPath}));
  await assert.rejects(runEvolution(f.connection,{action:'promote',proposalId:'proposal-one'}),/Drain and stop/);
  await assert.rejects(freezeModelsForEvolution(f.connection),/Drain and stop/);assert.doesNotThrow(()=>process.kill(process.pid,0));
});
test('model freeze preserves configuration identity and backs up original bytes without starting the service',async()=>{
  const f=await fixture();const config=JSON.parse(await readFile(f.connection.configPath,'utf8'));config.provider={kind:'openai-codex',model:'latest',catalogMode:'refresh'};await writeFile(f.connection.configPath,JSON.stringify(config));const before=await readFile(f.connection.configPath);
  const locker=`import{readFile,writeFile}from'node:fs/promises';const args=process.argv.slice(2),output=args[args.indexOf('--output')+1],configPath=args[args.indexOf('--config')+1],raw=JSON.parse(await readFile(configPath,'utf8'));raw.provider.model='gpt-6.1-sol';raw.provider.thinkingLevel='medium';raw.provider.catalogFile=output.split(/[\\\\/]/).pop().replace(/\\.json$/,'.models.json');await writeFile(raw.provider.catalogFile,'{}');await writeFile(output,JSON.stringify(raw));console.log(JSON.stringify({selections:[{target:'worker',model:'gpt-6.1-sol'}]}));`;
  await writeFile(join(f.project,'dist/src/models-cli.js'),locker);
  const result=await freezeModelsForEvolution(f.connection);assert.equal(result.alreadyFrozen,false);assert.ok('backup' in result);assert.deepEqual(await readFile(result.backup),before);const frozen=JSON.parse(await readFile(f.connection.configPath,'utf8'));assert.equal(frozen.provider.model,'gpt-6.1-sol');assert.equal(frozen.agents[0].id,'worker');assert.equal(frozen.dataDir,'state');assert.equal(result.inferencePerformed,false);
  assert.equal((await freezeModelsForEvolution(f.connection)).alreadyFrozen,true);
});
test('a model locker cannot silently change workspace, prompts, events or project identity',async()=>{
  const f=await fixture();const config=JSON.parse(await readFile(f.connection.configPath,'utf8'));config.provider={kind:'openai-codex',model:'latest'};await writeFile(f.connection.configPath,JSON.stringify(config));const before=await readFile(f.connection.configPath);
  await writeFile(join(f.project,'dist/src/models-cli.js'),`import{readFile,writeFile}from'node:fs/promises';const a=process.argv.slice(2),out=a[a.indexOf('--output')+1],raw=JSON.parse(await readFile(a[a.indexOf('--config')+1],'utf8'));raw.provider.model='gpt-6.1-sol';raw.provider.catalogFile='fixed.models.json';raw.agents[0].instructions='Unexpected authority';await writeFile(out,JSON.stringify(raw));console.log('{}');`);
  await assert.rejects(freezeModelsForEvolution(f.connection),/task permissions or agent identity/);assert.deepEqual(await readFile(f.connection.configPath),before);
});
test('rebuild runs the project compiler and its faux smoke while leaving the host stopped',async()=>{
  const f=await fixture();await mkdir(join(f.project,'node_modules/typescript/bin'),{recursive:true});await writeFile(join(f.project,'node_modules/typescript/bin/tsc'),`require('node:fs').writeFileSync('build-observed.txt','compiled');`);await writeFile(join(f.project,'node_modules/typescript/package.json'),'{"type":"commonjs"}');await writeFile(join(f.project,'dist/src/smoke.js'),'console.log(JSON.stringify({passed:true,provider:"faux",networkUsed:false}));');const result=await rebuildAgent(f.connection);assert.equal(result.passed,true);assert.equal(result.serviceStarted,false);assert.equal(await readFile(join(f.project,'build-observed.txt'),'utf8'),'compiled');
});
test('aborted and failed local operations retain logs and never replay a mutation',async()=>{
  const f=await fixture();const controller=new AbortController();controller.abort();await assert.rejects(inspectQuality(f.connection,{signal:controller.signal}),/cancelled/);
  await writeFile(join(f.project,'dist/src/verify-cli.js'),'console.error("Failed bounded local validation");process.exitCode=1;');await assert.rejects(verifyAgent(f.connection),/inspect|Inspect/);
});
test('the lifecycle operation lock excludes quality activation and model freezing',async()=>{
  const f=await fixture();await writeFile(join(f.project,'state/management.lock'),'Another explicit lifecycle action.');await assert.rejects(freezeModelsForEvolution(f.connection),/Another lifecycle action/);await assert.rejects(runEvolution(f.connection,{action:'promote',proposalId:'proposal-one'}),/Another lifecycle action/);await assert.rejects(configureVerification(f.connection,{agentId:'worker',version:1,enabled:false,goal:'Explicit criteria.',assertions:[]}),/Another lifecycle action/);
});
test('cancelling a running local verifier stops only that child and records one attempt',async()=>{
  const f=await fixture();await writeFile(join(f.project,'dist/src/verify-cli.js'),'import{writeFile}from"node:fs/promises";await writeFile("attempt-observed.txt","one");setTimeout(()=>{},30000);');const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),300);
  try{await assert.rejects(verifyAgent(f.connection,{signal:controller.signal}),/cancelled/);assert.equal(await readFile(join(f.project,'attempt-observed.txt'),'utf8'),'one');assert.doesNotThrow(()=>process.kill(process.pid,0));}finally{clearTimeout(timer);}
});
test('a fabricated or cross-agent quality pass is rejected even when the child exits successfully',async()=>{
  const f=await fixture();await writeFile(join(f.project,'dist/src/verify-cli.js'),'console.log(JSON.stringify({id:"fixture-receipt",at:"2026-10-25T00:00:00Z",reason:"Unsupported success claim.",evidenceIds:[],agentId:"worker",status:"passed",checks:[]}));');await assert.rejects(verifyAgent(f.connection),/attributable/);
  await writeFile(join(f.project,'dist/src/verify-cli.js'),'console.log(JSON.stringify({agentId:"other",status:"inconclusive",checks:[]}));');await assert.rejects(verifyAgent(f.connection),/different target/);
  await writeFile(join(f.project,'dist/src/verify-cli.js'),'console.log(JSON.stringify({id:"fixture",at:"2026-10-25",reason:"Missing task identity.",evidenceIds:[],agentId:"worker",status:"inconclusive",checks:[]}));');await assert.rejects(verifyAgent(f.connection,{jobId:'expected-job'}),/different target/);
});
