// Build with npm run build; use npm run evolve -- --help.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EvolutionManager, type ImprovementRequestInput, type ProposalInput } from './evolution.js';

const help=`Explicit agent improvement lifecycle (normal host code execution):
  npm run evolve -- request --config config.json --input request.json
  npm run evolve -- reflect --config config.json --request REQUEST_ID [--generate]
  npm run evolve -- propose --config config.json --request REQUEST_ID --input candidate.json
  npm run evolve -- evaluate --config config.json --proposal PROPOSAL_ID
  npm run evolve -- promote --config config.json --proposal PROPOSAL_ID
  npm run evolve -- rollback --config config.json --proposal PROPOSAL_ID
  npm run evolve -- recover --config config.json
  npm run evolve -- history --config config.json --agent AGENT_ID

request records a trusted goal, exact allowed files, existing execution evidence,
and a frozen local Node verifier/fixtures. reflect exports a sanitized pack for a
model or operator; propose imports the resulting candidate without activating it.
evaluate builds and verifies independent baseline/candidate copies. promote and
rollback require a stopped service. Nothing runs automatically from PR events.
See the generated project's AGENTS.md for request and verifier contracts.`;

async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string',default:'config.json'},input:{type:'string'},request:{type:'string'},proposal:{type:'string'},agent:{type:'string'},generate:{type:'boolean'},help:{type:'boolean',short:'h'}}});
  if(values.help||!positionals.length||positionals[0]==='help'){process.stdout.write(`${help}\n`);return;}
  if(positionals.length!==1||!['request','reflect','propose','evaluate','promote','rollback','recover','history'].includes(positionals[0]))throw new Error('Unknown command; use --help.');
  const command=positionals[0],config=resolve(values.config!);
  const required=(name:'input'|'request'|'proposal')=>{const value=values[name];if(!value)throw new Error(`--${name} is required.`);return value;};
  const manager=await EvolutionManager.open(dirname(config),config);
  try{
    let result:unknown;
    if(values.agent&&['reflect','propose'].includes(command)&&(await manager.getRequest(required('request'))).agentId!==values.agent)throw new Error('The request belongs to a different agent.');
    if(values.agent&&['evaluate','promote','rollback'].includes(command)&&(await manager.getProposalRequest(required('proposal'))).agentId!==values.agent)throw new Error('The proposal belongs to a different agent.');
    if(command==='request')result=await manager.request(JSON.parse(await readFile(resolve(required('input')),'utf8')) as ImprovementRequestInput);
    else if(command==='history'){if(!values.agent)throw new Error('--agent is required for history.');result=await manager.history(values.agent);}
    else if(command==='reflect'){
      const pack=await manager.reflect(required('request'));
      result=values.generate?{...pack,generation:await(await import('./reflector.js')).generateReflection(pack.directory,config)}:pack;
    }
    else if(command==='propose')result=await manager.propose(required('request'),JSON.parse(await readFile(resolve(required('input')),'utf8')) as ProposalInput);
    else if(command==='evaluate')result=await manager.evaluate(required('proposal'));
    else if(command==='promote')result=await manager.promote(required('proposal'));
    else if(command==='rollback')result=await manager.rollback(required('proposal'));
    else result=await manager.recover();
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  }finally{manager.close();}
}
main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
