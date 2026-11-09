// Build with npm run build; run npm run subagents:smoke. No credentials or network.
import assert from 'node:assert/strict';
import { mkdir,mkdtemp } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { BACKGROUND_CONTEXT as background,withAbortSignal } from '@earendil-works/chord/context';
import { createModels,fauxProvider,fauxAssistantMessage,fauxToolCall } from '@earendil-works/pi-ai';
import { Harness,createRegistry,defineExtension } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { makeSubagentTool,SUBAGENT_TOOL_NAME } from './subagents.js';

const bounded=()=>withAbortSignal(AbortSignal.timeout(15000),background);
async function main(){
  const fetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('The offline subagent smoke must not access the network.');};
  await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/subagents-smoke-'));
  const faux=fauxProvider({tokensPerSecond:Infinity});const models=createModels();models.setProvider(faux.provider);
  const admissions:Array<{mode:unknown;children:unknown}>=[];
  const delegate=makeSubagentTool({model:{provider:faux.getModel().provider,modelId:faux.getModel().id},roles:{analyst:'Inspect the task and return concrete evidence.',reviewer:'Review evidence and report unresolved uncertainty.',refiner:'Refine the draft using the supported review.'},tools:[],maxChildrenPerCall:3,maxChildrenPerRun:3,trace:(kind,details)=>{if(kind==='subagents.admitted')admissions.push({mode:details.mode,children:details.children});}});
  const extension=defineExtension({name:'subagents-smoke',tools:[delegate]});const registry=createRegistry();registry.install(extension);
  const responder=(request:any)=>{
    const last=request.messages.at(-1);
    if(last?.role==='toolResult')return fauxAssistantMessage('OFFLINE DEMO: parent synthesized the returned evidence.');
    const input=typeof last?.content==='string'?last.content:'';
    if(input.startsWith('SMOKE_PARENT ')){const pipeline=input.includes('pipeline');return fauxAssistantMessage(fauxToolCall(SUBAGENT_TOOL_NAME,{mode:pipeline?'pipeline':'parallel',tasks:[{role:'analyst',task:'Summarize the offline fixture.'},{role:'reviewer',task:'Review the first result or independently inspect the same fixture.'},...(pipeline?[{role:'refiner',task:'Refine the draft using the review.'}]:[])]}),{stopReason:'toolUse'});}
    if(input.includes('Refine the draft')){const prior=JSON.parse(input.slice(input.lastIndexOf('\n')+1));assert.deepEqual(prior.stages.map((stage:any)=>stage.role),['analyst','reviewer']);assert.match(prior.stages[0].text,/fixture evidence observed/);assert.match(prior.stages[1].text,/reviewer received the prior evidence/);return fauxAssistantMessage('OFFLINE DEMO: refiner received draft and review.');}
    return fauxAssistantMessage(input.includes('Previous stage outputs')?'OFFLINE DEMO: reviewer received the prior evidence.':'OFFLINE DEMO: fixture evidence observed.');
  };
  faux.setResponses(Array(20).fill(responder));
  const path=join(directory,'harness.sqlite');let harness=await Harness.open(await openNodeSqliteStorage(path),{models,registry,settings:{retry:{enabled:false},compaction:{enabled:false}}},bounded());
  try{
    const root=await harness.root(bounded(),{agent:{model:{provider:faux.getModel().provider,modelId:faux.getModel().id},extensions:[extension],tools:[delegate]}});
    const receipts:Array<{mode:string;conversationId:number;submissionId:number;status:string}>=[];
    for(const mode of ['parallel','pipeline']){
      const input={type:'input' as const,content:`SMOKE_PARENT ${mode}`,requestId:`smoke:${mode}`};
      const submission=await root.submit(input,bounded());assert.equal((await submission.wait(bounded())).status,'done');
      const again=await root.submit(input,bounded());assert.equal(again.id,submission.id);
      receipts.push({mode,conversationId:Number(root.id),submissionId:Number(submission.id),status:'done'});
    }
    assert.equal(admissions.length,2);assert.equal(faux.state.callCount,9);
    const entries=JSON.stringify((await root.entries({},100,undefined,bounded())).items);assert.match(entries,/refiner received draft and review/);
    await harness.close(background);
    harness=await Harness.open(await openNodeSqliteStorage(path),{models,registry},bounded());harness.resume();
    for(const receipt of receipts)assert.equal((await(await harness.submission(receipt.submissionId as any,bounded()))!.wait(bounded())).status,'done');
    assert.equal(faux.state.callCount,9);
    process.stdout.write(`${JSON.stringify({offline:true,provider:'faux',networkUsed:false,sqliteReopened:true,requestDeduplication:true,modelCalls:9,admissions,receipts,stateDirectory:directory},null,2)}\n`);
  }finally{globalThis.fetch=fetch;await harness.close(background);}
}
main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
