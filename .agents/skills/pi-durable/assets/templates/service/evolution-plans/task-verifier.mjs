#!/usr/bin/env node
// node evolution-plans/task-verifier.mjs --project <copy> --fixtures <manifest>
// Executes an actual pure task-policy function. Synthetic mechanics evidence only.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const argv=process.argv.slice(2);
const option=name=>{const index=argv.indexOf(name);if(index<0||!argv[index+1])throw new Error(`${name} is required.`);return argv[index+1];};
const project=resolve(option('--project')), manifest=JSON.parse(await readFile(option('--fixtures'),'utf8'));
if(!Array.isArray(manifest)||manifest.length!==1)throw new Error('Expected one frozen synthetic task fixture.');
const bytes=await readFile(manifest[0].path);
if(createHash('sha256').update(bytes).digest('hex')!==manifest[0].sha256)throw new Error('Frozen fixture hash mismatch.');
const fixture=JSON.parse(bytes.toString());
if(fixture.version!==1||fixture.scope!=='synthetic-task-policy-mechanics'||!Array.isArray(fixture.cases)||!fixture.cases.length)throw new Error('Invalid task-policy fixture.');
const {decideTask}=await import(pathToFileURL(resolve(project,'scripts/task-policy.mjs')).href);
const cases=fixture.cases.map(item=>{
  if(typeof item.id!=='string'||typeof item.required!=='boolean'||!['review','ignore'].includes(item.expected))throw new Error('Invalid task-policy case.');
  const actual=decideTask(structuredClone(item.input));
  const correct=actual===item.expected;
  return{id:item.id,passed:item.required?correct:true,score:correct?1:0};
});
process.stdout.write(JSON.stringify({passed:cases.every(item=>item.passed),score:cases.reduce((sum,item)=>sum+item.score,0)/cases.length,cases,scope:fixture.scope,limitation:'Executes a deterministic task-policy demonstration; does not measure a live model, PR review quality, semantic-family transfer, or autonomous improvement.'})+'\n');
