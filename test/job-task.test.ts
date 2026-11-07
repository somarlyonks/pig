import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Octokit } from "@octokit/rest";
import {
	createRegistry,
	defineTask,
	Harness,
	MemoryStorage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AppConfig } from "../src/config.ts";
import type { GitHubClients } from "../src/github/app.ts";
import { RepoConfigLoader } from "../src/github/repo-config.ts";
import { runGit } from "../src/git.ts";
import { JobDoc } from "../src/durable/docs.ts";
import {
	createJobTask,
	type JobTaskInput,
	type JobTaskResult,
} from "../src/durable/job-task.ts";
import { WorkTools, ReviewTools } from "../src/durable/tools.ts";
import type { JobRequest } from "../src/jobs/types.ts";
import type { Logger } from "../src/logger.ts";

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

const REPO = {
	full_name: "acme/app",
	default_branch: "main",
	archived: false,
};

function httpError(status: number): Error & { status: number } {
	return Object.assign(new Error(`HTTP ${status}`), { status });
}

interface FakeState {
	comments: Map<number, string>;
	nextCommentId: number;
	permission: string | null;
	configYaml: string | null;
	repoFailure: number | null;
	issueState: string;
	pullRequests: { head: string; base: string; title: string; body: string }[];
	pullRequest: {
		number: number;
		title: string;
		body: string;
		state: string;
		merged: boolean;
		user: { login: string };
		head: { sha: string; ref: string };
		base: { ref: string };
	};
	diff: string;
	files: { filename: string; status: string; additions: number; deletions: number }[];
	reviews: {
		html_url: string;
		commit_id: string;
		state: string;
		user: { login: string };
	}[];
	reviewRequests: {
		event: string;
		body: string;
		comments: { path: string; line: number; side: string; body: string }[];
		commit_id: string;
	}[];
	tags: { name: string; commit: { sha: string } }[];
	pulls: {
		number: number;
		title: string;
		merged_at: string;
		updated_at: string;
		base: { ref: string };
		user: { login: string };
		labels: { name: string }[];
	}[];
	release: { html_url: string; tag_name: string } | null;
	createdRefs: string[];
	createdReleases: { tag_name: string; name: string; body: string; draft: boolean; prerelease: boolean }[];
}

