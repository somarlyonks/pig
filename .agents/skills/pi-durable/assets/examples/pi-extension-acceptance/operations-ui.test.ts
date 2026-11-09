// Generated console: npm test. Local UI effects are injected; no service or model is invoked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentOperation,runEvolutionMenu,reviewOperation,type OperationsApi } from '../src/operations-ui.js';

function fixture(){
  const calls:Array<{name:string;args:any[]}>=[],output:string[]=[];
  const api:any={};
  for(const name of ['startManaged','stopManaged','restartManaged','pauseManaged','resumeManaged','recoverManaged','archiveManaged','readManagedLogs','configureVerification','verifyAgent','runEvolution','freezeModelsForEvolution','rebuildAgent'])api[name]=async(...args:any[])=>{calls.push({name,args});return {passed:true,action:name};};
  api.inspectManaged=async(...args:any[])=>{calls.push({name:'inspectManaged',args});return {managed:true,state:'stopped',project:{projectDir:'C:/workspace/.pi/durable/helper'}};};
  api.inspectQuality=async(...args:any[])=>{calls.push({name:'inspectQuality',args});return {contract:{version:1,enabled:false,goal:'Configure actual acceptance checks.',assertions:[]},latestVerification:{status:'unconfigured'}};};
  api.manageLoginStartup=async(...args:any[])=>{calls.push({name:'manageLoginStartup',args});return {executed:false,plan:{installPath:'C:/owned/login-task',target:'owned-task'}};};
  const answers:{confirm:boolean;json:string|undefined;id:string|undefined;selection:string|undefined}={confirm:true,json:undefined,id:'request-1',selection:undefined};
  const ctx:any={hasUI:true,mode:'rpc',ui:{confirm:async()=>answers.confirm,editor:async()=>answers.json,input:async()=>answers.id,select:async(_title:string,values:string[])=>values.find(value=>value===answers.selection||answers.selection&&value.startsWith(answers.selection.slice(0,18))),notify:()=>{}}};
  const target={name:'helper/helper',agentId:'helper',connection:{id:'helper',name:'Helper',configPath:'C:/workspace/config.json',dataDir:'C:/workspace/state',baseUrl:'http://127.0.0.1:4799'}};
  const controller=new AbortController(),options={api:api as OperationsApi,signal:controller.signal,connectionsFile:'C:/workspace/connections.json',show:(message:string)=>output.push(message)};
  return {calls,api,answers,ctx,target,controller,options,output};
}

test('lifecycle review cancellation prevents every owner mutation',async()=>{
  for(const action of ['start','stop','restart','pause','resume','recover-owner','archive']){
    const f=fixture();f.answers.confirm=false;
    await runAgentOperation(f.ctx,f.target,action,f.options);
    assert.deepEqual(f.calls.map(call=>call.name),['inspectManaged'],action);
  }
});

test('explicit lifecycle actions preserve the exact managed connection and local cancellation signal',async()=>{
  for(const [action,method] of [['start','startManaged'],['stop','stopManaged'],['restart','restartManaged'],['pause','pauseManaged'],['resume','resumeManaged'],['recover-owner','recoverManaged'],['archive','archiveManaged']]){
    const f=fixture();await runAgentOperation(f.ctx,f.target,action,f.options);
    const called=f.calls.find(call=>call.name===method)!;assert.ok(called,action);
    assert.equal(called.args[0],f.target.connection);assert.equal(called.args[1].signal,f.controller.signal);
    if(action==='archive')assert.equal(called.args[1].connectionsFile,f.options.connectionsFile);
  }
});

test('external owners cannot be mutated through console lifecycle actions',async()=>{
  const f=fixture();f.api.inspectManaged=async()=>({managed:false,state:'unmanaged'});
  await assert.rejects(runAgentOperation(f.ctx,f.target,'stop',f.options),/external owner/);
  assert.equal(f.calls.length,0);
});

