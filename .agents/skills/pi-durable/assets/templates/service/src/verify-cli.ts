#!/usr/bin/env node
// npm run build; node dist/src/verify-cli.js <inspect|configure|verify> --config config.json --agent ID.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { configureVerification, inspectVerification, verifyDuty } from './verification.js';

async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string',default:'config.json'},agent:{type:'string'},job:{type:'string'},submission:{type:'string'},input:{type:'string'},help:{type:'boolean'}}});
  if(values.help||!positionals.length){console.log('Commands: inspect --agent ID, configure --input contract.json, verify --agent ID [--job ID] [--submission ID]. Every command accepts --config file. Verification uses declarative task assertions and never starts a model or shell command.');return;}
  if(positionals.length!==1||!['inspect','configure','verify'].includes(positionals[0]))throw new Error('Select inspect, configure or verify.');
  let result:unknown;
  if(positionals[0]==='configure'){if(!values.input)throw new Error('Provide a contract JSON file with --input.');result=await configureVerification(resolve(values.config!),JSON.parse(await readFile(resolve(values.input),'utf8')));}
  else{if(!values.agent)throw new Error('Provide the configured --agent ID.');result=positionals[0]==='inspect'?await inspectVerification(resolve(values.config!),values.agent):await verifyDuty(resolve(values.config!),{agentId:values.agent,...(values.job?{jobId:values.job}:{}),...(values.submission?{submissionId:Number(values.submission)}:{})});}
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Duty verification failed.');process.exitCode=1;});
