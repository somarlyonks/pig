// Run from this project: node --import tsx --test tests/codex-provider.test.ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import type { AuthContext } from '@earendil-works/pi-ai';
import { createCodexProvider } from '../src/codex-provider.js';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const context: AuthContext = { env: async () => undefined, fileExists: async () => false };
const token = 'synthetic-test-token-that-is-never-a-real-credential';

async function fixture(t: TestContext, body: string) {
  const cacheDir = join(projectDir, '.cache');
  await mkdir(cacheDir, { recursive: true });
  const directory = await mkdtemp(join(cacheDir, 'codex-provider-test-'));
  t.after(async () => {
    const expectedPrefix = resolve(cacheDir) + '\\';
    const actual = resolve(directory);
    assert.ok(actual.startsWith(expectedPrefix) || actual.startsWith(resolve(cacheDir) + '/'));
    await rm(actual, { recursive: true, force: true });
  });
  const path = join(directory, 'fake-pi.mjs');
  await writeFile(path, `const args=process.argv.slice(2);\nif(args[0]!=='auth'||args[1]!=='check'||!args.includes('--no-refresh')||!args.includes('--json')||args[args.indexOf('--provider')+1]!=='openai-codex')process.exit(3);\n${body}\n`);
  return path;
}

test('uses the supported read-only command and resolves a token only in memory', async t => {
  const cli = await fixture(t, `console.log(JSON.stringify({status:'ready',provider:'openai-codex',authType:'oauth',...(args.includes('--credentials')?{credentials:${JSON.stringify(token)}}:{})}));`);
  const provider = createCodexProvider(cli);
  assert.equal(provider.id, 'openai-codex');
  assert.equal(provider.auth.oauth, undefined);
  assert.deepEqual(await provider.auth.apiKey!.check!({ ctx: context, signal: new AbortController().signal }), { source: 'Pi CLI OAuth (read only)', type: 'oauth' });
  assert.deepEqual(await provider.auth.apiKey!.resolve({ ctx: context, signal: new AbortController().signal }), { auth: { apiKey: token }, source: 'Pi CLI OAuth (read only)' });
});

test('availability checks never request credential output', async t => {
  const cli = await fixture(t, `if(args.includes('--credentials'))process.exit(4);console.log(JSON.stringify({status:'ready',provider:'openai-codex',authType:'oauth'}));`);
  await createCodexProvider(cli).auth.apiKey!.check!({ ctx: context, signal: new AbortController().signal });
});

test('redacts malformed output and child errors instead of exposing stdout', async t => {
  for (const body of [`console.log(${JSON.stringify(token)});`, `console.log(${JSON.stringify(token)});console.error(${JSON.stringify(token)});process.exit(1);`, `console.log(JSON.stringify({status:'not_ready',credentials:${JSON.stringify(token)}}));`]) {
    const cli = await fixture(t, body);
    await assert.rejects(createCodexProvider(cli).auth.apiKey!.resolve({ ctx: context, signal: new AbortController().signal }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!String(error).includes(token));
      assert.equal(error.cause, undefined);
      return /authentication is unavailable or expired/u.test(error.message);
    });
  }
});

test('rejects expired JWTs without refreshing the account', async t => {
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`;
  const cli = await fixture(t, `console.log(JSON.stringify({status:'ready',provider:'openai-codex',authType:'oauth',credentials:${JSON.stringify(expired)}}));`);
  await assert.rejects(createCodexProvider(cli).auth.apiKey!.resolve({ ctx: context, signal: new AbortController().signal }), /authentication is unavailable or expired/u);
});

test('bounds child output and cancellation with generic errors', async t => {
  const oversized = await fixture(t, `process.stdout.write('x'.repeat(128*1024));`);
  await assert.rejects(createCodexProvider(oversized).auth.apiKey!.resolve({ ctx: context, signal: new AbortController().signal }), /authentication is unavailable or expired/u);
  const waiting = await fixture(t, `setTimeout(()=>{},30000);`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(createCodexProvider(waiting).auth.apiKey!.resolve({ ctx: context, signal: controller.signal }), /authentication is unavailable or expired/u);
});

test('requires an absolute JavaScript entry path and never invokes a shell wrapper', () => {
  assert.throws(() => createCodexProvider('pi'), /absolute installed Pi CLI/u);
  assert.throws(() => createCodexProvider(join(projectDir, 'pi.cmd')), /absolute installed Pi CLI/u);
  assert.throws(() => createCodexProvider(join(projectDir, 'pi.ps1')), /absolute installed Pi CLI/u);
});
