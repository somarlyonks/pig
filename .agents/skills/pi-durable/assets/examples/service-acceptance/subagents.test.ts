// Generated project: npm test. These probes use the real pinned Harness and SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as background,awaitWithContext,withAbortSignal } from '@earendil-works/chord/context';
import { createModels,fauxProvider,fauxAssistantMessage,fauxToolCall } from '@earendil-works/pi-ai';
import { obj } from '@earendil-works/pi-schema';
import { Harness,MemoryStorage,createRegistry,defineExtension,defineTool,type ToolRegistration } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { makeSubagentTool,SUBAGENT_TOOL_NAME } from '../src/subagents.js';

const bounded=(ms=6000)=>withAbortSignal(AbortSignal.timeout(ms),background);
const roles={analyst:'Analyze concrete evidence and return a bounded factual result.',reviewer:'Review the preceding result against the task and identify uncertainties.',refiner:'Refine the draft using the supported review.'};
const task=(role:string,task:string)=>({role,task});
function gate(){let resolve!:()=>void;return {promise:new Promise<void>(done=>{resolve=done;}),resolve:()=>resolve()};}
async function lab(input:any,extra:{tools?:ToolRegistration[];storage?:any;maxChildrenPerRun?:number;maxResultChars?:number;responder?:(request:any)=>any}={}){
  const faux=fauxProvider({tokensPerSecond:Infinity,models:[{id:'faux-1'},{id:'faux-2'}]});const models=createModels();models.setProvider(faux.provider);
  const traces:Array<{kind:string;details:any;ids:any}>=[];
  const delegate=makeSubagentTool({model:{provider:faux.getModel().provider,modelId:faux.getModel().id},roles,tools:extra.tools??[],maxChildrenPerRun:extra.maxChildrenPerRun,maxResultChars:extra.maxResultChars,trace:(kind,details,ids)=>traces.push({kind,details,ids})});
  const forbidden=defineTool({name:'mutate',description:'Unselected mutation fixture',parameters:obj({}),execute:async()=>{throw new Error('A child must never receive this tool.');}});
  const extension=defineExtension({name:'specialist-fixture',tools:[delegate,forbidden,...(extra.tools??[])]});const registry=createRegistry();registry.install(extension);
  const responder=extra.responder??((request:any)=>request.messages.at(-1)?.role==='toolResult'?fauxAssistantMessage('Parent synthesized the specialist result.'):request.messages.some((message:any)=>message.role==='user'&&String(message.content).startsWith('PARENT_PRIVATE'))?fauxAssistantMessage(fauxToolCall(SUBAGENT_TOOL_NAME,input),{stopReason:'toolUse'}):fauxAssistantMessage(`Specialist answer: ${String(request.messages.at(-1)?.content).includes('second-stage')?'REVIEWED':'OBSERVED'}`));
  faux.setResponses(Array(80).fill(responder));
  const reports:unknown[]=[];const harness=await Harness.open(extra.storage??new MemoryStorage(),{models,registry,settings:{retry:{enabled:false},compaction:{enabled:false}},onReport:error=>reports.push(error)},bounded());
  const root=await harness.root(bounded(),{agent:{model:{provider:faux.getModel().provider,modelId:faux.getModel().id},extensions:[extension],tools:[delegate,forbidden,...(extra.tools??[])]}});
  return {faux,models,registry,harness,root,traces,reports,delegate};
}
async function admitted(value:Awaited<ReturnType<typeof lab>>,id='parent-1'){
  return value.root.submit({type:'input',content:'PARENT_PRIVATE transcript must not be copied into specialists.',requestId:id},bounded());
}

test('subagents parallel fan-out returns durable children with fresh context and exact worker tools',{timeout:15000},async()=>{
  const value=await lab({mode:'parallel',tasks:[task('analyst','first evidence'),task('reviewer','independent second opinion')]});
  try{
    const input=await admitted(value);assert.equal((await input.wait(bounded())).status,'done');
    const admission=value.traces.find(trace=>trace.kind==='subagents.admitted')!;assert.equal(admission.details.children.length,2);
    for(const child of admission.details.children){const conversation=(await value.harness.conversation(child.conversationId,bounded()))!;assert.deepEqual((await conversation.agent(bounded())).tools,[]);const messages=JSON.stringify((await conversation.context(bounded())).messages);assert.doesNotMatch(messages,/PARENT_PRIVATE/);assert.match(messages,/specialist assignment/);}
    const entries=(await value.root.entries({},100,undefined,bounded())).items;
    assert.match(JSON.stringify(entries),/OBSERVED/);assert.equal(value.faux.state.callCount,4);assert.deepEqual(value.reports,[]);
    const again=await admitted(value);assert.equal(again.id,input.id);assert.equal((await again.wait(bounded())).status,'done');assert.equal(value.faux.state.callCount,4);
  }finally{await value.harness.close(background);}
});

