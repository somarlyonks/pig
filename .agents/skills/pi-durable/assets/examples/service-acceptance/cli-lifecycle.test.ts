// Generated service: npm run build, then npm test. No external services or model requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('the standalone serve CLI exits after authenticated drained API shutdown',async()=>{
  await mkdir('artifacts',{recursive:true});const project=await mkdtemp(resolve('artifacts/cli-lifecycle-'));
  const config=join(project,'config.json'),state=join(project,'state');
  await writeFile(config,JSON.stringify({version:1,host:'127.0.0.1',port:0,dataDir:state,provider:{kind:'faux'},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'helper',name:'Helper',instructions:'Wait for explicit tasks.',repositories:[]}]}));
  const child=spawn(process.execPath,['--import','data:text/javascript,setInterval(()=>{},10000)',resolve('dist/src/cli.js'),'serve','--config',config],{stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',(value:string)=>{stdout+=value;});child.stderr.on('data',(value:string)=>{stderr+=value;});
  const exit=new Promise<number|null>((accept,reject)=>{child.once('exit',accept);child.once('error',reject);});
  try{
    const deadline=Date.now()+15000;let url:string|undefined;
    while(Date.now()<deadline){
      const ready=stdout.split('\n').find(line=>line.includes('"status":"listening"'));if(ready){url=JSON.parse(ready).url;break;}
      if(child.exitCode!==null)throw new Error(`CLI exited before readiness: ${stderr}`);
      await delay(50);
    }
    assert.ok(url,'The standalone CLI did not become ready.');
    const token=(await readFile(join(state,'console-token'),'utf8')).trim();
    const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    const before=await fetch(url+'/v1/status',{headers});const status=await before.json() as {pid:number;quiescent:boolean;activeGenerations:number};
    assert.equal(status.pid,child.pid);assert.equal(status.quiescent,true);assert.equal(status.activeGenerations,0);
    const stopped=await fetch(url+'/v1/lifecycle/shutdown',{method:'POST',headers,body:JSON.stringify({timeoutMs:1000})});assert.equal(stopped.status,202);
    const code=await Promise.race([exit,delay(10000).then(()=>{throw new Error('The serve CLI kept running after its service closed.');})]);
    assert.equal(code,0);
  }finally{if(child.exitCode===null)child.kill();await exit;}
});
