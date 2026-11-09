// Pi loads this module directly. Human-selected operations never start an outer model turn.
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { ServiceConnection } from './client.js';
import * as management from './agent-management.js';
import * as quality from './agent-quality.js';
import { DurableCreationReview } from './creation-review.js';
import { safeText } from './display.js';
import { selectMenu } from './menu-ui.js';

export const defaultOperations={
  ...management,
  inspectQuality:quality.inspectQuality,configureVerification:quality.configureVerification,
  verifyAgent:quality.verifyAgent,runEvolution:quality.runEvolution,
  freezeModelsForEvolution:quality.freezeModelsForEvolution,rebuildAgent:quality.rebuildAgent,
};
export type OperationsApi=typeof defaultOperations;
export interface OperationTarget {name:string;agentId:string;agentName?:string;connection:ServiceConnection}
export interface OperationContext {
  api:OperationsApi;signal:AbortSignal;connectionsFile?:string;
  show:(message:string)=>void;
}
function pretty(value:unknown){return safeText(JSON.stringify(value,null,2),48000);}
function active(signal:AbortSignal){return !signal.aborted;}
export async function reviewOperation(ctx:ExtensionCommandContext,title:string,text:string,signal:AbortSignal):Promise<boolean>{
  if(!ctx.hasUI)throw new Error('This lifecycle action needs an interactive Pi review.');
  if(signal.aborted)return false;
  return ctx.mode==='tui'?ctx.ui.custom<boolean>((tui,theme,_bindings,done)=>new DurableCreationReview(tui,theme,done,{title,confirmLabel:'Apply action',text,signal}),{overlay:true,overlayOptions:{width:'100%',maxHeight:'100%',anchor:'center'}}):ctx.ui.confirm(title,safeText(text,32000),{signal});
}
async function editorJson(ctx:ExtensionCommandContext,title:string,value:unknown,signal:AbortSignal):Promise<Record<string,unknown>|undefined>{
  if(!ctx.hasUI)throw new Error('This configuration action needs an interactive Pi editor.');
  for(let attempt=0;attempt<3&&active(signal);attempt++){
    const text=await ctx.ui.editor(title,JSON.stringify(value,null,2));
    if(text===undefined||signal.aborted)return;
    if(text.length>128000){ctx.ui.notify('The JSON input exceeds the 128 KiB limit.','error');continue;}
    try{const parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}catch{ctx.ui.notify('Enter a JSON object or press Escape to cancel.','error');}
  }
}
async function identifier(ctx:ExtensionCommandContext,title:string,signal:AbortSignal):Promise<string|undefined>{
  if(!ctx.hasUI)throw new Error('Select a request or proposal ID in interactive Pi.');
  const value=await ctx.ui.input(title,'Exact ID from the evolution history',{signal});
  if(value===undefined||signal.aborted)return;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value))throw new Error('Use an exact request or proposal ID from the evolution history.');
  return value;
}

