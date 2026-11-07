import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAgentEnvironment, runPiAgent } from "../src/agent/runner.ts";

function fakePi(script: string): { dir: string; bin: string } {
	const dir = mkdtempSync(join(tmpdir(), "pig-agent-"));
	const bin = join(dir, "fake-pi.sh");
	writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
	chmodSync(bin, 0o700);
	return { dir, bin };
}

test("parses Pi JSONL and final assistant text", async () => {
	const fake = fakePi(
		`printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","toolCall":{"toolName":"read"}}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}]}}'
exit 0`,
	);
	const logs: string[] = [];
	try {
		const result = await runPiAgent(fake.bin, {
			cwd: fake.dir,
			prompt: "test",
			tools: ["read"],
			model: null,
			thinking: null,
			timeoutMs: 5000,
			signal: new AbortController().signal,
			onLog: (message) => logs.push(message),
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, false);
		assert.equal(result.aborted, false);
		assert.equal(result.finalText, "final answer");
		assert.deepEqual(logs, ["Tool: read"]);
	} finally {
		rmSync(fake.dir, { recursive: true, force: true });
	}
});

test("strips PiG and GitHub secrets from the agent environment", async () => {
	const outputPath = join(tmpdir(), `pig-env-${process.pid}-${Date.now()}.txt`);
	const fake = fakePi(
		`printf '%s|%s|%s' "\${PIG_GITHUB_PRIVATE_KEY:-missing}" "\${GITHUB_TOKEN:-missing}" "\${ANTHROPIC_API_KEY:-missing}" > ${outputPath}`,
	);
	const previous = {
		privateKey: process.env.PIG_GITHUB_PRIVATE_KEY,
		githubToken: process.env.GITHUB_TOKEN,
		anthropic: process.env.ANTHROPIC_API_KEY,
	};
	process.env.PIG_GITHUB_PRIVATE_KEY = "private-key";
	process.env.GITHUB_TOKEN = "github-token";
	process.env.ANTHROPIC_API_KEY = "model-key";
	try {
		const result = await runPiAgent(fake.bin, {
			cwd: fake.dir,
			prompt: "test",
			tools: ["read"],
			model: null,
			thinking: null,
			timeoutMs: 5000,
			signal: new AbortController().signal,
		});
		assert.equal(result.exitCode, 0);
		assert.equal(readFileSync(outputPath, "utf8"), "missing|missing|model-key");
		assert.equal(buildAgentEnvironment().PIG_GITHUB_PRIVATE_KEY, undefined);
	} finally {
		for (const [key, value] of [
			["PIG_GITHUB_PRIVATE_KEY", previous.privateKey],
			["GITHUB_TOKEN", previous.githubToken],
			["ANTHROPIC_API_KEY", previous.anthropic],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(fake.dir, { recursive: true, force: true });
		rmSync(outputPath, { force: true });
	}
});

test("excludes unrelated host secrets from the agent environment", () => {
	const environment = buildAgentEnvironment({
		PATH: "/usr/bin",
		DATABASE_URL: "postgres://secret",
		NPM_TOKEN: "npm-secret",
		AWS_ACCESS_KEY_ID: "provider-credential",
		AZURE_CLIENT_SECRET: "unrelated-azure-secret",
		AZURE_OPENAI_API_KEY: "azure-model-key",
		PIG_ADMIN_TOKEN: "admin-secret",
		GH_TOKEN: "gh-secret",
		PI_CODING_AGENT_SESSION_DIR: "/tmp/sessions",
	});
	assert.equal(environment.DATABASE_URL, undefined);
	assert.equal(environment.NPM_TOKEN, undefined);
	assert.equal(environment.AZURE_CLIENT_SECRET, undefined);
	assert.equal(environment.PIG_ADMIN_TOKEN, undefined);
	assert.equal(environment.GH_TOKEN, undefined);
	assert.equal(environment.AWS_ACCESS_KEY_ID, "provider-credential");
	assert.equal(environment.AZURE_OPENAI_API_KEY, "azure-model-key");
	assert.equal(environment.PI_CODING_AGENT_SESSION_DIR, "/tmp/sessions");
	assert.equal(environment.CI, "1");
});

test("times out and kills the Pi process group", async () => {
	const fake = fakePi(`sleep 10`);
	try {
		const result = await runPiAgent(fake.bin, {
			cwd: fake.dir,
			prompt: "test",
			tools: ["read"],
			model: null,
			thinking: null,
			timeoutMs: 250,
			signal: new AbortController().signal,
		});
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, null);
	} finally {
		rmSync(fake.dir, { recursive: true, force: true });
	}
});

test("aborts on signal", async () => {
	const fake = fakePi(`sleep 10`);
	const controller = new AbortController();
	try {
		setTimeout(() => controller.abort(), 100);
		const result = await runPiAgent(fake.bin, {
			cwd: fake.dir,
			prompt: "test",
			tools: ["read"],
			model: null,
			thinking: null,
			timeoutMs: 5000,
			signal: controller.signal,
		});
		assert.equal(result.aborted, true);
		assert.equal(result.exitCode, null);
	} finally {
		rmSync(fake.dir, { recursive: true, force: true });
	}
});
