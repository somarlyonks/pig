#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Exercise the real generated CLI with offline durable work and paired gates.

Run after installing/building a fresh project:
uv run --script tests/evolution-study.integration.py --project .
"""
import argparse,json,subprocess,sys,time
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--project',type=Path,required=True)
root=parser.parse_args().project.resolve()
runner=root/'evolution-plans/study.py'
seed="""import {loadConfig} from './dist/src/config.js';
import {AgentRuntime} from './dist/src/runtime.js';
const config=await loadConfig('config.json');
const runtime=await AgentRuntime.open(config,config.agents[0]);
try{
  const receipt=await runtime.submitHuman({content:'Record an offline task-policy demonstration. A previously reopened PR was ignored; compare generic lifecycle actions without weakening duplicate or draft checks.',requestId:'evolution-demo-seed'});
  let status;
  for(let index=0;index<100;index++){
    status=await runtime.status(receipt.submissionId);
    if(status.status==='done')break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  if(status.status!=='done')throw new Error('Offline seed did not complete.');
  console.log(JSON.stringify({provider:'faux',calls:runtime.calls,status:status.status}));
}finally{await runtime.close();}
"""
if json.loads((root/'config.json').read_text())['provider']['kind']!='faux':
    raise ValueError('This acceptance fixture requires the explicit faux provider.')
if json.loads((root/'evolution-plans/plan.json').read_text())['maxCandidates']<2:
    raise ValueError('Generate this multi-candidate acceptance fixture with scaffold-evolution.py --strategy pareto (or population).')
seed_path=root/'evolution-study-seed.mjs'
with seed_path.open('x',encoding='utf-8') as stream:
    stream.write(seed)
seeded=subprocess.run(['node',str(seed_path)],cwd=root,text=True,capture_output=True,timeout=30)
assert seeded.returncode==0,seeded.stderr
assert json.loads(seeded.stdout)['calls']==1
def run(*args,ok=True):
    result=subprocess.run([sys.executable,str(runner),*args],cwd=root,text=True,capture_output=True,timeout=180)
    if ok:
        assert result.returncode==0,(args,result.stdout,result.stderr)
        return json.loads(result.stdout)
    assert result.returncode!=0,(args,result.stdout)
    return result.stderr
def candidate(study,content):
    record=json.loads((root/f'evolution-plans/runs/{study}/study.json').read_text())['request']
    baseline=next(f for f in record['source'] if f['path']=='scripts/task-policy.mjs')
    value={'requestId':record['id'],'evidenceIds':[f['id'] for f in record['evidence']],
      'hypothesis':'Recognizing actionable PR lifecycle events fixes observed ignored work while preserving duplicate and draft guards.',
      'decision':'Use a bounded explicit action allowlist.','expectedBenefit':'Correct actionable event decisions on frozen synthetic cases.',
      'regressionRisks':['Unknown future lifecycle events remain ignored.'],
      'changes':[{'path':'scripts/task-policy.mjs','beforeHash':baseline['sha256'],'content':content}]}
    path=root/f'{study}-candidate.json';path.write_text(json.dumps(value))
    return path.name
original=(root/'scripts/task-policy.mjs').read_bytes()
good="export function decideTask(event) { if(event.seen || event.draft) return 'ignore'; return event.kind === 'pull_request' && ['opened','reopened','ready_for_review'].includes(event.action) ? 'review' : 'ignore'; }\n"
for name in ('validation','holdout'):
    run('commit-gate','--input',f'evolution-plans/{name}-gate.json','--output',f'evolution-plans/{name}-commitment.json')
run('open','--study','integration-passes')
run('reflect','--study','integration-passes')
path=candidate('integration-passes',good)
development=subprocess.Popen([sys.executable,str(runner),'develop','--study','integration-passes','--candidate',path,'--operator','lifecycle-actions'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
lock=root/'evolution-plans/runs/.locks/integration-passes.json'
deadline=time.monotonic()+30
try:
    while not lock.exists() and time.monotonic()<deadline and development.poll() is None:
        time.sleep(0.01)
    assert lock.exists() and development.poll() is None,'Development was not observed owning a live study lock.'
    owner=json.loads(lock.read_text())
    # Windows virtual-environment launchers may retain a wrapper PID while the
    # interpreter holding the lock is its immediate child.
    assert development.pid in (owner['pid'],owner['parentPid'])
    assert 'Another command owns' in run('freeze','--study','integration-passes',ok=False)
finally:
    stdout,stderr=development.communicate(timeout=180)
assert development.returncode==0,stderr
assert not lock.exists(),'Successful development left its mutation lock behind.'
developed=json.loads(stdout)
assert developed['qualified']
assert 'identical candidate' in run('develop','--study','integration-passes','--candidate',path,ok=False)
selection=run('freeze','--study','integration-passes'); assert selection['winner']=='candidate-001'
assert 'Development is closed' in run('develop','--study','integration-passes','--candidate',path,ok=False)
validation=run('validation','--study','integration-passes','--gate','evolution-plans/validation-gate.json');assert validation['passed']
assert not validation['qualifiedForRequestedActivationReview']
assert 'File exists' in run('validation','--study','integration-passes','--gate','evolution-plans/validation-gate.json',ok=False)
holdout=run('holdout','--study','integration-passes','--gate','evolution-plans/holdout-gate.json');assert holdout['passed'] and holdout['qualifiedForRequestedActivationReview']
assert (root/'scripts/task-policy.mjs').read_bytes()==original
# Wrong release consumes its stage; this cannot be repaired or reselected in-place.
run('open','--study','integration-bad-gate')
path=candidate('integration-bad-gate',good)
assert run('develop','--study','integration-bad-gate','--candidate',path)['qualified']
run('freeze','--study','integration-bad-gate')
assert 'commitment' in run('validation','--study','integration-bad-gate','--gate','evolution-plans/holdout-gate.json',ok=False)
assert 'File exists' in run('validation','--study','integration-bad-gate','--gate','evolution-plans/validation-gate.json',ok=False)
status=run('status','--study','integration-bad-gate');assert status['gates']['validation']['released'] and not status['gates']['validation']['completed']
# A candidate violating required draft/duplicate guards never opens a private gate.
run('open','--study','integration-fails')
path=candidate('integration-fails',"export function decideTask(event) { return 'review'; }\n")
assert not run('develop','--study','integration-fails','--candidate',path)['qualified']
assert run('freeze','--study','integration-fails')['winner'] is None
assert 'No qualified' in run('validation','--study','integration-fails','--gate','evolution-plans/validation-gate.json',ok=False)
assert not run('status','--study','integration-fails')['gates']['validation']['released']
assert (root/'scripts/task-policy.mjs').read_bytes()==original
result={'passed':True,'provider':'faux','modelCallsFromStudy':0,'nativePlatform':'Windows','checks':['real paired build and task function evaluation','concurrent freeze denied while real development process owns lock','development candidate 0.75 to 1.0','frozen validation 0.75 to 1.0','holdout 0.6 to 1.0','duplicate candidate denied','postselection development denied','repeat gate denied','mismatched commitment consumes gate','failed hard-gate candidate retains baseline','no source activation'],'scope':'synthetic deterministic mechanics; no live model-quality claim'}
(root/'integration-result.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