export async function runEvolutionMenu(ctx:ExtensionCommandContext,target:OperationTarget,input:string,options:OperationContext){
  const {api,signal,show}=options;
  let action=input.trim();
  if(!action){
    const choices=new Map([['History and current verification','status'],['Prepare a frozen study','prepare'],['Reflect and import candidates','candidate'],['Evaluate and release','release'],['Rollback and recovery','recovery']]);
    const selected=await selectMenu(ctx,`Evolution · ${target.name}`,[...choices.keys()],{signal});
    if(!selected||signal.aborted)return;
    action=choices.get(selected)!;
    if(action!=='status'){
      const groups:Record<string,Array<[string,string]>>={prepare:[['Freeze model choices for a study','freeze'],['Request an evidence-based improvement','request']],candidate:[['Export reflection evidence','reflect'],['Generate an inactive reflection draft','generate'],['Import an inactive candidate','propose']],release:[['Evaluate baseline and candidate','evaluate'],['Promote a passing candidate','promote']],recovery:[['Roll back a promoted candidate','rollback'],['Recover an interrupted activation','recover']]};
      const group=new Map(groups[action]);const stage=await selectMenu(ctx,`Evolution · ${selected}`,[...group.keys()],{signal});if(!stage)return;action=group.get(stage)!;
    }
  }
  if(action==='status'){const verification=await api.inspectQuality(target.connection,{signal});const history=await api.runEvolution(target.connection,{action:'history'},{signal});show(pretty({verification,history}));return;}
  if(action==='freeze'){
    if(!await reviewOperation(ctx,'Freeze study model choices',`${target.name}\nStop and drain this agent before freezing. Resolve exact models and supported efforts, retain a project-local catalog snapshot and preserve the previous configuration. New study requests use the frozen configuration. This changes no prompts or tools.`,signal))return;
    show(pretty(await api.freezeModelsForEvolution(target.connection,{signal})));return;
  }
  if(!['request','reflect','generate','propose','evaluate','promote','rollback','recover'].includes(action))throw new Error('Use /durable evolve <agent> and select a lifecycle stage.');
  let requestId:string|undefined,proposalId:string|undefined,inputValue:Record<string,unknown>|undefined;
  if(['reflect','generate','propose'].includes(action)){requestId=await identifier(ctx,'Improvement request ID',signal);if(!requestId)return;}
  if(['evaluate','promote','rollback'].includes(action)){proposalId=await identifier(ctx,'Candidate proposal ID',signal);if(!proposalId)return;}
  if(action==='request'){
    inputValue=await editorJson(ctx,'Improvement request · goal, exact files and trusted verifier',{
      agentId:target.agentId,goal:'Define a measurable improvement from observed traces.',
      allowedPaths:[`prompts/${target.agentId}.md`],verifierPath:'evolution-plans/task-verifier.mjs',
      fixturePaths:['evolution-plans/fixtures/development.json'],minimumImprovement:0.01,timeoutMs:60000,
    },signal);
    if(inputValue===undefined)return;
  }
  if(action==='propose'){
    inputValue=await editorJson(ctx,'Inactive candidate · exact preimages and evidence citations',{
      requestId,evidenceIds:[],hypothesis:'Describe the evidence-backed change.',decision:'Explain the selected action.',
      expectedBenefit:'Define the observable gain.',regressionRisks:[],changes:[],
    },signal);
    if(inputValue===undefined)return;
  }
  const mutation=['request','generate','propose','evaluate','promote','rollback','recover'].includes(action);
  const activation=['promote','rollback','recover'].includes(action);
  if(mutation&&!await reviewOperation(ctx,`Evolution · ${action}`,`${target.name}\nStage: ${action}\n${requestId?`Request: ${requestId}\n`:''}${proposalId?`Proposal: ${proposalId}\n`:''}${inputValue?pretty(inputValue)+'\n':''}
Requests freeze exact allowed paths, verifier/fixtures and execution evidence. Candidate imports and reflection drafts stay inactive. The bundled synthetic task-policy verifier demonstrates mechanics; replace it with a trusted verifier for the actual duty before claiming a useful improvement.
${action==='generate'?'This stage makes a bounded model-backed reflection request with no tools. The draft is not an improvement result.\n':''}${activation?'Activation requires a stopped owner and drained tasks, exact passing evidence and current source hashes. After source changes, build and smoke must pass before starting the service.\n':''}No event or agent reply authorizes another evolution stage.`,signal))return;
  if(signal.aborted)return;
  const result=await api.runEvolution(target.connection,{action:(action==='generate'?'reflect':action) as quality.EvolutionCommand['action'],requestId,proposalId,input:inputValue,generate:action==='generate'},{signal});
  show(pretty(result));
  if(activation){
    show('Checking the activated source with the project build and offline smoke. The owner stays stopped until these checks pass.');
    show(pretty(await api.rebuildAgent(target.connection,{signal})));
    show(`Use /durable start ${target.name}, then run a representative task and /durable verify ${target.name}.`);
  }
}