function fakeOctokit(state: FakeState): Octokit {
	return {
		request: async (route: string) => {
			if (route.startsWith("GET /repos/") && route.endsWith("/pulls/{pull_number}")) {
				return { data: state.diff };
			}
			return {
				data: {
					token: "fake-installation-token",
					expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
				},
			};
		},
		paginate: async (method: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) =>
			(await method(params)).data,
		repos: {
			get: async () => {
				if (state.repoFailure !== null) throw httpError(state.repoFailure);
				return { data: REPO };
			},
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
			listTags: async () => ({ data: state.tags }),
			getCommit: async () => ({
				data: {
					commit: {
						committer: { date: new Date().toISOString() },
						author: { date: new Date().toISOString() },
					},
				},
			}),
			getBranch: async () => ({ data: { commit: { sha: "head-sha" } } }),
			getReleaseByTag: async () => {
				if (!state.release) throw httpError(404);
				return { data: state.release };
			},
			createRelease: async (parameters: {
				tag_name: string;
				name: string;
				body: string;
				draft: boolean;
				prerelease: boolean;
			}) => {
				state.createdReleases.push(parameters);
				const release = {
					html_url: `https://github.com/acme/app/releases/tag/${parameters.tag_name}`,
					tag_name: parameters.tag_name,
				};
				state.release = release;
				return { data: release };
			},
		},
		git: {
			getRef: async (parameters: { ref: string }) => {
				const tag = parameters.ref.replace(/^tags\//, "");
				if (state.tags.some((entry) => entry.name === tag)) {
					return { data: {} };
				}
				throw httpError(404);
			},
			createRef: async (parameters: { ref: string; sha: string }) => {
				state.createdRefs.push(parameters.ref);
				state.tags.push({
					name: parameters.ref.replace(/^refs\/tags\//, ""),
					commit: { sha: parameters.sha },
				});
				return { data: {} };
			},
		},
		issues: {
			get: async () => ({
				data: {
					number: 7,
					title: "An issue",
					body: "Please add a file.",
					state: state.issueState,
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
			list: async (parameters: { page?: number }) => ({
				data: parameters.page === 1 || parameters.page === undefined ? state.pulls : [],
			}),
			get: async () => ({ data: state.pullRequest }),
			create: async (parameters: { head: string; base: string; title: string; body: string }) => {
				state.pullRequests.push(parameters);
				return {
					data: {
						html_url: "https://github.com/acme/app/pull/99",
						number: 99,
					},
				};
			},
			update: async (parameters: { head: string; base: string; title: string; body: string }) => {
				state.pullRequests.push(parameters);
				return {
					data: {
						html_url: "https://github.com/acme/app/pull/99",
						number: 99,
					},
				};
			},
			listFiles: async (parameters: { page: number }) => ({
				data: parameters.page === 1 ? state.files : [],
			}),
			listReviews: async () => ({ data: state.reviews }),
			listReviewComments: async () => ({ data: [] }),
			createReview: async (parameters: {
				event: string;
				body: string;
				comments: { path: string; line: number; side: string; body: string }[];
				commit_id: string;
			}) => {
				state.reviewRequests.push(parameters);
				const review = {
					html_url: "https://github.com/acme/app/pull/5#review",
					commit_id: parameters.commit_id,
					state: parameters.event,
					user: { login: "pig[bot]" },
				};
				state.reviews.push(review);
				return { data: review };
			},
		},
	} as unknown as Octokit;
}

function baseConfig(workspaceRoot: string): AppConfig {
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
	};
}

const Sleeper = defineTask<Record<string, never>, { phase: "wait" | "done" }, null>({
	name: "probe.sleeper",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (_task, runtime, context) =>
			runtime.sleepUntil(Date.now() + 60_000, { phase: "done" }, context),
		done: (_task, runtime, context) =>
			runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
				context,
			),
	},
	abort: (_task, runtime, context) =>
		runtime.commit(
			() => ({ status: "terminal", outcome: { status: "aborted" } }),
			context,
		),
});

interface HarnessOptions {
	permission?: string | null;
	configYaml?: string | null;
	repoFailure?: number | null;
	remoteUrl?: string;
	responses?: ReturnType<typeof fauxAssistantMessage>[];
}

interface TestHarness {
	harness: Harness;
	state: FakeState;
	workspaceRoot: string;
	run(
		request: JobRequest,
		options?: { maxAttempts?: number; previousTaskId?: number | null },
	): Promise<TaskId<JobTaskResult>>;
	sleeper(): Promise<TaskId<null>>;
	close(): Promise<void>;
}

async function setup(options: HarnessOptions = {}): Promise<TestHarness> {
	const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-job-"));
	const state: FakeState = {
		comments: new Map(),
		nextCommentId: 500,
		permission: options.permission === undefined ? "write" : options.permission,
		configYaml: options.configYaml ?? null,
		repoFailure: options.repoFailure ?? null,
		issueState: "open",
		pullRequests: [],
		pullRequest: {
			number: 5,
			title: "Add app",
			body: "Adds an app.",
			state: "open",
			merged: false,
			user: { login: "alice" },
			head: { sha: "feature-sha", ref: "feature" },
			base: { ref: "main" },
		},
		diff: "",
		files: [],
		reviews: [],
		reviewRequests: [],
		tags: [],
		pulls: [],
		release: null,
		createdRefs: [],
		createdReleases: [],
	};
	const logger = silentLogger();
	const config = baseConfig(workspaceRoot);
	const octokit = fakeOctokit(state);
	const clients: GitHubClients = {
		app: octokit,
		installation: () => octokit,
	};
	const registry = createRegistry();
	registry.install(WorkTools);
	registry.install(ReviewTools);
	registry.install({ name: "probe", tasks: [Sleeper] });
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses(options.responses ?? [fauxAssistantMessage("No changes needed.")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			settings: { extensions: [] },
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot }),
		},
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT);
	const jobTask = createJobTask({
		config,
		logger,
		clients,
		configLoader: new RepoConfigLoader(30, logger),
		models,
		harness,
		listJobs: async () => [],
		cancelRepoJobs: async () => ({ cancelled: 0, running: 0 }),
		...(options.remoteUrl ? { remoteUrlForRepo: () => options.remoteUrl! } : {}),
	});
	registry.install({ name: "pig.jobs", tasks: [jobTask] });
	harness.resume();

	const run: TestHarness["run"] = async (request, runOptions = {}) => {
		const input: JobTaskInput = {
			installationId: 42,
			repo: REPO.full_name,
			request,
			idempotencyKey: `test-${Math.random()}`,
			maxAttempts: runOptions.maxAttempts ?? 1,
			previousTaskId: runOptions.previousTaskId ?? null,
			createdAt: Date.now(),
		};
		return harness.commit(
			(tx) =>
				tx.createTask(jobTask, input, {
					ownership: { kind: "conversation" },
					conversationId: root.id,
				}),
			BACKGROUND_CONTEXT,
		) as Promise<TaskId<JobTaskResult>>;
	};

	return {
		harness,
		state,
		workspaceRoot,
		run,
		sleeper: () =>
			harness.commit(
				(tx) =>
					tx.createTask(
						Sleeper,
						{},
						{ ownership: { kind: "conversation" }, conversationId: root.id },
					),
				BACKGROUND_CONTEXT,
			),
		close: async () => {
			await harness.close(BACKGROUND_CONTEXT);
			rmSync(workspaceRoot, { recursive: true, force: true });
		},
	};
}