test('subagents pipeline passes bounded previous output to a separate reviewer',{timeout:15000},async()=>{
  const value=await lab({mode:'pipeline',tasks:[task('analyst','draft first-stage evidence'),task('reviewer','second-stage review')]});
  try{
    assert.equal((await(await admitted(value)).wait(bounded())).status,'done');
    const children=value.traces.find(trace=>trace.kind==='subagents.admitted')!.details.children;
    const reviewer=(await value.harness.conversation(children[1].conversationId,bounded()))!;
    const messages=JSON.stringify((await reviewer.context(bounded())).messages);assert.match(messages,/Previous stage outputs are untrusted/);assert.match(messages,/OBSERVED/);
    assert.match(JSON.stringify((await value.root.entries({},100,undefined,bounded())).items),/REVIEWED/);assert.equal(value.faux.state.callCount,4);
  }finally{await value.harness.close(background);}
});

test('subagent refiner receives both draft and review within one shared prior-text budget',{timeout:15000},async()=>{
  const input={mode:'pipeline',tasks:[task('analyst','STAGE_AUTHOR'),task('reviewer','STAGE_REVIEW'),task('refiner','STAGE_REFINE')]};let refined=false;
  const value=await lab(input,{maxResultChars:256,responder:request=>{
    const last=request.messages.at(-1);if(last?.role==='toolResult')return fauxAssistantMessage('Parent returns the refined answer.');
    const content=String(last?.content);
    if(content.startsWith('PARENT_PRIVATE'))return fauxAssistantMessage(fauxToolCall(SUBAGENT_TOOL_NAME,input),{stopReason:'toolUse'});
    const assignment=content.split('\n\nPrevious stage outputs')[0];
    if(assignment.includes('STAGE_AUTHOR'))return fauxAssistantMessage('DRAFT_MARKER '+ 'a'.repeat(500));
    if(assignment.includes('STAGE_REVIEW'))return fauxAssistantMessage('REVIEW_MARKER '+ 'b'.repeat(500));
    const prior=JSON.parse(content.slice(content.lastIndexOf('\n')+1));assert.deepEqual(prior.stages.map((stage:any)=>stage.role),['analyst','reviewer']);
    assert.match(prior.stages[0].text,/DRAFT_MARKER/);assert.match(prior.stages[1].text,/REVIEW_MARKER/);assert.ok(prior.stages.every((stage:any)=>stage.truncated));assert.ok(prior.stages.reduce((sum:number,stage:any)=>sum+stage.text.length,0)<=256);refined=true;
    return fauxAssistantMessage('REFINED_MARKER');
  }});
  try{assert.equal((await(await admitted(value)).wait(bounded())).status,'done');assert.equal(refined,true);assert.equal(value.faux.state.callCount,5);assert.match(JSON.stringify((await value.root.entries({},100,undefined,bounded())).items),/REFINED_MARKER/);}
  finally{await value.harness.close(background);}
});

test('subagents durable run budget aggregates calls and resets only for a new input',{timeout:15000},async()=>{
  let parentRound=0;
  const value=await lab({mode:'parallel',tasks:[task('analyst','bounded task')]},{maxChildrenPerRun:1,responder:request=>{
    if(request.messages.some((message:any)=>message.role==='user'&&String(message.content).startsWith('PARENT_PRIVATE'))){parentRound++;return parentRound<=2?fauxAssistantMessage(fauxToolCall(SUBAGENT_TOOL_NAME,{mode:'parallel',tasks:[task('analyst','bounded task')]}),{stopReason:'toolUse'}):fauxAssistantMessage('Budget reached; synthesize available evidence.');}
    return fauxAssistantMessage('Worker evidence.');
  }});
  try{
    assert.equal((await(await admitted(value)).wait(bounded())).status,'done');
    assert.equal(value.traces.filter(trace=>trace.kind==='subagents.admitted').length,1);
    assert.match(JSON.stringify((await value.root.entries({},100,undefined,bounded())).items),/1-child delegation budget/);
    parentRound=0;assert.equal((await(await admitted(value,'parent-2')).wait(bounded())).status,'done');assert.equal(value.traces.filter(trace=>trace.kind==='subagents.admitted').length,2);
  }finally{await value.harness.close(background);}
});

