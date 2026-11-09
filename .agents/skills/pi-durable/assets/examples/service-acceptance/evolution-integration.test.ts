// Generated project: npm test. Exercise actual offline reflection and authenticated evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { EvidenceStore } from '../src/evidence.js';
import { EvolutionManager } from '../src/evolution.js';
import { generateReflection, parseReflectionDraft } from '../src/reflector.js';
import { AgentService } from '../src/server.js';

async function fixture(){
  await mkdir('artifacts',{recursive:true});const project=await mkdtemp(resolve('artifacts/evolution-integration-'));
  await mkdir(join(project,'prompts'));await mkdir(join(project,'checks'));
  await writeFile(join(project,'prompts/reviewer.md'),'Review privately.');
  await writeFile(join(project,'checks/verify.mjs'),'console.log(JSON.stringify({passed:true,score:0,cases:[{id:"one",passed:true}]}));');
  await writeFile(join(project,'checks/cases.json'),'["one"]');
  await writeFile(join(project,'package.json'),JSON.stringify({name:'pi-durable-agent-service',type:'module'}));
  const configPath=join(project,'config.json');await writeFile(configPath,JSON.stringify({version:1,host:'127.0.0.1',port:0,dataDir:'state',provider:{kind:'faux'},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'reviewer',name:'Reviewer',instructions:'Fallback',instructionsFile:'prompts/reviewer.md',repositories:[]}]}));
  return {project,configPath};
}

test('portable prompt configuration loads relative to config and omits host project path from deployment JSON',async()=>{
  const {project,configPath}=await fixture(),config=await loadConfig(configPath);
  assert.equal(config.agents[0].instructions,'Review privately.');assert.equal(config.projectDir,project);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(config)),'projectDir'),false);
  const value=JSON.parse(await readFile(configPath,'utf8'));value.agents[0].instructionsFile='../escape.md';await writeFile(configPath,JSON.stringify(value));
  await assert.rejects(loadConfig(configPath),/project-relative/);
});

test('requested no-tool faux reflection is durable, repeatable, inactive, and rejects changed request packs',{timeout:15000},async()=>{
  const {project,configPath}=await fixture(),config=await loadConfig(configPath);const evidence=await EvidenceStore.open(config.dataDir);
  evidence.append({agentId:'reviewer',kind:'feedback.recorded',details:{summary:'The previous review omitted a cited file.'}});evidence.close();
  const manager=await EvolutionManager.open(project,configPath);
  try{
    const request=await manager.request({agentId:'reviewer',goal:'Improve cited-file coverage.',allowedPaths:['prompts/reviewer.md'],verifierPath:'checks/verify.mjs',fixturePaths:['checks/cases.json']});
    const pack=await manager.reflect(request.id),before=await readFile(join(project,'prompts/reviewer.md'),'utf8');
    const first=await generateReflection(pack.directory,configPath),second=await generateReflection(pack.directory,configPath);
    const a=JSON.parse(await readFile(first.draft,'utf8')),b=JSON.parse(await readFile(second.draft,'utf8'));
    assert.equal(a.mode,'faux');assert.equal(a.reflection.candidate,null);assert.equal(a.activated,false);
    assert.equal(a.submissionId,b.submissionId);assert.equal(a.conversationId,b.conversationId);assert.notEqual(first.draft,second.draft);
    assert.equal(await readFile(join(project,'prompts/reviewer.md'),'utf8'),before);
    const path=join(pack.directory,'request.json'),changed=JSON.parse(await readFile(path,'utf8'));changed.goal='tampered';await writeFile(path,JSON.stringify(changed));
    await assert.rejects(generateReflection(pack.directory,configPath),/seal mismatch/);
  }finally{manager.close();}
});

test('model draft preserves complete long proposed scripts while discarding private fields',()=>{
  const script='export const name = "complete";\n'.repeat(150);
  const result=parseReflectionDraft(JSON.stringify({findings:['Observable issue'],thinking:'private fixture',candidate:{requestId:'one',evidenceIds:['id'],hypothesis:'Bounded hypothesis',decision:'Use a complete script',expectedBenefit:'Better coverage',regressionRisks:[],reasoning:'private fixture',changes:[{path:'src/tools/example.ts',beforeHash:'a'.repeat(64),content:script}]}}));
  assert.equal((result.candidate!.changes as any[])[0].content,script);assert.doesNotMatch(JSON.stringify(result),/private fixture/);
});

test('authenticated evidence API and feedback persist without enabling model reflection',{timeout:15000},async()=>{
  const {configPath}=await fixture(),config=await loadConfig(configPath),service=await AgentService.open(config);
  try{
    const token=(await readFile(join(config.dataDir,'console-token'),'utf8')).trim(),headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    assert.equal((await fetch(service.url+'/v1/agents/reviewer/evidence')).status,401);
    const response=await fetch(service.url+'/v1/agents/reviewer/evidence',{headers}),records=(await response.json() as any).records;
    const feedback=await fetch(service.url+'/v1/agents/reviewer/feedback',{method:'POST',headers,body:JSON.stringify({summary:'Prefer evidence-linked findings.',evidenceIds:[records[0].id]})});
    assert.equal(feedback.status,201);assert.ok(service.stats().reviewer.providerCalls===0);
    const invalid=await fetch(service.url+'/v1/agents/reviewer/feedback',{method:'POST',headers,body:JSON.stringify({summary:'Unknown evidence',evidenceIds:['missing']})});assert.equal(invalid.status,400);
  }finally{await service.close();}
});