async function waitForTaskState(
	harness: Harness,
	taskId: TaskId,
	predicate: (record: NonNullable<Awaited<ReturnType<Harness["getTask"]>>>) => boolean,
	timeoutMs = 10_000,
): Promise<NonNullable<Awaited<ReturnType<Harness["getTask"]>>>> {
	const started = Date.now();
	let last: unknown = null;
	while (Date.now() - started < timeoutMs) {
		const record = await harness.getTask(taskId, BACKGROUND_CONTEXT);
		if (record) {
			last = record.state;
			if (predicate(record)) return record;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Task did not reach the expected state: ${JSON.stringify(last)}`);
}

function workRequest(instructions = "Add a file"): JobRequest {
	return {
		kind: "work",
		instructions,
		actor: "alice",
		source: { type: "issue", number: 7, title: "An issue" },
		trigger: {
			commentId: 1001,
			commentBody: `@pig ${instructions}`,
			commentAuthor: "alice",
			reviewComment: null,
		},
		receivedAt: Date.now(),
	};
}

function helpRequest(actor = "alice"): JobRequest {
	return {
		kind: "control",
		action: "help",
		message: null,
		actor,
		source: { type: "issue", number: 7, title: "An issue" },
		trigger: {
			commentId: 1001,
			commentBody: "@pig help",
			commentAuthor: actor,
			reviewComment: null,
		},
		receivedAt: Date.now(),
	};
}

test("runs a control job, persists state, and posts one progress comment", async () => {
	const app = await setup();
	try {
		const id = await app.run(helpRequest());
		const record = await app.harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(record.state.status, "terminal");
		assert.equal(record.state.outcome.status, "completed");
		const doc = await app.harness.snapshot(JobDoc, String(id), BACKGROUND_CONTEXT);
		assert.equal(doc?.status, "succeeded");
		assert.equal(typeof doc?.progressCommentId, "number");
		assert.equal(app.state.comments.size, 1);
		assert.match([...app.state.comments.values()][0] ?? "", /Pi-durable In GitHub/);
	} finally {
		await app.close();
	}
});

test("fails permanently when the actor lacks write access", async () => {
	const app = await setup({ permission: "read" });
	try {
		const id = await app.run(helpRequest());
		const record = await app.harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(record.state.outcome.status, "failed");
		assert.match(
			record.state.outcome.status === "failed" ? record.state.outcome.error.message : "",
			/needs write access/,
		);
		const doc = await app.harness.snapshot(JobDoc, String(id), BACKGROUND_CONTEXT);
		assert.equal(doc?.status, "failed");
		assert.match([...app.state.comments.values()][0] ?? "", /needs write access/);
	} finally {
		await app.close();
	}
});

test("allows actors listed in repository permissions", async () => {
	const app = await setup({
		permission: null,
		configYaml: "permissions:\n  allow: [trusted]\n",
	});
	try {
		const id = await app.run(helpRequest("trusted"));
		const record = await app.harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(record.state.outcome.status, "completed");
	} finally {
		await app.close();
	}
});

test("reports a repository failure in the progress comment", async () => {
	const app = await setup({ repoFailure: 502 });
	try {
		const id = await app.run(helpRequest());
		const record = await app.harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(record.state.outcome.status, "failed");
		assert.match(
			record.state.outcome.status === "failed" ? record.state.outcome.error.message : "",
			/502/,
		);
		assert.match([...app.state.comments.values()][0] ?? "", /could not complete this request/);
	} finally {
		await app.close();
	}
});

test("sleeps and retries a transient failure", async () => {
	const app = await setup({ repoFailure: 502 });
	try {
		const id = await app.run(helpRequest(), { maxAttempts: 2 });
		const record = await waitForTaskState(
			app.harness,
			id,
			(candidate) => candidate.state.status === "sleeping",
		);
		assert.equal(record.state.status, "sleeping");
		const doc = await app.harness.snapshot(JobDoc, String(id), BACKGROUND_CONTEXT);
		assert.equal(doc?.status, "queued");
		assert.match(doc?.error ?? "", /502/);
		assert.match([...app.state.comments.values()][0] ?? "", /will retry/);
	} finally {
		await app.close();
	}
});

test("opens a pull request from a work command", async () => {
	const root = mkdtempSync(join(tmpdir(), "pig-remote-"));
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

	const app = await setup({
		remoteUrl: bare,
		responses: [
			fauxAssistantMessage(
				fauxToolCall("write", { path: "new.txt", content: "hello\n" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Added new.txt"),
		],
	});
	try {
		const id = await app.run(workRequest("add a new file"));
		const record = await app.harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(record.state.outcome.status, "completed");
		const result =
			record.state.outcome.status === "completed"
				? (record.state.outcome.result as unknown as {
						result: Record<string, unknown>;
					})
				: { result: {} };
		const branch = String(result.result.branch);
		assert.match(branch, /^pig\/7-/);

		const refs = await runGit(["ls-remote", bare], { cwd: root });
		assert.match(refs.stdout, new RegExp(`refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.equal(app.state.pullRequests.length, 1);
		assert.equal(app.state.pullRequests[0]?.head, branch);
		assert.equal(app.state.pullRequests[0]?.base, "main");
		assert.match(
			[...app.state.comments.values()].join("\n"),
			/opened a pull request/,
		);
	} finally {
		await app.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("cancels a waiting job and reports the cancellation", async () => {
	const app = await setup();
	try {
		const previous = await app.sleeper();
		const id = await app.run(helpRequest(), { previousTaskId: previous });
		await waitForTaskState(
			app.harness,
			id,
			(candidate) => candidate.state.status === "waiting",
		);
		assert.equal(await app.harness.abortTask(id, BACKGROUND_CONTEXT), "marked");
		const record = await app.harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(record.state.outcome.status, "aborted");
		const doc = await app.harness.snapshot(JobDoc, String(id), BACKGROUND_CONTEXT);
		assert.equal(doc?.status, "cancelled");
		assert.match([...app.state.comments.values()][0] ?? "", /cancelled this job/);
	} finally {
		await app.close();
	}
});


function reviewRequest(): JobRequest {
	return {
		kind: "review",
		auto: false,
		headSha: null,
		focus: null,
		actor: "alice",
		source: { type: "pull_request", number: 5, title: "Add app" },
		trigger: {
			commentId: 1002,
			commentBody: "@pig review",
			commentAuthor: "alice",
			reviewComment: null,
		},
		receivedAt: Date.now(),
	};
}

test("reviews a pull request with inline findings", async () => {
	const root = mkdtempSync(join(tmpdir(), "pig-review-"));
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	await runGit(["init", "-q", "-b", "main"], { cwd: work });
	writeFileSync(join(work, "README.md"), "initial\n");
	await runGit(["add", "."], { cwd: work });
	await runGit(
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial"],
		{ cwd: work },
	);
	await runGit(["checkout", "-q", "-b", "feature"], { cwd: work });
	mkdirSync(join(work, "src"), { recursive: true });
	writeFileSync(
		join(work, "src", "app.ts"),
		"export const value = 1;\nexport const bug = value / 0;\n",
	);
	await runGit(["add", "-A"], { cwd: work });
	await runGit(
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "feature"],
		{ cwd: work },
	);
	const headSha = (await runGit(["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
	const bare = join(root, "bare.git");
	await runGit(["clone", "-q", "--bare", work, bare], { cwd: root });
	await runGit(["push", "-q", bare, "HEAD:refs/pull/5/head"], { cwd: work });

	const diff = `diff --git a/src/app.ts b/src/app.ts
new file mode 100644
--- /dev/null
+++ b/src/app.ts
@@ -0,0 +1,2 @@
+export const value = 1;
+export const bug = value / 0;
`;
	const app = await setup({
		remoteUrl: bare,
		responses: [
			fauxAssistantMessage(
				JSON.stringify({
					summary: "Found a division bug.",
					verdict: "request_changes",
					findings: [
						{
							path: "src/app.ts",
							line: 2,
							side: "RIGHT",
							severity: "blocker",
							body: "Division by zero.",
						},
					],
				}),
			),
		],
	});
	app.state.pullRequest = {
		number: 5,
		title: "Add app",
		body: "Adds an app.",
		state: "open",
		merged: false,
		user: { login: "alice" },
		head: { sha: headSha, ref: "feature" },
		base: { ref: "main" },
	};
	app.state.diff = diff;
	app.state.files = [{ filename: "src/app.ts", status: "added", additions: 2, deletions: 0 }];
	try {
		const id = await app.run(reviewRequest());
		const record = await app.harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(record.state.outcome.status, "completed");
		assert.equal(app.state.reviewRequests.length, 1);
		const review = app.state.reviewRequests[0]!;
		assert.equal(review.event, "REQUEST_CHANGES");
		assert.equal(review.commit_id, headSha);
		assert.equal(review.comments.length, 1);
		assert.equal(review.comments[0]?.path, "src/app.ts");
		assert.equal(review.comments[0]?.line, 2);
		assert.equal(review.comments[0]?.side, "RIGHT");
		assert.match(review.comments[0]?.body ?? "", /Division by zero/);
		assert.match(review.body, /Found a division bug/);
		assert.match([...app.state.comments.values()].join("\n"), /posted a review/);
	} finally {
		await app.close();
		rmSync(root, { recursive: true, force: true });
	}
});

function releaseRequest(
	version: string | null = null,
	bump: "auto" | "major" | "minor" | "patch" = "minor",
): JobRequest {
	return {
		kind: "release",
		bump,
		version,
		draft: null,
		prerelease: null,
		actor: "alice",
		source: { type: "issue", number: 7, title: "An issue" },
		trigger: {
			commentId: 1003,
			commentBody: "@pig release minor",
			commentAuthor: "alice",
			reviewComment: null,
		},
		receivedAt: Date.now(),
	};
}

test("creates a release and reports an existing one", async () => {
	const app = await setup();
	const now = new Date().toISOString();
	app.state.pulls = [
		{
			number: 10,
			title: "feat: add batch endpoint",
			merged_at: now,
			updated_at: now,
			base: { ref: "main" },
			user: { login: "alice" },
			labels: [],
		},
		{
			number: 11,
			title: "fix: avoid duplicate writes",
			merged_at: now,
			updated_at: now,
			base: { ref: "main" },
			user: { login: "bob" },
			labels: [],
		},
	];
	try {
		const id = await app.run(releaseRequest());
		const record = await app.harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(record.state.outcome.status, "completed");
		assert.equal(app.state.createdReleases.length, 1);
		assert.equal(app.state.createdReleases[0]?.tag_name, "v0.1.0");
		assert.match(app.state.createdReleases[0]?.body ?? "", /add batch endpoint/);
		assert.match(app.state.createdReleases[0]?.body ?? "", /avoid duplicate writes/);
		assert.match([...app.state.comments.values()].join("\n"), /released v0\.1\.0/);

		const second = await app.run(releaseRequest("0.1.0"));
		const secondRecord = await app.harness.waitForTask(second, BACKGROUND_CONTEXT);
		assert.equal(secondRecord.state.outcome.status, "completed");
		assert.equal(app.state.createdReleases.length, 1);
		assert.match([...app.state.comments.values()].join("\n"), /already exists/);
	} finally {
		await app.close();
	}
});
