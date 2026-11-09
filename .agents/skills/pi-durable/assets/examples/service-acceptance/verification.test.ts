// Generated project: npm test. Verification checks real faux-service outcomes without an external model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { EvidenceStore } from '../src/evidence.js';
import { configureVerification, evaluateDutyAssertions, inspectVerification, validateVerificationContract, verifyDuty, type VerificationContract } from '../src/verification.js';

async function fixture(delayMs=0){
  await mkdir('artifacts',{recursive:true});const project=await mkdtemp(resolve('artifacts/verification-'));
  const workspace=join(project,'workspace with spaces');await mkdir(workspace);await writeFile(join(workspace,'result.txt'),'OBSERVABLE RESULT');
  const path=join(project,'config.json');await writeFile(path,JSON.stringify({version:1,host:'127.0.0.1',port:0,dataDir:'state',provider:{kind:'faux',delayMs},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'worker',name:'Worker',instructions:'Answer the requested observable task.',repositories:[],workspaceRoot:workspace}]}));
  const config=await loadConfig(path),service=await AgentService.open(config);config.port=Number(new URL(service.url).port);await writeFile(path,JSON.stringify(config));
  const token=(await readFile(join(config.dataDir,'console-token'),'utf8')).trim();
  const call=async(route:string,body?:unknown)=>{const response=await fetch(service.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(response.status<400,true);return response.json() as Promise<any>;};
  const submit=async(message='OBSERVED',wait=true)=>{const receipt=await call('/v1/agents/worker/messages',{content:message,requestId:crypto.randomUUID()});if(wait)for(let attempt=0;attempt<100;attempt++){const status=await call(`/v1/agents/worker/submissions/${receipt.submissionId}`);if(status.status==='done')return {...receipt,text:status.text};await delay(20);}return receipt;};
  return {project,workspace,path,config,service,call,submit,close:()=>service.close()};
}
const contract=(assertions:VerificationContract['assertions']=[{id:'observed-result',kind:'output-contains',value:'OBSERVED'}]):VerificationContract=>({version:1,enabled:true,agentId:'worker',goal:'Return the exact observed task evidence.',assertions});