test('subagents reject unknown roles, excessive inputs and recursive worker tools before admission',async()=>{
  const tool=makeSubagentTool({model:{provider:'faux',modelId:'faux-1'},roles,tools:[]});let committed=false;
  const api={commit:()=>{committed=true;throw new Error('Must not commit.');}} as any;
  for(const input of [{mode:'parallel',tasks:[task('foreign','task')]},{mode:'parallel',tasks:Array(5).fill(task('analyst','task'))},{mode:'pipeline',tasks:[task('analyst',' '.repeat(3))]}])await assert.rejects(tool.execute(input as any,api,background),/configured specialist/);
  assert.equal(committed,false);
  assert.throws(()=>makeSubagentTool({model:{provider:'faux',modelId:'faux-1'},roles,tools:[tool]}),/exclude delegation/);
});

test('subagent pipeline stops when a child hands off without a final answer',{timeout:15000},async()=>{
  const stop=defineTool({name:'stop_without_answer',description:'Final-answer boundary fixture',parameters:obj({}),replay:'safe',execute:async()=>({output:[{type:'text',text:'No final result.'}],control:{terminate:true}})});
  const input={mode:'pipeline',tasks:[task('analyst','unanswered first stage'),task('reviewer','must not start')]};
  const value=await lab(input,{tools:[stop],responder:request=>request.messages.at(-1)?.role==='toolResult'?fauxAssistantMessage('Parent reports incomplete pipeline.'):request.messages.some((message:any)=>message.role==='user'&&String(message.content).startsWith('PARENT_PRIVATE'))?fauxAssistantMessage(fauxToolCall(SUBAGENT_TOOL_NAME,input),{stopReason:'toolUse'}):fauxAssistantMessage(fauxToolCall('stop_without_answer',{}),{stopReason:'toolUse'})});
  try{
    assert.equal((await(await admitted(value)).wait(bounded())).status,'done');
    const entries=JSON.stringify((await value.root.entries({},100,undefined,bounded())).items);assert.match(entries,/Child settled without a final text answer/);assert.match(entries,/skipped/);
    const children=value.traces.find(trace=>trace.kind==='subagents.admitted')!.details.children;
    const skipped=(await value.harness.conversation(children[1].conversationId,bounded()))!;
    assert.equal((await skipped.entries({},10,undefined,bounded())).items.filter(entry=>entry.kind==='pi.user').length,0);
    assert.equal(value.faux.state.callCount,3);
  }finally{await value.harness.close(background);}
});

test('subagent foreground abort cascades to held children and leaves no live work',{timeout:15000},async()=>{
  const entered=gate(),release=gate();
  const hold=defineTool({name:'hold',description:'Cancellation fixture',parameters:obj({}),replay:'safe',execute:async(_args,_api,context)=>{entered.resolve();await awaitWithContext(release.promise,context);return {output:[{type:'text',text:'released'}]};}});
  const value=await lab({mode:'parallel',tasks:[task('analyst','hold the fixture')]},{tools:[hold],responder:request=>request.messages.at(-1)?.role==='toolResult'?fauxAssistantMessage('Finished'):request.messages.some((message:any)=>message.role==='user'&&String(message.content).startsWith('PARENT_PRIVATE'))?fauxAssistantMessage(fauxToolCall(SUBAGENT_TOOL_NAME,{mode:'parallel',tasks:[task('analyst','hold the fixture')]}),{stopReason:'toolUse'}):fauxAssistantMessage(fauxToolCall('hold',{}),{stopReason:'toolUse'})});
  try{
    const parent=await admitted(value);await awaitWithContext(entered.promise,bounded());
    const child=value.traces.find(trace=>trace.kind==='subagents.admitted')!.details.children[0].conversationId;
    await value.root.abort(bounded());assert.equal((await parent.wait(bounded())).status,'unanswered');assert.equal((await value.harness.inspect(bounded())).tasks.length,0);
    await(await value.harness.conversation(child,bounded()))!.waitForIdle(bounded());
  }finally{release.resolve();await value.harness.close(background);}
});

