import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import type { AgentRunner } from "../src/agent/runner.ts";
import type { AppConfig } from "../src/config.ts";
import type { GitHubClients } from "../src/github/app.ts";
import { RepoConfigLoader } from "../src/github/repo-config.ts";
import { JobStore } from "../src/jobs/store.ts";
import type { JobRow } from "../src/jobs/types.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import type { Logger } from "../src/logger.ts";

const REPO = { owner: "acme", name: "app", fullName: "acme/app", defaultBranch: "main", archived: false };

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
	permission: string | null;
	configYaml: string | null;
	issueState: string;
	issueFailure: number | null;
	nextCommentId: number;
}

function httpError(status: number): Error & { status: number } {
	return Object.assign(new Error(`HTTP ${status}`), { status });
}

function fakeOctokit(state: FakeState): Octokit {
	let commentBody = "";
	return {
		repos: {
			get: async () => ({ data: REPO }),
			getContent: async () => {
				if (state.configYaml === null) throw httpError(404);
				return {
					data: {
						type: "file",
						content: Buffer.from(state.configYaml, "utf8").toString("base64"),
					},
				};
			},
			getCollaboratorPermissionLevel: async () => {
				if (state.permission === null) throw httpError(404);
				return { data: { permission: state.permission } };
			},
		},
		issues: {
			get: async () => {
				if (state.issueFailure !== null) throw httpError(state.issueFailure);
				return {
					data: {
						number: 1,
						title: "An issue",
						body: "body",
						state: state.issueState,
						user: { login: "alice" },
					},
				};
			},
			listComments: async () => ({ data: [] }),
			createComment: async (parameters: { body: string }) => {
				commentBody = parameters.body;
				const id = state.nextCommentId++;
				state.comments.set(id, commentBody);
				return { data: { id } };
			},
			updateComment: async (parameters: { comment_id: number; body: string }) => {
				state.comments.set(parameters.comment_id, parameters.body);
				return { data: { id: parameters.comment_id } };
			},
		},
	} as unknown as Octokit;
}

function baseConfig(): AppConfig {
	return {
		appId: 1,
		privateKey: "unused",
		webhookSecret: "unused",
		appSlug: "pig",
		port: 0,
		databasePath: ":memory:",
		workspaceRoot: "/tmp/pig-worker-test",
		model: undefined,
		thinking: undefined,
		piBin: "pi",
		maxConcurrency: 2,
		jobTimeoutMs: 60_000,
		leaseMs: 5_000,
		heartbeatMs: 1_000,
		logLevel: "error",
		adminToken: undefined,
	};
}

interface Harness {
	store: JobStore;
	worker: JobWorker;
	state: FakeState;
	enqueue(kind: "control" | "work", request: Record<string, unknown>, maxAttempts?: number): string;
}

function harness(options: {
	permission?: string | null;
	configYaml?: string | null;
	issueState?: string;
	issueFailure?: number | null;
} = {}): Harness {
	const store = new JobStore(":memory:");
	const state: FakeState = {
		comments: new Map(),
		permission: options.permission === undefined ? "write" : options.permission,
		configYaml: options.configYaml ?? null,
		issueState: options.issueState ?? "open",
		issueFailure: options.issueFailure ?? null,
		nextCommentId: 500,
	};
	const logger = silentLogger();
	const config = baseConfig();
	const octokit = fakeOctokit(state);
	const clients: GitHubClients = {
		app: octokit,
		installation: () => octokit,
	};
	const agent: AgentRunner = async () => {
		throw new Error("Agent must not run in these tests");
	};
	const worker = new JobWorker({
		config,
		store,
		clients,
		configLoader: new RepoConfigLoader(30, logger),
		agentRunner: agent,
		logger,
	});
	return {
		store,
		worker,
		state,
		enqueue(kind, request, maxAttempts) {
			const id = randomUUID();
			store.enqueue(
				{
					id,
					installationId: 7,
					repo: REPO.fullName,
					kind,
					idempotencyKey: `test-${id}`,
					request,
					maxAttempts: maxAttempts ?? 3,
				},
				Date.now(),
			);
			return id;
		},
	};
}

