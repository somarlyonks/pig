#!/usr/bin/env node
// node evaluation/local-verifier.mjs --project <copy> --fixtures <frozen-manifest.json>
// Mechanics demonstration only. This does not execute a model or measure decisions.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
const argv=process.argv.slice(2);
const option=name=>{const value=argv[argv.indexOf(name)+1];if(!argv.includes(name)||!value)throw new Error(`${name} is required.`);return value;};
const project=resolve(option('--project'));
const manifest=JSON.parse(await readFile(option('--fixtures'),'utf8'));
if(!Array.isArray(manifest)||manifest.length!==1)throw new Error('This mechanics verifier accepts exactly one frozen fixture.');
const bytes=await readFile(manifest[0].path);
if(createHash('sha256').update(bytes).digest('hex')!==manifest[0].sha256)throw new Error('Frozen fixture hash mismatch.');
const fixture=JSON.parse(bytes.toString());
if(fixture.version!==1||fixture.scope!=='mechanics-only'||typeof fixture.promptPath!=='string'||!Array.isArray(fixture.cases)||!fixture.cases.length)throw new Error('Invalid mechanics fixture.');
const target=resolve(project,fixture.promptPath),local=relative(project,target);
if(isAbsolute(local)||local.startsWith('..')||!fixture.promptPath.startsWith('prompts/'))throw new Error('Fixture prompt must stay inside the copied project.');
const prompt=await readFile(join(project,fixture.promptPath),'utf8');
const cases=fixture.cases.map(item=>{
  if(typeof item.id!=='string'||typeof item.requiredText!=='string'||typeof item.mustRetain!=='boolean')throw new Error('Invalid case contract.');
  const present=prompt.includes(item.requiredText);
  return{id:item.id,passed:item.mustRetain?present:true,score:present?1:0};
});
process.stdout.write(JSON.stringify({passed:cases.every(c=>c.passed),score:cases.reduce((sum,c)=>sum+c.score,0)/cases.length,cases,scope:'mechanics-only',limitation:'Checks literal prompt contract retention only; does not demonstrate model or agent decision quality.'})+'\n');
