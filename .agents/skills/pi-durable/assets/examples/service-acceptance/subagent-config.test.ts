// Generated project: npm test. Validate role loading and explicit evolution scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {loadConfig} from '../src/config.js';
import {EvidenceStore,captureVersion} from '../src/evidence.js';
import {EvolutionManager} from '../src/evolution.js';

async function fixture(){
  await mkdir('artifacts',{recursive:true});const project=await mkdtemp(resolve('artifacts/subagent-config-'));
  await mkdir(join(project,'prompts'));await mkdir(join(project,'checks'));
  for(const role of ['supervisor','reviewer','author','unconfigured'])await writeFile(join(project,`prompts/${role}.md`),`${role} trusted file instructions.`);
  await writeFile(join(project,'checks/verify.mjs'),'console.log(JSON.stringify({passed:true,score:0,cases:[{id:"one",passed:true,score:0}]}));');
  await writeFile(join(project,'checks/cases.json'),'["one"]');
  const config={version:1,host:'127.0.0.1',port:0,dataDir:'state',provider:{kind:'faux'},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'supervisor',name:'Supervisor',instructions:'Fallback',instructionsFile:'prompts/supervisor.md',repositories:[],subagents:{maxChildrenPerRun:4,roles:[{id:'reviewer',instructions:'Fallback',instructionsFile:'prompts/reviewer.md'},{id:'author',instructions:'Fallback',instructionsFile:'prompts/author.md'}]}}]};
  const path=join(project,'config.json');await writeFile(path,JSON.stringify(config));return{project,path,config};
}

test('role prompts load from the independent project and invalid role/budget configurations are rejected',async()=>{
  const {path,config}=await fixture(),loaded=await loadConfig(path);
  assert.equal(loaded.agents[0].subagents?.roles[0].instructions,'reviewer trusted file instructions.');
  config.agents[0].subagents.roles.push({...config.agents[0].subagents.roles[0]});await writeFile(path,JSON.stringify(config));
  await assert.rejects(loadConfig(path),/unique lowercase/);config.agents[0].subagents.roles.pop();
  config.agents[0].subagents.maxChildrenPerRun=33;await writeFile(path,JSON.stringify(config));await assert.rejects(loadConfig(path),/maxChildrenPerRun/);
  config.agents[0].subagents.maxChildrenPerRun=4;config.agents[0].subagents.roles[0].instructionsFile='../outside.md';await writeFile(path,JSON.stringify(config));
  await assert.rejects(loadConfig(path),/project-relative/);
});

test('requested improvement targets a configured specialist prompt and rejects an unrelated prompt',async()=>{
  const {project,path}=await fixture(),config=await loadConfig(path),evidence=await EvidenceStore.open(config.dataDir);
  evidence.append({agentId:'supervisor',kind:'feedback.recorded',details:{summary:'Review omitted an evidence citation.'}});evidence.close();
  const manager=await EvolutionManager.open(project,path);
  try{
    const base={agentId:'supervisor',goal:'Improve cited evidence.',verifierPath:'checks/verify.mjs',fixturePaths:['checks/cases.json']};
    const request=await manager.request({...base,allowedPaths:['prompts/reviewer.md']});
    assert.deepEqual(request.allowedPaths,['prompts/reviewer.md']);
    assert.equal(await readFile(join(project,'prompts/reviewer.md'),'utf8'),'reviewer trusted file instructions.');
    assert.deepEqual((await manager.request({...base,allowedPaths:['prompts/author.md']})).allowedPaths,['prompts/author.md']);
    await assert.rejects(manager.request({...base,allowedPaths:['prompts/unconfigured.md']}),/configured supervisor\/specialist/);
  }finally{manager.close();}
});

test('source version changes when inline specialist policy or delegation bounds change',async()=>{
  const {project,path}=await fixture(),config=await loadConfig(path),agent=config.agents[0];
  const before=await captureVersion(project,agent,config.provider);
  agent.subagents!.roles[0].instructions='Changed inline specialist policy.';
  const prompt=await captureVersion(project,agent,config.provider);assert.notEqual(prompt.digest,before.digest);
  agent.subagents!.maxChildrenPerRun=3;
  assert.notEqual((await captureVersion(project,agent,config.provider)).digest,prompt.digest);
});