async function waitForJob(
	store: JobStore,
	jobId: string,
	predicate: (job: JobRow) => boolean,
	timeoutMs = 5_000,
): Promise<JobRow> {
	const started = Date.now();
	let last: JobRow | null = null;
	while (Date.now() - started < timeoutMs) {
		const job = store.getJob(jobId);
		if (job) {
			last = job;
			if (predicate(job)) return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Job did not reach the expected state; last=${JSON.stringify(last)}`);
}

function commentRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "control",
		action: "help",
		message: null,
		actor: "alice",
		source: { type: "issue", number: 1, title: "An issue" },
		trigger: { commentId: 99, commentBody: "@pig help", commentAuthor: "alice", reviewComment: null },
		receivedAt: Date.now(),
		...overrides,
	};
}

test("runs a control job and posts one progress comment", async () => {
	const app = harness();
	const jobId = app.enqueue("control", commentRequest());
	app.worker.start();
	try {
		const job = await waitForJob(app.store, jobId, (candidate) => candidate.status === "succeeded");
		assert.equal(job.attempts, 1);
		assert.equal(app.state.comments.size, 1);
		const comment = [...app.state.comments.values()][0] ?? "";
		assert.match(comment, /Pi-durable In GitHub/);
		assert.match((job.result as { summary: string }).summary, /Control command: help/);
	} finally {
		await app.worker.stop();
		app.store.close();
	}
});

test("fails permanently when the actor lacks write access", async () => {
	const app = harness({ permission: "read" });
	const jobId = app.enqueue("control", commentRequest());
	app.worker.start();
	try {
		const job = await waitForJob(app.store, jobId, (candidate) => candidate.status === "failed");
		assert.match(job.error ?? "", /needs write access/);
		const comment = [...app.state.comments.values()][0] ?? "";
		assert.match(comment, /needs write access/);
	} finally {
		await app.worker.stop();
		app.store.close();
	}
});

test("allows actors listed in repository permissions", async () => {
	const app = harness({
		permission: null,
		configYaml: "permissions:\n  allow: [trusted]\n",
	});
	const jobId = app.enqueue("control", commentRequest({ actor: "trusted" }));
	app.worker.start();
	try {
		const job = await waitForJob(app.store, jobId, (candidate) => candidate.status === "succeeded");
		assert.match((job.result as { summary: string }).summary, /Control command: help/);
	} finally {
		await app.worker.stop();
		app.store.close();
	}
});

test("denies actors that are neither writers nor listed", async () => {
	const app = harness({
		permission: null,
		configYaml: "permissions:\n  allow: [someone-else]\n",
	});
	const jobId = app.enqueue("control", commentRequest({ actor: "trusted" }));
	app.worker.start();
	try {
		const job = await waitForJob(app.store, jobId, (candidate) => candidate.status === "failed");
		assert.match(job.error ?? "", /needs write access/);
	} finally {
		await app.worker.stop();
		app.store.close();
	}
});

test("reports a closed issue as a permanent failure", async () => {
	const app = harness({ issueState: "closed" });
	const jobId = app.enqueue(
		"work",
		commentRequest({ kind: "work", instructions: "do it", action: undefined }),
	);
	app.worker.start();
	try {
		const job = await waitForJob(app.store, jobId, (candidate) => candidate.status === "failed");
		assert.match(job.error ?? "", /issue is closed/);
		const comment = [...app.state.comments.values()][0] ?? "";
		assert.match(comment, /could not complete this request/);
	} finally {
		await app.worker.stop();
		app.store.close();
	}
});

test("requeues retryable failures without exhausting attempts", async () => {
	const app = harness({ issueFailure: 502 });
	const jobId = app.enqueue(
		"work",
		commentRequest({ kind: "work", instructions: "do it", action: undefined }),
		2,
	);
	app.worker.start();
	try {
		const job = await waitForJob(
			app.store,
			jobId,
			(candidate) => candidate.status === "queued" && candidate.attempts === 1,
		);
		assert.match(job.error ?? "", /502/);
		assert.ok(job.availableAt > Date.now());
		const comment = [...app.state.comments.values()][0] ?? "";
		assert.match(comment, /will retry/);
	} finally {
		await app.worker.stop();
		app.store.close();
	}
});