export async function runAgentOperation(ctx:ExtensionCommandContext,target:OperationTarget,action:string,options:OperationContext,selection:{jobId?:string;submissionId?:number;evolutionAction?:string}={}){
  const {api,signal,show}=options;
  if(action==='inspect'){
    const service=await api.inspectManaged(target.connection,{signal});
    let acceptance:unknown;try{acceptance=await api.inspectQuality(target.connection,{signal});}catch(error){acceptance={available:false,reason:error instanceof Error?error.message:'Verification is unavailable.'};}
    show(pretty({target:target.name,service,acceptance}));return;
  }
  if(action==='logs'){show(pretty(await api.readManagedLogs(target.connection,{signal})));return;}
  if(action==='verify'){show(pretty(await api.verifyAgent(target.connection,{...selection,signal})));return;}
  if(action==='criteria'){
    const info=await api.inspectQuality(target.connection,{signal});
    const current=info&&typeof info==='object'&&'contract' in info?info.contract:undefined;
    const value=await editorJson(ctx,'Acceptance criteria · observable assertions',current??{version:1,enabled:true,agentId:target.agentId,goal:'Define the agent duty.',assertions:[{id:'required-result',kind:'output-contains',value:'Replace with a task-specific expected result.'}]},signal);
    if(value===undefined)return;
    if(await reviewOperation(ctx,'Save task acceptance criteria',`${target.name}\n${pretty(value)}\nThese are concrete configured checks, not a universal quality score. Changing them invalidates an open improvement study.`,signal))show(pretty(await api.configureVerification(target.connection,value,{signal})));
    return;
  }
  if(action==='evolve'){await runEvolutionMenu(ctx,target,selection.evolutionAction??'',options);return;}
  if(action==='login'){
    const choices=new Map([['Review login startup plan','plan'],['Install login startup (owner must be stopped)','install'],['Inspect owned login registration','status'],['Drain and remove login startup','uninstall']]);
    const selected=await selectMenu(ctx,`Login startup · ${target.name}`,[...choices.keys()],{signal});
    if(!selected||signal.aborted)return;
    const selectedAction=choices.get(selected)! as 'plan'|'install'|'status'|'uninstall';
    if(selectedAction==='plan'||selectedAction==='status'){show(pretty(await api.manageLoginStartup(target.connection,selectedAction,{signal})));return;}
    const plan=await api.manageLoginStartup(target.connection,'plan',{signal});
    if(!await reviewOperation(ctx,`Login startup · ${selectedAction}`,`${target.name}\n${pretty(plan)}\nThis manages only this project's owned per-user login registration. Installation requires a stopped owner. Removal drains accepted work before unregistering. Source and state stay intact. Login startup depends on the user session, an awake machine and available network; it is not a logged-out system service.`,signal))return;
    show(pretty(await api.manageLoginStartup(target.connection,selectedAction,{signal})));return;
  }
  if(!['start','stop','restart','pause','resume','recover-owner','archive'].includes(action))throw new Error('Unknown lifecycle action. Use /durable help.');
  const current=await api.inspectManaged(target.connection,{signal});
  if(!current.managed)throw new management.AgentManagementError('unmanaged','This service has an external owner. Its chat and read-only status remain available; lifecycle writes require a console-managed project.');
  const description=action==='archive'?'Remove only this stopped project’s console registration. All source, state, traces and logs remain available for reconnection.':action==='stop'||action==='restart'?'Pause new admissions, drain actual event/control/child work for up to 30 seconds, then stop the authenticated owner. A busy timeout keeps the service paused; it never aborts accepted tasks.':action==='pause'?'Pause new task and event admissions. Accepted work continues to drain; polling remains paused across restart.':action==='recover-owner'?'Retry startup only after exclusive state ownership can be proved. No process is killed by a stale PID.':action==='resume'?'Resume event polling and accept new work.':'Start this independent project with its configured model policy and recover admitted durable work.';
  if(!await reviewOperation(ctx,`Durable ${action}`,`${target.name}\nProject: ${current.project?.projectDir}\nCurrent state: ${current.state}\n${description}`,signal))return;
  if(signal.aborted)return;
  if(action==='archive'){
    if(!options.connectionsFile)throw new Error('No explicit connection registry is available for archiving.');
    show(pretty(await api.archiveManaged(target.connection,{signal,connectionsFile:options.connectionsFile})));return;
  }
  const operation=action==='start'?api.startManaged:action==='stop'?api.stopManaged:action==='restart'?api.restartManaged:action==='pause'?api.pauseManaged:action==='resume'?api.resumeManaged:api.recoverManaged;
  show(pretty(await operation(target.connection,{signal})));
}
