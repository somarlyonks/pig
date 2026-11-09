import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { AppConfig } from "../src/config.ts";
import type { GitHubClients } from "../src/github/app.ts";
import type { Logger } from "../src/logger.ts";
import { createOrchestrationRuntime } from "../src/durable/orchestration-runtime.ts";

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

function httpError(status: number):Error & { status: number } {
	return Object.assign(new Error(`HTTP ${status}`), { status });
}

interface FakeState {
	permission: string | null;
	comments: Map<number, string>;
	nextCommentId: number;
	repoFailure: number | null;
}

function fakeOctokit(state: FakeState): Octokit {
	return {
		request: async () => ({
			data: {
				token: "fake",
				expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
			},
		}),
		repos: {
			get: async () => {
				if (state.repoFailure !== null) throw httpError(state.repoFailure);
				return { data: REPO };
			},
			getContent: async () => {
				throw httpError(404);
			},
			getCollaboratorPermissionLevel: async () => {
				if (state.permission === null) throw httpError(404);
				return { data: { permission: state.permission } };
			},
		},
		issues: {
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
	} as unknown as Octokit;
}

function config(): AppConfig {
	return {
		appId: 1,
		privateKey: "unused",
		webhookSecret: "unused",
		appSlug: "pig",
		port: 0,
		databasePath: ":memory:",
		workspaceRoot: join(tmpdir(), "pig-orchestration"),
		model: undefined,
		thinking: undefined,
		tablePrefix: "pig_",
		jobTimeoutMs: 60_000,
		logLevel: "error",
		adminToken: undefined,
	};
}

function commentPayload(body: string, id = 1001): Record<string, unknown> {
	return {
		action: "created",
		repository: { full_name: "acme/app" },
		installation: { id: 42 },
		issue: {
			number: 7,
			title: "An issue",
			body: "",
			user: { login: "alice" },
		},
		comment: {
			id,
			body,
			user: { login: "alice", type: "User" },
		},
	};
}

async function setup(options: { repoFailure?: number | null } = {}) {
	const state: FakeState = {
		permission: "write",
		comments: new Map(),
		nextCommentId: 500,
		repoFailure: options.repoFailure ?? null,
	};
	const octokit = fakeOctokit(state);
	const clients: GitHubClients = {
		app: octokit,
		installation: () => octokit,
	};
	const logger = silentLogger();
	const runtime = await createOrchestrationRuntime({
		storage: new MemoryStorage(),
		config: config(),
		clients,
		logger,
	});
	return { runtime, state };
}

test("runs control jobs in the serverless orchestration runtime", async () => {
	const app = await setup();
	try {
		const result = await app.runtime.admit({
			event: "issue_comment",
			deliveryId: "d1",
			payload: commentPayload("@pig help"),
		});
		assert.equal(result.status, 202);
		assert.ok(result.body.jobId);
		await app.runtime.harness.waitForTask(
			Number(result.body.jobId) as never,
			BACKGROUND_CONTEXT,
		);
		const jobs = await app.runtime.listJobs("acme/app", 10);
		assert.equal(jobs.length, 1);
		assert.equal(jobs[0]?.kind, "control");
		assert.equal(jobs[0]?.status, "succeeded");
		assert.match([...app.state.comments.values()][0] ?? "", /Pi-durable In GitHub/);
	} finally {
		await app.runtime.shutdown();
	}
});

test("turns coding commands into an explicit notice", async () => {
	const app = await setup();
	try {
		const result = await app.runtime.admit({
			event: "issue_comment",
			deliveryId: "d2",
			payload: commentPayload("@pig fix the parser"),
		});
		assert.equal(result.status, 202);
		await app.runtime.harness.waitForTask(
			Number(result.body.jobId) as never,
			BACKGROUND_CONTEXT,
		);
		const jobs = await app.runtime.listJobs("acme/app", 10);
		assert.equal(jobs[0]?.kind, "control");
		assert.match(
			[...app.state.comments.values()].join("\n"),
			/control and release jobs only/,
		);
	} finally {
		await app.runtime.shutdown();
	}
});

test("ignores automatic reviews on the orchestration host", async () => {
	const app = await setup();
	try {
		const payload = {
			action: "opened",
			repository: { full_name: "acme/app" },
			installation: { id: 42 },
			pull_request: {
				number: 5,
				title: "A change",
				state: "open",
				merged: false,
				draft: false,
				user: { login: "alice", type: "User" },
				head: { sha: "abc1234", ref: "feature" },
				base: { ref: "main" },
			},
		};
		const result = await app.runtime.admit({
			event: "pull_request",
			deliveryId: "d3",
			payload,
		});
		assert.equal(result.status, 202);
		assert.equal(result.body.jobId, null);
		assert.match(String(result.body.ignored), /coding jobs/);
		assert.equal(app.state.comments.size, 0);
	} finally {
		await app.runtime.shutdown();
	}
});

test("projects sleeping tasks onto the next alarm", async () => {
	const app = await setup({ repoFailure: 502 });
	try {
		const result = await app.runtime.admit({
			event: "issue_comment",
			deliveryId: "d4",
			payload: commentPayload("@pig release minor", 1004),
		});
		assert.ok(result.body.jobId);
		const now = Date.now();
		let alarm: number | undefined;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			alarm = await app.runtime.nextAlarm(now);
			if (alarm !== undefined && alarm > now) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(alarm !== undefined);
		assert.ok(alarm! > now);
	} finally {
		await app.runtime.shutdown();
	}
});
