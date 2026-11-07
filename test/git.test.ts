import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	assertSafeGitRef,
	branchSlug,
	listChangedPaths,
	resetLocalGitConfig,
	runGit,
	sanitizeCommitMessage,
	withGitAskpass,
} from "../src/git.ts";

function temporaryDirectory(): string {
	return mkdtempSync(join(tmpdir(), "pig-git-"));
}

test("lists tracked modifications and untracked files", async () => {
	const directory = temporaryDirectory();
	try {
		await runGit(["init", "-q"], { cwd: directory });
		await runGit(["config", "user.email", "test@example.com"], { cwd: directory });
		await runGit(["config", "user.name", "Test"], { cwd: directory });
		writeFileSync(join(directory, "tracked.txt"), "one\n");
		await runGit(["add", "tracked.txt"], { cwd: directory });
		await runGit(["commit", "-q", "-m", "initial"], { cwd: directory });
		assert.deepEqual(await listChangedPaths(directory), []);

		writeFileSync(join(directory, "tracked.txt"), "two\n");
		writeFileSync(join(directory, "new.txt"), "new\n");
		assert.deepEqual(await listChangedPaths(directory), ["new.txt", "tracked.txt"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("resets agent-controlled Git configuration", async () => {
	const directory = temporaryDirectory();
	try {
		await runGit(["init", "-q"], { cwd: directory });
		writeFileSync(
			join(directory, ".git", "config"),
			'[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://evil.example/repo.git\n[credential]\n\thelper = "!steal"\n',
		);
		resetLocalGitConfig(directory, "acme/app");
		const config = readFileSync(join(directory, ".git", "config"), "utf8");
		assert.match(config, /url = https:\/\/github\.com\/acme\/app\.git/);
		assert.doesNotMatch(config, /evil\.example/);
		assert.doesNotMatch(config, /steal/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("creates and removes a short-lived askpass script", async () => {
	let scriptPath = "";
	const result = await withGitAskpass(async (askpassPath) => {
		scriptPath = askpassPath;
		assert.equal(existsSync(askpassPath), true);
		return readFileSync(askpassPath, "utf8");
	});
	assert.match(result, /PIG_GIT_TOKEN/);
	assert.equal(existsSync(scriptPath), false);
});

test("rejects unsafe references and normalizes helpers", () => {
	assertSafeGitRef("refs/heads/pig/feature");
	assertSafeGitRef("pull/1/head");
	for (const ref of ["-x", "a..b", "a b", "a@{1}", "a~1", "a:b", "a?b", "a*b", "a[b", "a^b", "a\\b"]) {
		assert.throws(() => assertSafeGitRef(ref), new RegExp("Unsafe git reference"));
	}
	assert.equal(branchSlug("Fix the Parser!!"), "fix-the-parser");
	assert.equal(branchSlug("😀"), "task");
	assert.equal(sanitizeCommitMessage("  fix:  handle empty input\n\nmore ", "fallback"), "fix: handle empty input");
	assert.equal(sanitizeCommitMessage("", "fallback message"), "fallback message");
	assert.equal(sanitizeCommitMessage("", ""), "PiG: apply requested changes");
	assert.equal(sanitizeCommitMessage("a".repeat(100), "fallback").length, 72);
});

test("runGit does not inherit application secrets", async () => {
	const directory = temporaryDirectory();
	const previous = process.env.PIG_WEBHOOK_SECRET;
	process.env.PIG_WEBHOOK_SECRET = "do-not-leak";
	try {
		await runGit(["init", "-q"], { cwd: directory });
		const result = await runGit(
			["-c", "alias.leak-env=!f() { echo \"$PIG_WEBHOOK_SECRET\"; }; f", "leak-env"],
			{ cwd: directory },
		);
		assert.equal(result.stdout.trim(), "");
	} finally {
		if (previous === undefined) delete process.env.PIG_WEBHOOK_SECRET;
		else process.env.PIG_WEBHOOK_SECRET = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
