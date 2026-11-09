// Generated project: npm run build, then npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);

test('JSON target options preserve foreign paths, deployed state and service identity',{timeout:15000},async()=>{
  await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/plans-'));
  for(const platform of ['win32','darwin']){
    const projectDir=platform==='win32'?'C:\\PiAgents\\atlas':'/Users/alex/pi-agents/atlas';
    const dataDir=platform==='win32'?'C:\\PiAgents\\atlas\\state':'/Users/alex/Library/Application Support/PiAgents/atlas';
    const options={platform,projectDir,dataDir,configPath:projectDir+(platform==='win32'?'\\config.json':'/config.json'),nodePath:platform==='win32'?'C:\\Program Files\\nodejs\\node.exe':'/opt/homebrew/bin/node',serviceName:'atlas-reviewer',...(platform==='darwin'?{homeDir:'/Users/alex',userId:501}:{})};
    const file=join(directory,platform+'.json');const output=join(directory,platform+'-plan.json');await writeFile(file,JSON.stringify(options));
    await execute(process.execPath,['dist/src/cli.js','service','install','--config','config.json','--options',file,'--output',output]);
    const result=JSON.parse(await readFile(output,'utf8'));assert.equal(result.executed,false);assert.equal(result.plan.platform,platform);assert.equal(result.plan.serviceName,'atlas-reviewer');assert.equal(result.deploymentConfig.serviceName,'atlas-reviewer');assert.equal(result.deploymentConfig.dataDir,dataDir);assert.ok(result.plan.artifacts.every((artifact:any)=>artifact.path.startsWith(dataDir)));
  }
});
