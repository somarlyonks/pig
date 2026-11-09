import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git.ts";
import { RemoteRunnerClient } from "../src/durable/remote-runner.ts";
import { startRunnerServer, type RunningRunner } from "../src/runner/server.ts";

async function setup(): Promise<{
	runner: RunningRunner;
	client: RemoteRunnerClient;
	root: string;
	bare: string;
}> {
	const root = mkdtempSync(join(tmpdir(), "pig-runner-"));
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	await runGit(["init", "-q", "-b", "main"], { cwd: work });
	writeFileSync(join(work, "README.md"), "initial\n");
	await runGit(["add", "."], { cwd: work });
	await runGit(
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial"],
		{ cwd: work },
	);
	const bare = join(root, "bare.git");
	await runGit(["clone", "-q", "--bare", work, bare], { cwd: root });
	const runner = await startRunnerServer({
		port: 0,
		token: "runner-token",
		workspaceRoot: join(root, "workspaces"),
	});
	const client = new RemoteRunnerClient({
		baseUrl: `http://127.0.0.1:${runner.port}`,
		token: "runner-token",
	});
	return { runner, client, root, bare };
}

test("runs a remote workspace through the runner", async () => {
	const app = await setup();
	try {
		const workspace = await app.client.createWorkspace({
			jobId: "42",
			repo: "acme/app",
			ref: "main",
			localBranch: "pig/42-test",
			attempt: 1,
			token: "fake",
			remoteUrl: app.bare,
		});
		assert.equal(workspace.workspaceId, "42");
		assert.match(workspace.baseSha, /^[0-9a-f]{40}$/);

		await app.client.write("42", "new.txt", "hello\n");
		assert.deepEqual(await app.client.read("42", "new.txt"), { content: "hello\n" });
		const bash = await app.client.bash("42", "cat new.txt");
		assert.equal(bash.exitCode, 0);
		assert.match(bash.output, /hello/);

		assert.deepEqual(await app.client.changed("42"), { paths: ["new.txt"] });
		const commit = await app.client.commit("42", {
			message: "feat: add new file",
			name: "PiG",
			email: "pig@example.com",
		});
		assert.match(commit.sha ?? "", /^[0-9a-f]{40}$/);
		await app.client.push("42", { branch: "pig/42-test", force: true }, "fake");

		const refs = await runGit(["ls-remote", app.bare], { cwd: app.root });
		assert.match(refs.stdout, /refs\/heads\/pig\/42-test/);
		assert.match((await app.client.head("42")).sha, /^[0-9a-f]{40}$/);

		await app.client.cleanup("42");
		await assert.rejects(
			() => app.client.head("42"),
			(error: unknown) =>
				typeof error === "object" &&
				error !== null &&
				"status" in error &&
				(error as { status: number }).status === 404,
		);
	} finally {
		await app.runner.close();
		rmSync(app.root, { recursive: true, force: true });
	}
});

test("rejects paths outside the workspace", async () => {
	const app = await setup();
	try {
		await app.client.createWorkspace({
			jobId: "43",
			repo: "acme/app",
			ref: "main",
			localBranch: "pig/43-test",
			attempt: 1,
			token: "fake",
			remoteUrl: app.bare,
		});
		await assert.rejects(
			() => app.client.read("43", "../escape"),
			(error: unknown) =>
				typeof error === "object" &&
				error !== null &&
				"status" in error &&
				(error as { status: number }).status === 400,
		);
		await assert.rejects(
			() => app.client.write("43", "/etc/passwd", "nope"),
			(error: unknown) =>
				typeof error === "object" &&
				error !== null &&
				"status" in error &&
				(error as { status: number }).status === 400,
		);
	} finally {
		await app.runner.close();
		rmSync(app.root, { recursive: true, force: true });
	}
});
