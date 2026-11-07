import { test } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	assertSafeGitRef,
	branchSlug,
	commitAll,
	listChangedPaths,
	resetLocalGitConfig,
	revertWorkflowChanges,
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

test("reverts and removes workflow file changes", async () => {
	const directory = temporaryDirectory();
	try {
		await runGit(["init", "-q"], { cwd: directory });
		await runGit(["config", "user.email", "test@example.com"], { cwd: directory });
		await runGit(["config", "user.name", "Test"], { cwd: directory });
		mkdirSync(join(directory, ".github", "workflows"), { recursive: true });
		writeFileSync(join(directory, ".github", "workflows", "ci.yml"), "name: CI\n");
		writeFileSync(join(directory, "app.txt"), "app\n");
		await runGit(["add", "-A"], { cwd: directory });
		await runGit(["commit", "-q", "-m", "initial"], { cwd: directory });

		writeFileSync(join(directory, ".github", "workflows", "ci.yml"), "name: Hacked\n");
		writeFileSync(join(directory, ".github", "workflows", "new.yml"), "name: New\n");
		writeFileSync(join(directory, "app.txt"), "changed\n");

		const changed = await listChangedPaths(directory);
		const guard = await revertWorkflowChanges(directory, changed);
		assert.deepEqual(guard.reverted.sort(), [
			".github/workflows/ci.yml",
			".github/workflows/new.yml",
		]);
		assert.equal(readFileSync(join(directory, ".github", "workflows", "ci.yml"), "utf8"), "name: CI\n");
		assert.equal(existsSync(join(directory, ".github", "workflows", "new.yml")), false);
		assert.deepEqual(await listChangedPaths(directory), ["app.txt"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("commits all changes and returns null for an empty tree", async () => {
	const directory = temporaryDirectory();
	try {
		await runGit(["init", "-q"], { cwd: directory });
		assert.equal(
			await commitAll({ cwd: directory, message: "nothing", name: "PiG", email: "pig@example.com" }),
			null,
		);
		writeFileSync(join(directory, "file.txt"), "content\n");
		const sha = await commitAll({
			cwd: directory,
			message: "feat: add file",
			name: "PiG",
			email: "pig@example.com",
		});
		assert.match(sha ?? "", /^[0-9a-f]{40}$/);
		const log = await runGit(["log", "-1", "--format=%s%n%an"], { cwd: directory });
		assert.equal(log.stdout.trim(), "feat: add file\nPiG");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
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