test('a missing or disabled contract never claims work is verified and performs no model generation',async()=>{
  const f=await fixture();try{assert.equal((await inspectVerification(f.path,'worker')).configured,false);const receipt=await verifyDuty(f.path,{agentId:'worker'});assert.equal(receipt.status,'unconfigured');assert.ok(receipt.evidenceId);assert.equal(f.service.stats().worker.providerCalls,0);
    await configureVerification(f.path,{version:1,enabled:false,goal:'Choose concrete acceptance assertions.',assertions:[]});assert.equal((await verifyDuty(f.path,{agentId:'worker'})).status,'unconfigured');
  }finally{await f.close();}
});
test('contracts reject invented scores, empty enabled criteria, duplicate IDs, executable expressions and prototype paths',()=>{
  assert.throws(()=>validateVerificationContract({...contract(),score:1}),/contract/);
  assert.throws(()=>validateVerificationContract(contract([])),/contract/);
  assert.throws(()=>validateVerificationContract({...contract(),agentId:undefined}),/contract/);
  assert.throws(()=>validateVerificationContract(contract([{id:'same',kind:'output-equals',value:'one'},{id:'same',kind:'output-equals',value:'two'}])),/unique/);
  assert.throws(()=>validateVerificationContract(contract([{id:'unsafe',kind:'regex',value:'(a+)+'} as any])),/Unsupported/);
  assert.throws(()=>validateVerificationContract(contract([{id:'unsafe',kind:'output-json-equals',path:['__proto__'],value:1}])),/own-property/);
  assert.throws(()=>validateVerificationContract(contract([{id:'unsafe',kind:'workspace-file-equals',path:'../secret',value:'one'}])),/relative/);
});
test('literal, structural JSON and scoped current-file assertions verify observable conditions',async()=>{
  const f=await fixture();try{
    const checks=await evaluateDutyAssertions(contract([{id:'format',kind:'output-json-equals',path:['result','passed'],value:true},{id:'literal',kind:'output-contains',value:'result'},{id:'forbidden',kind:'output-not-contains',value:'FAILED'},{id:'file',kind:'workspace-file-equals',path:'result.txt',value:'OBSERVABLE RESULT'}]),'{"result":{"passed":true}}',f.workspace);
    assert.ok(checks.every(item=>item.passed));assert.match(checks[3].observedSha256??'',/^[a-f0-9]{64}$/);
    const wrong=await evaluateDutyAssertions(contract([{id:'exact',kind:'output-equals',value:'EXPECTED'},{id:'json',kind:'output-json-equals',path:['constructor'],value:'wrong'}]),'OTHER',f.workspace);assert.ok(wrong.every(item=>!item.passed));
  }finally{await f.close();}
});
test('a completed submission passes only its configured criteria and receipt binds exact evidence/version/output',async()=>{
  const f=await fixture();try{
    const submitted=await f.submit();await configureVerification(f.path,contract());const receipt=await verifyDuty(f.path,{agentId:'worker'});
    assert.equal(receipt.status,'passed');assert.equal(receipt.submissionId,submitted.submissionId);assert.equal(receipt.conversationId,submitted.conversationId);assert.match(receipt.outputSha256??'',/^[a-f0-9]{64}$/);assert.match(receipt.contractSha256??'',/^[a-f0-9]{64}$/);assert.ok(receipt.sourceVersion);assert.equal(receipt.evidenceIds.length,1);
    const store=await EvidenceStore.open(f.config.dataDir);try{assert.equal(store.get('worker',receipt.evidenceId!)?.kind,'verification.completed');assert.equal(store.get('worker',receipt.evidenceIds[0])?.submissionId,submitted.submissionId);}finally{store.close();}
    assert.equal((await inspectVerification(f.path,'worker')).receipts[0].status,'passed');
  }finally{await f.close();}
});
test('model completion can fail the duty contract and never receives a quality pass from its own claim',async()=>{
  const f=await fixture();try{await f.submit('I passed all requirements.');await configureVerification(f.path,contract([{id:'actual-requirement',kind:'output-contains',value:'MANDATORY EVIDENCE'}]));const receipt=await verifyDuty(f.path,{agentId:'worker'});assert.equal(receipt.status,'failed');assert.equal(receipt.checks[0].passed,false);}finally{await f.close();}
});
test('pending, absent and cross-conversation submissions are inconclusive instead of passing old work',async()=>{
  const f=await fixture(500);try{await configureVerification(f.path,contract());const submitted=await f.submit('OBSERVED',false);const pending=await verifyDuty(f.path,{agentId:'worker',submissionId:submitted.submissionId});assert.equal(pending.status,'inconclusive');assert.equal((await verifyDuty(f.path,{agentId:'worker',submissionId:999999})).status,'inconclusive');assert.equal((await verifyDuty(f.path,{agentId:'worker',jobId:'missing'})).status,'inconclusive');}finally{await f.close();}
});
test('offline observation and invalid agent identity never claim successful verification',async()=>{
  const f=await fixture();try{await configureVerification(f.path,contract());const receipt=await verifyDuty(f.path,{agentId:'worker'},{fetch:async()=>{throw new Error('Unavailable');}});assert.equal(receipt.status,'inconclusive');await assert.rejects(verifyDuty(f.path,{agentId:'other'}),/configured agent/);}finally{await f.close();}
});
test('a contract changed during observation invalidates the receipt and escapes cannot inspect private state',async()=>{
  const f=await fixture();try{await f.submit();await configureVerification(f.path,contract());let changed=false;const receipt=await verifyDuty(f.path,{agentId:'worker'},{fetch:async(input,init)=>{const response=await fetch(input,init);if(String(input).includes('/submissions/')&&!changed){changed=true;await writeFile(join(f.project,'verification-contract.json'),JSON.stringify(contract([{id:'different',kind:'output-equals',value:'OTHER'}])));}return response;}});assert.equal(receipt.status,'inconclusive');
    await assert.rejects(configureVerification(f.path,contract([{id:'private',kind:'workspace-file-equals',path:'../state/console-token',value:''}])),/relative/);
  }finally{await f.close();}
});
test('the duty contract must be an ordinary project-owned file',async()=>{
  const f=await fixture();try{const target=join(f.project,'elsewhere.json');await writeFile(target,JSON.stringify(contract()));await symlink(target,join(f.project,'verification-contract.json'));await assert.rejects(inspectVerification(f.path,'worker'),/regular project-local/);}finally{await f.close();}
});