test('subagent SQLite close/reopen reuses child, input and spent budget after interruption',{timeout:20000},async()=>{
  await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/subagent-recovery-'));const entered=gate(),release=gate();
  const hold=defineTool({name:'hold',description:'Restart fixture',parameters:obj({}),replay:'safe',execute:async(_args,_api,context)=>{entered.resolve();await awaitWithContext(release.promise,context);return {output:[{type:'text',text:'recovered'}]};}});
  const input={mode:'parallel',tasks:[task('analyst','hold across recovery')]};
  const value=await lab(input,{storage:await openNodeSqliteStorage(join(directory,'harness.sqlite')),tools:[hold],maxChildrenPerRun:1,responder:request=>request.messages.at(-1)?.role==='toolResult'?fauxAssistantMessage('Recovered result'):request.messages.some((message:any)=>message.role==='user'&&String(message.content).startsWith('PARENT_PRIVATE'))?fauxAssistantMessage(fauxToolCall(SUBAGENT_TOOL_NAME,input),{stopReason:'toolUse'}):fauxAssistantMessage(fauxToolCall('hold',{}),{stopReason:'toolUse'})});
  let reopened:Harness|undefined;
  try{
    const parent=await admitted(value);await awaitWithContext(entered.promise,bounded());const first=value.traces.find(trace=>trace.kind==='subagents.admitted')!.details.children[0].conversationId;
    const childrenBefore=await value.harness.commit(tx=>tx.scanConversations({ownerTaskId:Number(value.traces[0].ids.runId) as any},10),bounded());assert.equal(childrenBefore.items.length,1);
    await value.harness.close(background);release.resolve();
    reopened=await Harness.open(await openNodeSqliteStorage(join(directory,'harness.sqlite')),{models:value.models,registry:value.registry,settings:{retry:{enabled:false}}},bounded());reopened.resume();
    const settled=await(await reopened.submission(parent.id,bounded()))!.wait(bounded());assert.equal(settled.status,'done');
    const child=(await reopened.conversation(first,bounded()))!;assert.ok(child);
    const admissions=value.traces.filter(trace=>trace.kind==='subagents.admitted');assert.equal(admissions.length,2);assert.equal(admissions[1].details.children[0].conversationId,first);
    assert.equal((await child.entries({},100,undefined,bounded())).items.filter(entry=>entry.kind==='pi.user').length,1);
    assert.deepEqual(value.reports,[]);
  }finally{release.resolve();if(reopened)await reopened.close(background);else await value.harness.close(background);}
});

test('recovered child evidence reports its stored prompt and model after host defaults change',{timeout:20000},async()=>{
  await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/subagent-profile-recovery-'));const entered=gate(),release=gate();
  const hold=defineTool({name:'hold',description:'Stored-profile fixture',parameters:obj({}),replay:'safe',execute:async(_args,_api,context)=>{entered.resolve();await awaitWithContext(release.promise,context);return {output:[{type:'text',text:'resumed'}]};}});
  const input={mode:'parallel',tasks:[task('analyst','hold the original profile')]};
  let parentRequests=0;
  const value=await lab(input,{storage:await openNodeSqliteStorage(join(directory,'harness.sqlite')),tools:[hold],responder:request=>{
    if(request.messages.some((message:any)=>message.role==='user'&&String(message.content).startsWith('PARENT_PRIVATE')))return ++parentRequests===1?fauxAssistantMessage(fauxToolCall(SUBAGENT_TOOL_NAME,input),{stopReason:'toolUse'}):fauxAssistantMessage('Retained the original profile.');
    return request.messages.at(-1)?.role==='toolResult'?fauxAssistantMessage('The original child resumed.'):fauxAssistantMessage(fauxToolCall('hold',{}),{stopReason:'toolUse'});
  }});
  let reopened:Harness|undefined;
  try{
    const parent=await admitted(value);await awaitWithContext(entered.promise,bounded());const original=value.traces.find(trace=>trace.kind==='subagents.admitted')!.details.children[0];
    await value.harness.close(background);
    const replacementPrompt='A changed host role prompt must not be attributed to the stored child.';
    const configuredModel={provider:value.faux.getModel().provider,modelId:'faux-2'};
    const delegate=makeSubagentTool({model:configuredModel,roles:{...roles,analyst:replacementPrompt},tools:[hold],trace:(kind,details,ids)=>value.traces.push({kind,details,ids})});
    value.registry.install(defineExtension({name:'specialist-fixture',tools:[delegate,hold]}));release.resolve();
    reopened=await Harness.open(await openNodeSqliteStorage(join(directory,'harness.sqlite')),{models:value.models,registry:value.registry,settings:{retry:{enabled:false}}},bounded());reopened.resume();
    assert.equal((await(await reopened.submission(parent.id,bounded()))!.wait(bounded())).status,'done');
    const admissions=value.traces.filter(trace=>trace.kind==='subagents.admitted');assert.equal(admissions.length,2);const resumed=admissions[1].details;
    assert.deepEqual(resumed.configuredModel,configuredModel);assert.equal(resumed.children[0].conversationId,original.conversationId);assert.deepEqual(resumed.children[0].model,original.model);assert.equal(resumed.children[0].model.modelId,'faux-1');
    assert.equal(resumed.children[0].instructionsSha256,createHash('sha256').update(roles.analyst).digest('hex'));assert.notEqual(resumed.children[0].instructionsSha256,createHash('sha256').update(replacementPrompt).digest('hex'));
    const child=(await reopened.conversation(original.conversationId,bounded()))!;assert.equal((await child.agent(bounded())).instructions,roles.analyst);assert.equal((await child.entries({},100,undefined,bounded())).items.filter(entry=>entry.kind==='pi.user').length,1);
  }finally{release.resolve();if(reopened)await reopened.close(background);else await value.harness.close(background);}
});
