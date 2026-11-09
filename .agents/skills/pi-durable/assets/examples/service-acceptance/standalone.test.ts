// Generated project: npm run build, then npm test. No generating skill is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const shell = promisify(exec);

test('generated application moves and operates using only its own authored files', {timeout: 90000}, async () => {
  const original = resolve('.');
  const manifest = JSON.parse(await readFile(join(original, 'scaffold-manifest.json'), 'utf8'));
  assert.equal(manifest.runtimeIndependent, true);
  assert.equal(manifest.destination, undefined);
  assert.equal(manifest.runtimeSource.version, '1.5.0');
  assert.equal(manifest.dependencies['@earendil-works/pi-durable'], '1.5.0');
  assert.ok(manifest.files['scripts/project.py']);
  assert.ok(manifest.files['AGENTS.md']);
  assert.ok(manifest.files['evolution-plans/study.py']);
  for (const [path, hash] of Object.entries(manifest.files)) {
    assert.ok(!isAbsolute(path) && !path.includes('\\') && !path.split('/').includes('..'), path);
    assert.match(String(hash), /^[a-f0-9]{64}$/, `Initial manifest hash format: ${path}`);
  }
  // The scaffold manifest is immutable initial provenance. Legitimate later
  // prompt/tool improvements need not equal it; copy the current project files.
  const currentFiles: string[] = [];
  async function collect(path: string) {
    if(path==='evolution-plans/runs')return; // Retained study state is not authored runtime source.
    const info = await lstat(join(original, path));
    assert.equal(info.isSymbolicLink(), false, `Authored source must be local: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(join(original, path))).sort()) await collect(`${path}/${name}`);
    } else if (info.isFile()) currentFiles.push(path);
  }
  for (const directory of ['src', 'scripts', 'prompts', 'evaluation', 'evolution-plans', 'tests']) {
    try { await lstat(join(original, directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    await collect(directory);
  }
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'config.json', '.npmrc', 'AGENTS.md', 'scaffold-manifest.json']) await collect(file);
  for(const file of ['config.codex.example.json','.gitignore']){
    try{await lstat(join(original,file));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    await collect(file);
  }
  await mkdir('.cache', {recursive: true});
  const sandbox = await mkdtemp(resolve('.cache/independent application '));
  const moved = join(sandbox, 'moved service with spaces');
  const caller = join(sandbox, 'unrelated caller');
  await mkdir(moved, {recursive: true}); await mkdir(caller);
  // Copy only current authored application files. It contains no skill bundle,
  // dependencies, state, cached outputs, or source-generation provenance paths.
  const copiedHashes=new Map<string,string>();
  for (const path of currentFiles) {
    const target = resolve(moved, path);
    assert.ok(target.startsWith(moved + sep));
    await mkdir(dirname(target), {recursive: true});
    await copyFile(join(original, path), target);
    const hash=createHash('sha256').update(await readFile(join(original,path))).digest('hex');
    copiedHashes.set(path,hash);
    assert.equal(createHash('sha256').update(await readFile(target)).digest('hex'),hash,`Moved current source: ${path}`);
  }
  // Reuse ordinary installed npm dependencies, avoiding another network install.
  await symlink(join(original, 'node_modules'), join(moved, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const cache = await shell('npm config get cache', {cwd:moved,env:{...process.env,npm_config_cache:undefined,NPM_CONFIG_CACHE:undefined},timeout:15000});
  assert.equal(resolve(cache.stdout.trim()),join(moved,'.cache','npm'));
  const helper = join(moved, 'scripts/project.py');
  const environment = {...process.env, UV_CACHE_DIR: join(sandbox, 'uv-cache')};
  async function local(...args: string[]) {
    return execute('uv', ['run', '--script', helper, ...args], {cwd: caller, env: environment, timeout: 60000, maxBuffer: 4 * 1024 * 1024});
  }
  await local('prepare', '--skip-install');
  await local('smoke');
  const smoke = JSON.parse(await readFile(join(moved, '.cache/smoke-result.json'), 'utf8'));
  assert.equal(smoke.passed, true);
  assert.equal(smoke.sameTaskConversation, true);
  assert.equal(smoke.reopenProviderCalls, 0);
  const options = join(caller, 'target options.json');
  const output = join(caller, 'service plan.json');
  await writeFile(options, JSON.stringify({
    platform: 'win32', projectDir: 'C:\\Pi Agents\\independent',
    configPath: 'C:\\Pi Agents\\independent\\config.json', dataDir: 'C:\\Pi Agents\\independent\\state',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe', serviceName: 'independent-agent',
  }));
  await local('plan', '--options', options, '--output', output);
  const plan = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(plan.executed, false); assert.equal(plan.plan.serviceName, 'independent-agent');
  const help = await local('evolve', '--', '--help');
  assert.match(help.stdout, /request|reflect|propose/);
  const study=await execute('uv',['run','--script',join(moved,'evolution-plans/study.py'),'--help'],{cwd:caller,env:environment,timeout:15000,maxBuffer:1024*1024});
  assert.match(study.stdout,/commit-gate[\s\S]*develop[\s\S]*holdout/);
  const specialists=await execute(process.execPath,[join(moved,'dist/src/subagents-smoke.js')],{cwd:caller,env:environment,timeout:15000,maxBuffer:1024*1024});
  const specialistReceipt=JSON.parse(specialists.stdout);
  assert.equal(specialistReceipt.offline,true);assert.equal(specialistReceipt.networkUsed,false);assert.equal(specialistReceipt.sqliteReopened,true);assert.equal(specialistReceipt.requestDeduplication,true);assert.equal(specialistReceipt.modelCalls,9);
  assert.deepEqual(specialistReceipt.admissions.map((admission:any)=>[admission.mode,admission.children.length]),[['parallel',2],['pipeline',3]]);
  for(const [path,hash] of copiedHashes)assert.equal(createHash('sha256').update(await readFile(join(moved,path))).digest('hex'),hash,`Moved authored files remain unchanged: ${path}`);
});
