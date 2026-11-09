// Build with npm run build. This tool has no shell, write, posting or merge capability.
import { bool, int, obj, opt, str } from '@earendil-works/pi-schema';
import { defineTool } from '@earendil-works/pi-durable';
import type { AgentConfig } from '../config.js';

export function createReadPullRequestTool(agent:AgentConfig){return defineTool({
  name:'read_pull_request',description:'Read metadata or diff of an allowlisted GitHub pull request.',
  parameters:obj({repository:str(),number:int({minimum:1}),diff:opt(bool())}),replay:'safe',
  execute:async({repository,number,diff},_api,ctx)=>{
    repository=repository.toLowerCase();if(!agent.repositories.includes(repository))throw new Error('Repository is outside this agent allowlist.');
    const signal=AbortSignal.any([AbortSignal.timeout(30000),...(ctx.abortSignal?[ctx.abortSignal]:[])]);
    const response=await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`,{headers:{Accept:diff?'application/vnd.github.diff':'application/vnd.github+json','User-Agent':'pi-durable-agent-service',...(process.env.GITHUB_TOKEN?{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`}:{})},signal,redirect:'error'});
    if(!response.ok)throw new Error(`GitHub read failed: HTTP ${response.status}`);
    const reader=response.body!.getReader();const chunks:Uint8Array[]=[];let bytes=0;
    try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>2*1024*1024)throw new Error('PR response exceeds the 2 MiB template limit; use bounded file/diff tools.');chunks.push(item.value);}}
    finally{await reader.cancel();}
    return {output:[{type:'text',text:Buffer.concat(chunks).toString('utf8')}]};
  },
});}
