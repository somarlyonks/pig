// Generated project: npm test. These verify lifecycle mechanics, not model quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { chmod,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { EvolutionManager,type ProposalInput } from '../src/evolution.js';
import { EvidenceStore } from '../src/evidence.js';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const original='Observe evidence.\r\nMake a cautious decision.\r\n';
const improved='Observe evidence.\nMake a cautious decision.\nUse independent regression cases.\n';
const verifier=`import {readFile} from 'node:fs/promises';import {join} from 'node:path';const argv=process.argv.slice(2);const project=argv[argv.indexOf('--project')+1];const fixtures=JSON.parse(await readFile(argv[argv.indexOf('--fixtures')+1],'utf8'));const fixture=JSON.parse(await readFile(fixtures[0].path,'utf8'));const prompt=await readFile(join(project,'prompts/worker.md'),'utf8');const passed=prompt.includes(fixture.required);console.log(JSON.stringify({passed,score:prompt.includes('independent regression')?0.8:0.3,cases:[{id:'retain-observation-contract',passed}]}));`;
async function fixture(evidence=true){
  await mkdir('artifacts',{recursive:true});const project=await mkdtemp(resolve('artifacts/evolution-'));
  for(const dir of ['src/tools','scripts','prompts','evaluation'])await mkdir(join(project,dir),{recursive:true});
  await writeFile(join(project,'config.json'),JSON.stringify({version:1,host:'127.0.0.1',port:0,dataDir:'state',provider:{kind:'faux'},github:{mode:'off',intervalMs:60000,initialScan:'baseline'},agents:[{id:'worker',name:'Worker',instructions:'fallback',instructionsFile:'prompts/worker.md',repositories:[]}]}));
  await writeFile(join(project,'prompts/worker.md'),original);await writeFile(join(project,'src/tools/observe.ts'),'export const observe = 1;\n');
  await writeFile(join(project,'scripts/compare.mjs'),'export const compare = 1;\n');
  await writeFile(join(project,'scripts/project.py'),'# Generated management wrapper fixture\n');
  await writeFile(join(project,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',outDir:'dist',types:[]},include:['src/**/*.ts']}));
  await writeFile(join(project,'package.json'),JSON.stringify({private:true,type:'module'}));
  await writeFile(join(project,'evaluation/check.mjs'),verifier);await writeFile(join(project,'evaluation/cases.json'),JSON.stringify({required:'Observe evidence.'}));
  await symlink(resolve('node_modules'),join(project,'node_modules'),process.platform==='win32'?'junction':'dir');
  if(evidence){const store=await EvidenceStore.open(join(project,'state'));store.append({agentId:'worker',kind:'decision.recorded',details:{observation:'Repeated decision missed an independent regression case.',decision:'Record this as an improvement hypothesis, not as a proven cause.'}});store.close();}
  const manager=await EvolutionManager.open(project);
  const input={agentId:'worker',goal:'Improve regression decisions while preserving observation handling.',allowedPaths:['prompts/worker.md','src/tools/observe.ts','scripts/compare.mjs'],verifierPath:'evaluation/check.mjs',fixturePaths:['evaluation/cases.json'],timeoutMs:30000};
  return{project,manager,input,cleanup:async()=>{manager.close();await rm(join(project,'node_modules'),{force:true});}};
}
function candidate(request:any,content=improved):ProposalInput{return{requestId:request.id,evidenceIds:request.evidence.map((e:any)=>e.id),hypothesis:'An explicit regression instruction may improve the observed missed-case behavior.',decision:'Test the prompt change against a fixed baseline before activation.',expectedBenefit:'Higher score on fixed regression cases.',regressionRisks:['May be overfit to the example; this verifier proves mechanics only.'],changes:[{path:'prompts/worker.md',beforeHash:request.source.find((f:any)=>f.path==='prompts/worker.md').sha256,content}]};}
async function ready(){const f=await fixture();const request=await f.manager.request(f.input);const proposal=await f.manager.propose(request.id,candidate(request));return{...f,request,proposal};}
function canonical(value:any):string{if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return`{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;return JSON.stringify(value);}

test('improvement requires a trusted request, evidence, and an active bounded patch surface',async()=>{
  const f=await fixture(false);try{
    await assert.rejects(f.manager.request(f.input),/evidence/i);
    await assert.rejects(f.manager.propose('missing',{requestId:'missing'} as ProposalInput),/ENOENT/);
    const store=await EvidenceStore.open(join(f.project,'state'));store.append({agentId:'worker',kind:'decision.recorded',details:{decision:'Observed case'}});store.close();
    await assert.rejects(f.manager.request({...f.input,allowedPaths:['src/evolution.ts']}),/active prompt|existing/);
    await assert.rejects(f.manager.request({...f.input,allowedPaths:['scripts/project.py']}),/management wrapper/);
    await assert.rejects(f.manager.request({...f.input,allowedPaths:['src/tools/workspace.ts']}),/permission tools/);
    await assert.rejects(f.manager.request({...f.input,allowedPaths:['src/tools/read-pull-request.ts']}),/permission tools/);
    await assert.rejects(f.manager.request({...f.input,allowedPaths:['../outside.md']}),/project-relative/);
    await assert.rejects(f.manager.request({...f.input,verifierPath:'scripts/compare.mjs'}),/cannot be candidate/);
    const request=await f.manager.request(f.input);
    await assert.rejects(f.manager.propose(request.id,{...candidate(request),evidenceIds:[randomUUID()]}),/evidence/);
    await assert.rejects(f.manager.propose(request.id,{...candidate(request),requestId:'another-request'}),/exact request/);
    await assert.rejects(f.manager.propose(request.id,{...candidate(request),changes:[{path:'prompts/worker.md',beforeHash:'0'.repeat(64),content:improved}]}),/preimage/);
    assert.equal(await readFile(join(f.project,'prompts/worker.md'),'utf8'),original);
  }finally{await f.cleanup();}
});

test('reflection and importing a proposal remain inactive; untested proposals cannot be promoted',async()=>{
  const f=await ready();try{
    const pack=await f.manager.reflect(f.request.id);const exported=JSON.parse(await readFile(join(pack.directory,'evidence.json'),'utf8'));assert.equal(exported.length,1);
    assert.match(await readFile(join(pack.directory,'reflection-prompt.md'),'utf8'),/untrusted observations/);
    await assert.rejects(f.manager.promote(f.proposal.id),/stopped service|consistent files/);
    assert.equal(await readFile(join(f.project,'prompts/worker.md'),'utf8'),original);
    assert.equal(await lstat(join(f.project,'state/evolution/evaluations')).then(()=>true,()=>false),false);
  }finally{await f.cleanup();}
});

test('duty criteria are protected study source and history returns metadata without candidate source',async()=>{
  const f=await fixture();try{
    await writeFile(join(f.project,'verification-contract.json'),JSON.stringify({version:1,enabled:false,goal:'Frozen duty criteria.',assertions:[]}));
    const request=await f.manager.request(f.input);assert.ok(request.source.some(file=>file.path==='verification-contract.json'));
    const proposal=await f.manager.propose(request.id,candidate(request));const history=await f.manager.history('worker');assert.equal(history.requests[0].id,request.id);assert.equal(history.proposals[0].id,proposal.id);assert.ok(!JSON.stringify(history).includes('beforeHash'));
    await assert.rejects(f.manager.history('other'),/Unknown evolution agent/);
    await writeFile(join(f.project,'verification-contract.json'),JSON.stringify({version:1,enabled:true,agentId:'worker',goal:'Changed criteria.',assertions:[{id:'changed',kind:'output-equals',value:'PASS'}]}));
    await assert.rejects(f.manager.reflect(request.id),/Source changed/);
  }finally{await f.cleanup();}
});

test('the actual evolution CLI refuses cross-agent request/proposal IDs and lists bounded history',async()=>{
  const f=await ready();try{
    for(const [action,flag,value] of [['reflect','--request',f.request.id],['evaluate','--proposal',f.proposal.id]]){
      const result=spawnSync(process.execPath,['--import','tsx',resolve('src/evolve-cli.ts'),action,'--config',join(f.project,'config.json'),'--agent','other',flag,value],{encoding:'utf8',timeout:10000});
      assert.equal(result.status,1,result.error?.message??result.stderr);assert.match(result.stderr,/different agent/);
    }
    const history=spawnSync(process.execPath,['--import','tsx',resolve('src/evolve-cli.ts'),'history','--config',join(f.project,'config.json'),'--agent','worker'],{encoding:'utf8',timeout:10000});assert.equal(history.status,0,history.error?.message??history.stderr);const body=JSON.parse(history.stdout);assert.equal(body.agentId,'worker');assert.equal(body.proposals[0].id,f.proposal.id);assert.ok(!history.stdout.includes('beforeHash'));
  }finally{await f.cleanup();}
});

test('paired build/verifier improvement promotes and rolls back exact original bytes',{timeout:30000},async()=>{
  const f=await ready();try{
    const evaluation=await f.manager.evaluate(f.proposal.id);assert.equal(evaluation.passed,true);assert.equal(evaluation.baseline.verification?.score,0.3);assert.equal(evaluation.candidate.verification?.score,0.8);
    assert.equal(await readFile(join(f.project,'prompts/worker.md'),'utf8'),original);
    await f.manager.promote(f.proposal.id);assert.equal(await readFile(join(f.project,'prompts/worker.md'),'utf8'),improved);
    const promoted=await f.manager.history('worker');assert.equal(promoted.transactions[0].stage,'committed');assert.equal(promoted.transactions[0].operation,'promote');assert.equal(promoted.transactions[0].sourceState,'matches-candidate');assert.deepEqual(promoted.currentActivation.activeProposalIds,[f.proposal.id]);assert.match(promoted.transactions[0].digest,/^[a-f0-9]{64}$/);assert.match(promoted.transactions[0].evaluationDigest,/^[a-f0-9]{64}$/);assert.equal(promoted.transactions[0].fileCount,1);
    assert.equal('files' in promoted.transactions[0],false);assert.ok(!JSON.stringify(promoted).includes(Buffer.from(original).toString('base64')));assert.ok(!JSON.stringify(promoted).includes(Buffer.from(improved).toString('base64')));
    await f.manager.rollback(f.proposal.id);assert.deepEqual(await readFile(join(f.project,'prompts/worker.md')),Buffer.from(original));
    const restored=await f.manager.history('worker');assert.equal(restored.transactions[0].stage,'rolled-back');assert.equal(restored.transactions[0].operation,'rollback');assert.equal(restored.transactions[0].sourceState,'matches-preimage');assert.deepEqual(restored.currentActivation.activeProposalIds,[]);assert.deepEqual(restored.currentActivation.restoredProposalIds,[f.proposal.id]);assert.equal(restored.currentActivation.scope,'source-bytes');
    const store=await EvidenceStore.open(join(f.project,'state'));const kinds=store.list('worker',100).map(r=>r.kind);store.close();assert.ok(kinds.includes('evolution.promotion'));assert.ok(kinds.includes('evolution.rollback'));
    await assert.rejects(f.manager.promote(f.proposal.id),/already activated|stopped service/);
  }finally{await f.cleanup();}
});

test('failed cases, unchanged scores, and mismatched case identities block promotion',{timeout:30000},async()=>{
  for(const mode of ['failed','unchanged','mismatch']){
    const f=await fixture();try{
      if(mode==='mismatch')await writeFile(join(f.project,'evaluation/check.mjs'),verifier.replace("id:'retain-observation-contract'","id:prompt.includes('independent regression')?'different-case':'retain-observation-contract'"));
      const request=await f.manager.request(f.input),proposal=await f.manager.propose(request.id,candidate(request,mode==='failed'?'independent regression with no observation contract':mode==='unchanged'?`${original}One extra neutral line.\n`:improved));
      assert.equal((await f.manager.evaluate(proposal.id)).passed,false);
      await assert.rejects(f.manager.promote(proposal.id),/stopped service|consistent files/);
      assert.equal(await readFile(join(f.project,'prompts/worker.md'),'utf8'),original);
    }finally{await f.cleanup();}
  }
});

test('stale source/config/verifier and tampered proposals or evaluations are rejected',{timeout:30000},async()=>{
  for(const mode of ['source','config','verifier','proposal','evaluation']){
    const f=await ready();try{
      if(mode==='evaluation')await f.manager.evaluate(f.proposal.id);
      if(mode==='source')await writeFile(join(f.project,'src/tools/observe.ts'),'export const observe = 2;\n');
      if(mode==='config')await writeFile(join(f.project,'config.json'),`${await readFile(join(f.project,'config.json'),'utf8')}\n`);
      if(mode==='verifier')await writeFile(join(f.project,'evaluation/cases.json'),'{"required":"different"}');
      if(mode==='proposal'||mode==='evaluation'){
        const path=join(f.project,`state/evolution/${mode==='proposal'?'proposals':'evaluations'}/${f.proposal.id}.json`),value=JSON.parse(await readFile(path,'utf8'));value[mode==='proposal'?'decision':'passed']=mode==='proposal'?'altered':false;await writeFile(path,JSON.stringify(value));
      }
      await assert.rejects(mode==='evaluation'?f.manager.promote(f.proposal.id):f.manager.evaluate(f.proposal.id));
      assert.equal(await readFile(join(f.project,'prompts/worker.md'),'utf8'),original);
    }finally{await f.cleanup();}
  }
});

test('live owner and queued/running jobs block activation; rollback refuses changed active bytes',{timeout:30000},async()=>{
  const f=await ready();try{
    await f.manager.evaluate(f.proposal.id);
    const owner=new DatabaseSync(join(f.project,'state/owner.sqlite'));owner.exec('BEGIN EXCLUSIVE');
    await assert.rejects(f.manager.promote(f.proposal.id),/stopped service/);owner.close();
    const catalog=new DatabaseSync(join(f.project,'state/catalog.sqlite'));catalog.exec("CREATE TABLE jobs(status TEXT);INSERT INTO jobs VALUES ('queued')");catalog.close();
    await assert.rejects(f.manager.promote(f.proposal.id),/stopped service/);
    const drain=new DatabaseSync(join(f.project,'state/catalog.sqlite'));drain.exec("UPDATE jobs SET status='done'");drain.close();
    await mkdir(join(f.project,'state/agents/worker'),{recursive:true});
    const control=new DatabaseSync(join(f.project,'state/agents/worker/harness.sqlite'));control.exec("CREATE TABLE tasks(status TEXT);CREATE TABLE submissions(status TEXT);INSERT INTO submissions VALUES ('queued')");control.close();
    await assert.rejects(f.manager.promote(f.proposal.id),/stopped service/);
    const finish=new DatabaseSync(join(f.project,'state/agents/worker/harness.sqlite'));finish.exec("UPDATE submissions SET status='done'");finish.close();
    await f.manager.promote(f.proposal.id);await writeFile(join(f.project,'prompts/worker.md'),`${improved}External edit.\n`);
    const changed=await f.manager.history('worker');assert.equal(changed.transactions[0].sourceState,'changed');assert.deepEqual(changed.currentActivation.activeProposalIds,[]);assert.deepEqual(changed.currentActivation.changedProposalIds,[f.proposal.id]);
    await assert.rejects(f.manager.rollback(f.proposal.id),/stopped service/);assert.match(await readFile(join(f.project,'prompts/worker.md'),'utf8'),/External edit/);
  }finally{await f.cleanup();}
});

test('recovery restores all preimages from an interrupted multi-file activation journal',{timeout:30000},async()=>{
  const f=await fixture();try{
    const request=await f.manager.request(f.input),input=candidate(request);input.changes.push({path:'src/tools/observe.ts',beforeHash:request.source.find(f=>f.path==='src/tools/observe.ts')!.sha256,content:'export const observe = 2;\n'});
    const proposal=await f.manager.propose(request.id,input);await f.manager.evaluate(proposal.id);await f.manager.promote(proposal.id);
    const path=join(f.project,`state/evolution/transactions/${proposal.id}.json`),transaction=JSON.parse(await readFile(path,'utf8'));delete transaction.digest;transaction.stage='prepared';
    // Emulate a crash after one file rename and before the commit receipt.
    await writeFile(join(f.project,'src/tools/observe.ts'),'export const observe = 1;\n');await writeFile(path,JSON.stringify({...transaction,digest:hash(canonical(transaction))}));
    const pending=await f.manager.history('worker');assert.equal(pending.transactions[0].stage,'prepared');assert.equal(pending.transactions[0].sourceState,'mixed-known');assert.deepEqual(pending.currentActivation.pendingProposalIds,[proposal.id]);assert.equal('files' in pending.transactions[0],false);
    assert.deepEqual((await f.manager.recover()).recovered,[proposal.id]);assert.equal(await readFile(join(f.project,'prompts/worker.md'),'utf8'),original);assert.equal(await readFile(join(f.project,'src/tools/observe.ts'),'utf8'),'export const observe = 1;\n');
    const recovered=await f.manager.history('worker');assert.deepEqual(recovered.currentActivation.pendingProposalIds,[]);assert.deepEqual(recovered.currentActivation.restoredProposalIds,[proposal.id]);assert.equal(recovered.transactions[0].sourceState,'matches-preimage');
    assert.deepEqual((await f.manager.recover()).recovered,[]);
  }finally{await f.cleanup();}
});

test('patch paths cannot follow a source symlink outside the generated project',async()=>{
  const f=await fixture();try{
    const outside=join(f.project,'external.md');await writeFile(outside,'outside');
    try{await symlink(outside,join(f.project,'prompts/link.md'),'file');}catch(error){if(['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))return;throw error;}
    await assert.rejects(f.manager.request(f.input),/symlink/i);
  }finally{await f.cleanup();}
});

test('copied verifier and fixture integrity is checked after each independent side',{timeout:30000},async()=>{
  const f=await fixture();try{
    await writeFile(join(f.project,'evaluation/check.mjs'),verifier.replace("import {readFile}","import {readFile,writeFile}")+"\nif(prompt.includes('independent regression'))await writeFile(fixtures[0].path,'{}');\n");
    const request=await f.manager.request(f.input),proposal=await f.manager.propose(request.id,candidate(request));
    await assert.rejects(f.manager.evaluate(proposal.id),/Copied trusted verifier or fixture/);
    await assert.rejects(f.manager.promote(proposal.id));assert.equal(await readFile(join(f.project,'evaluation/cases.json'),'utf8'),JSON.stringify({required:'Observe evidence.'}));
  }finally{await f.cleanup();}
});

test('timed verifier subprocess trees cannot keep evaluation pipes open',{timeout:30000},async()=>{
  const f=await fixture();try{
    await writeFile(join(f.project,'evaluation/check.mjs'),"import{spawn}from'node:child_process';spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});await new Promise(r=>setTimeout(r,60000));");
    const request=await f.manager.request({...f.input,timeoutMs:2000}),proposal=await f.manager.propose(request.id,candidate(request));
    const started=Date.now(),evaluation=await f.manager.evaluate(proposal.id);assert.equal(evaluation.passed,false);assert.ok(evaluation.baseline.verifier?.timedOut);assert.ok(Date.now()-started<18000);
  }finally{await f.cleanup();}
});

test('reflection exports exactly the selected bounded evidence with explicit omission counts',async()=>{
  const f=await fixture();try{
    const store=await EvidenceStore.open(join(f.project,'state'));for(let n=0;n<30;n++)store.append({agentId:'worker',kind:'decision.recorded',details:{decision:`Decision ${n}`,summary:'x'.repeat(1500)}});store.close();
    const request=await f.manager.request(f.input),pack=await f.manager.reflect(request.id),records=JSON.parse(await readFile(join(pack.directory,'evidence.json'),'utf8'));
    assert.equal(request.evidenceSelection.selectedRecords,20);assert.equal(request.evidenceSelection.omittedFromWindow,11);assert.equal(records.length,20);assert.deepEqual(records.map((r:any)=>r.id),request.evidence.map(r=>r.id));assert.ok(records.every((r:any)=>r.details.summary.length===1500));
  }finally{await f.cleanup();}
});