test('verification targets an actual selected job and submission without a model or approval loop',async()=>{
  const f=fixture();f.answers.confirm=false;
  await runAgentOperation(f.ctx,f.target,'verify',f.options,{jobId:'job:17',submissionId:23});
  const called=f.calls[0];assert.equal(called.name,'verifyAgent');assert.equal(called.args[1].jobId,'job:17');assert.equal(called.args[1].submissionId,23);
  assert.equal(f.calls.some(call=>call.name==='runEvolution'),false);
});

test('criteria require an object and concrete review before changing the project contract',async()=>{
  const f=fixture();f.answers.json=JSON.stringify({version:1,enabled:true,agentId:'helper',goal:'Return the fixture token.',assertions:[{id:'token',kind:'output-equals',value:'READY'}]});
  f.answers.confirm=false;await runAgentOperation(f.ctx,f.target,'criteria',f.options);
  assert.equal(f.calls.filter(call=>call.name==='configureVerification').length,0);
  f.answers.confirm=true;await runAgentOperation(f.ctx,f.target,'criteria',f.options);
  const saved=f.calls.find(call=>call.name==='configureVerification')!;assert.equal(saved.args[1].assertions[0].value,'READY');
});

test('evolution request review cancellation imports nothing',async()=>{
  const f=fixture();f.answers.json=JSON.stringify({agentId:'helper',goal:'Reduce redundant reads.',allowedPaths:['prompts/helper.md'],verifierPath:'checks/verify.mjs',fixturePaths:['checks/cases.json']});f.answers.confirm=false;
  await runEvolutionMenu(f.ctx,f.target,'request',f.options);
  assert.equal(f.calls.length,0);
});

test('reflection draft generation is explicit and inactive; export makes no generation request',async()=>{
  for(const action of ['reflect','generate']){
    const f=fixture();await runEvolutionMenu(f.ctx,f.target,action,f.options);
    const called=f.calls.find(call=>call.name==='runEvolution')!;
    assert.equal(called.args[1].action,'reflect');assert.equal(called.args[1].generate,action==='generate');assert.equal(called.args[1].requestId,'request-1');
    assert.equal(f.calls.some(call=>call.name==='rebuildAgent'||call.name==='startManaged'),false);
  }
});

test('candidate activation rebuilds and smoke checks but leaves startup explicit',async()=>{
  for(const action of ['promote','rollback','recover']){
    const f=fixture();await runEvolutionMenu(f.ctx,f.target,action,f.options);
    assert.deepEqual(f.calls.map(call=>call.name),['runEvolution','rebuildAgent']);
    assert.equal(f.calls[0].args[1].action,action);assert.match(f.output.join('\n'),/durable start/);
  }
});

test('a failing activation build never starts the new source',async()=>{
  const f=fixture();f.api.rebuildAgent=async()=>{throw new Error('Build failed; keep this owner stopped.');};
  await assert.rejects(runEvolutionMenu(f.ctx,f.target,'promote',f.options),/keep this owner stopped/);
  assert.equal(f.calls.some(call=>call.name==='startManaged'),false);
});

test('aborted or noninteractive reviews cannot authorize mutations',async()=>{
  const f=fixture();f.controller.abort();assert.equal(await reviewOperation(f.ctx,'Stop','Concrete owner',f.controller.signal),false);
  f.ctx.hasUI=false;await assert.rejects(reviewOperation(f.ctx,'Stop','Concrete owner',new AbortController().signal),/interactive Pi review/);
});

test('login installation requires review of the owned plan and cancellation installs no job',async()=>{
  const f=fixture();f.answers.selection='Install login startup (owner must be stopped)';f.answers.confirm=false;
  await runAgentOperation(f.ctx,f.target,'login',f.options);
  assert.deepEqual(f.calls.map(call=>call.args[1]),['plan']);
  f.calls.length=0;f.answers.confirm=true;await runAgentOperation(f.ctx,f.target,'login',f.options);
  assert.deepEqual(f.calls.map(call=>call.args[1]),['plan','install']);
});
