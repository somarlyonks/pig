import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Octokit } from "@octokit/rest";
import {
	createRegistry,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AppConfig } from "../src/config.ts";
import type { GitHubClients } from "../src/github/app.ts";
import { RepoConfigLoader } from "../src/github/repo-config.ts";
import { runGit } from "../src/git.ts";
import { createJobTask } from "../src/durable/job-task.ts";
import type { JobTaskInput } from "../src/durable/task-types.ts";
import { RemoteRunnerClient } from "../src/durable/remote-runner.ts";
import { RemoteJobWorkspace } from "../src/durable/remote-workspace.ts";
import { createRemoteReviewTools, createRemoteWorkTools } from "../src/durable/remote-tools.ts";
import { startRunnerServer } from "../src/runner/server.ts";
import type { Logger } from "../src/logger.ts";
import type { JobRequest } from "../src/jobs/types.ts";

const REPO = {
	full_name: "acme/app",
	default_branch: "main",
	archived: false,
};

function silentLogger(): Logger {
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => logger,
	};
	return logger;
}

interface FakeState {
	comments: Map<number, string>;
	nextCommentId: number;
	pulls: { head: string; base: string; title: string; body: string }[];
}

function fakeOctokit(state: FakeState): Octokit {
	return {
		request: async () => ({
			data: {
				token: "fake-token",
				expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
			},
		}),
		repos: {
			get: async () => ({ data: REPO }),
			getContent: async () => {
				throw Object.assign(new Error("not found"), { status: 404 });
			},
			getCollaboratorPermissionLevel: async () => ({
				data: { permission: "write" },
			}),
		},
		issues: {
			get: async () => ({
				data: {
					number: 7,
					title: "An issue",
					body: "Please add a file.",
					state: "open",
					user: { login: "alice" },
				},
			}),
			listComments: async () => ({ data: [] }),
			createComment: async (parameters: { body: string }) => {
				const id = state.nextCommentId++;
				state.comments.set(id, parameters.body);
				return { data: { id } };
			},
			updateComment: async (parameters: { comment_id: number; body: string }) => {
				state.comments.set(parameters.comment_id, parameters.body);
				return { data: { id: parameters.comment_id } };
			},
		},
		pulls: {
			list: async () => ({ data: [] }),
			create: async (parameters: { head: string; base: string; title: string; body: string }) => {
				state.pulls.push(parameters);
				return {
					data: {
						html_url: "https://github.com/acme/app/pull/99",
						number: 99,
					},
				};
			},
		},
	} as unknown as Octokit;
}

function config(workspaceRoot: string): AppConfig {
	return {
		appId: 1,
		privateKey: "unused",
		webhookSecret: "unused",
		appSlug: "pig",
		port: 0,
		databasePath: ":memory:",
		workspaceRoot,
		model: undefined,
		thinking: undefined,
		tablePrefix: "pig_",
		jobTimeoutMs: 60_000,
		logLevel: "error",
		adminToken: undefined,
		console: null,
	};
}

function workRequest(): JobRequest {
	return {
		kind: "work",
		origin: "github",
		target: "new",
		instructions: "add a new file",
		actor: "alice",
		source: { type: "issue", number: 7, title: "An issue" },
		trigger: {
			commentId: 1001,
			commentBody: "@pig add a new file",
			commentAuthor: "alice",
			reviewComment: null,
		},
		receivedAt: Date.now(),
	};
}

test("runs a work job with a remote workspace and tools", async () => {
	const root = mkdtempSync(join(tmpdir(), "pig-remote-job-"));
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
		workspaceRoot: join(root, "runner-workspaces"),
	});
	const runnerClient = new RemoteRunnerClient({
		baseUrl: `http://127.0.0.1:${runner.port}`,
		token: "runner-token",
	});
	const state: FakeState = { comments: new Map(), nextCommentId: 500, pulls: [] };
	const octokit = fakeOctokit(state);
	const clients: GitHubClients = { app: octokit, installation: () => octokit };
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", { path: "new.txt", content: "hello\n" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Added new.txt"),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	const workTools = createRemoteWorkTools(runnerClient);
	const reviewTools = createRemoteReviewTools(runnerClient);
	registry.install(workTools);
	registry.install(reviewTools);
	const logger = silentLogger();
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { extensions: [] } },
		BACKGROUND_CONTEXT,
	);
	const rootConversation = await harness.root(BACKGROUND_CONTEXT);
	const jobTask = createJobTask({
		config: config(join(root, "unused")),
		logger,
		clients,
		configLoader: new RepoConfigLoader(30, logger),
		models,
		harness,
		listJobs: async () => [],
		cancelRepoJobs: async () => ({ cancelled: 0, running: 0 }),
		workspaceFactory: (options) =>
			new RemoteJobWorkspace({
				...options,
				client: runnerClient,
				remoteUrl: bare,
			}),
		toolExtensions: { work: workTools, review: reviewTools },
	});
	registry.install({ name: "pig.jobs", tasks: [jobTask] });
	harness.resume();
	const input: JobTaskInput = {
		installationId: 42,
		repo: "acme/app",
		request: workRequest(),
		idempotencyKey: "remote-job-test",
		maxAttempts: 1,
		previousTaskId: null,
		createdAt: Date.now(),
	};
	try {
		const id = await harness.commit(
			(tx) =>
				tx.createTask(jobTask, input, {
					ownership: { kind: "conversation" },
					conversationId: rootConversation.id,
				}),
			BACKGROUND_CONTEXT,
		);
		const settled = await harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(settled.state.outcome.status, "completed");
		assert.equal(state.pulls.length, 1);
		assert.match(state.pulls[0]?.head ?? "", /^pig\/7-/);
		const refs = await runGit(["ls-remote", bare], { cwd: root });
		assert.match(refs.stdout, new RegExp(state.pulls[0]!.head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match([...state.comments.values()].join("\n"), /opened a pull request/);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		await runner.close();
		rmSync(root, { recursive: true, force: true });
	}
});
