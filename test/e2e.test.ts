import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
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
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AppConfig } from "../src/config.ts";
import { createConsoleRuntime, type ConsoleConfig, type ConsoleRuntime } from "../src/console/runtime.ts";
import { handleConsoleRequest, consoleServiceFromRuntime } from "../src/console/http.ts";
import { admitWebhook } from "../src/durable/admission.ts";
import { dispatchCommand } from "../src/dispatch/admit.ts";
import {
	countActiveJobs,
	findJobByCommandKey,
	getJobDetail,
	listJobsForRepo,
} from "../src/durable/inspect.ts";
import { createJobTask, JOB_TASK_NAME } from "../src/durable/job-task.ts";
import { createLocalWorkspace } from "../src/durable/local-workspace.ts";
import { ReviewTools, WorkTools } from "../src/durable/tools.ts";
import type { PigApp } from "../src/durable/runtime-types.ts";
import { RepoConfigLoader } from "../src/github/repo-config.ts";
import type { GitHubClients } from "../src/github/app.ts";
import { runGit } from "../src/git.ts";
import type { Logger } from "../src/logger.ts";
import { startHttpServer, type RunningServer } from "../src/server.ts";

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

const FULL_NAME = "acme/app";
const ADMIN_TOKEN = "pig-admin";
interface FakeGitHub {
	octokit: Octokit;
	pullRequests: { head: string; base: string; draft?: boolean; body: string }[];
	comments: string[];
}

function fakeGitHub(headSha: string): FakeGitHub {
	const pullRequests: FakeGitHub["pullRequests"] = [];
	const comments: string[] = [];
	const repo = {
		full_name: FULL_NAME,
		default_branch: "main",
		archived: false,
	};
	const pullRequest = {
		number: 5,
		title: "Add app",
		body: "Adds an app.",
		state: "open",
		merged: false,
		user: { login: "alice" },
		head: { sha: headSha, ref: "feature", repo: { full_name: FULL_NAME } },
		base: { ref: "main" },
	};
	const octokit = {
		request: async (route: string) => {
			if (route.endsWith("/installation")) {
				return { data: { id: 42 } };
			}
			return {
				data: {
					token: "fake-installation-token",
					expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
				},
			};
		},
		paginate: async (
			method: (params: unknown) => Promise<{ data: unknown[] }>,
			params: unknown,
		) => (await method(params)).data,
		repos: {
			get: async () => ({ data: repo }),
			getContent: async () => {
				throw Object.assign(new Error("HTTP 404"), { status: 404 });
			},
			getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }),
		},
		issues: {
			get: async () => ({
				data: {
					number: 5,
					title: "Add app",
					body: "Adds an app.",
					state: "open",
					user: { login: "alice" },
					pull_request: {},
				},
			}),
			listComments: async () => ({ data: [] }),
			createComment: async (parameters: { body: string }) => {
				comments.push(parameters.body);
				return { data: { id: 500 + comments.length } };
			},
			updateComment: async () => ({ data: { id: 500 } }),
		},
		pulls: {
			get: async () => ({ data: pullRequest }),
			list: async () => ({ data: [] }),
			listFiles: async () => ({ data: [] }),
			listReviews: async () => ({ data: [] }),
			listReviewComments: async () => ({ data: [] }),
			create: async (parameters: {
				head: string;
				base: string;
				title: string;
				body: string;
				draft?: boolean;
			}) => {
				pullRequests.push(parameters);
				return {
					data: { html_url: "https://github.com/acme/app/pull/99", number: 99 },
				};
			},
			update: async () => ({
				data: { html_url: "https://github.com/acme/app/pull/99", number: 99 },
			}),
		},
	} as unknown as Octokit;
	return { octokit, pullRequests, comments };
}

function pigConfig(workspaceRoot: string): AppConfig {
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
		adminToken: ADMIN_TOKEN,
		console: null,
	};
}

function consoleConfig(): ConsoleConfig {
	return {
		adminToken: "console-token",
		tablePrefix: "console_",
		enrollmentTtlMs: 60 * 60_000,
		observationTtlMs: 0,
		dispatchDeadlineMs: 24 * 60 * 60_000,
		workerTimeoutMs: 10_000,
		logLevel: "error",
		model: null,
		thinking: null,
	};
}

async function startPig(options: {
	github: FakeGitHub;
	workspaceRoot: string;
	remoteUrl: string;
}): Promise<{ app: PigApp; running: RunningServer; baseUrl: string }> {
	const logger = silentLogger();
	const config = pigConfig(options.workspaceRoot);
	const clients: GitHubClients = {
		app: options.github.octokit,
		installation: () => options.github.octokit,
	};
	const registry = createRegistry();
	registry.install(WorkTools);
	registry.install(ReviewTools);
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", { path: "patch.txt", content: "patched\n" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Added patch.txt"),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			settings: { extensions: [] },
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.workspaceRoot }),
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
		listJobs: (repo, limit) => listJobsForRepo(harness, JOB_TASK_NAME, repo, limit),
		cancelRepoJobs: async () => ({ cancelled: 0, running: 0 }),
		workspaceFactory: (workspaceOptions) =>
			createLocalWorkspace({
				...workspaceOptions,
				remoteUrlForRepo: () => options.remoteUrl,
			}),
		toolExtensions: { work: WorkTools, review: ReviewTools },
	});
	registry.install({ name: "pig.jobs", tasks: [jobTask] });
	harness.resume();

	const deps = {
		harness,
		rootId: root.id,
		appSlug: config.appSlug,
		logger,
		task: jobTask,
	};
	const app: PigApp = {
		config,
		harness,
		admit: (input) => admitWebhook(deps, input),
		dispatch: (input) => dispatchCommand({ app: clients.app, input, deps }),
		listJobs: (repo, limit) => listJobsForRepo(harness, JOB_TASK_NAME, repo, limit),
		getJob: async (id, repo) => {
			const detail = await getJobDetail(harness, JOB_TASK_NAME, id);
			if (!detail) return null;
			if (repo !== undefined && detail.repo !== repo) return null;
			return detail;
		},
		getJobByCommandKey: (key) => findJobByCommandKey(harness, JOB_TASK_NAME, key),
		activeJobs: () => countActiveJobs(harness, JOB_TASK_NAME),
		closed: harness.closed,
		shutdown: () => harness.close(BACKGROUND_CONTEXT),
	};
	const running = await startHttpServer({
		config,
		logger,
		version: "e2e",
		app,
	});
	const address = running.server.address() as AddressInfo;
	return { app, running, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitForTerminalJob(
	app: PigApp,
	timeoutMs = 20_000,
): Promise<{ status: string; id: string }> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const jobs = await app.listJobs(FULL_NAME, 5);
		const job = jobs[0];
		if (job && (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled")) {
			return { status: job.status, id: job.id };
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("job did not finish");
}

async function waitForJobReply(
	app: PigApp,
	id: string,
	timeoutMs = 20_000,
): Promise<{ reply: string | null; request: { kind: string; origin: string } }> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const detail = await app.getJob(id);
		if (detail?.job.status === "succeeded" || detail?.job.status === "failed") {
			return {
				reply: detail.reply,
				request: { kind: detail.request.kind, origin: detail.request.origin },
			};
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("job did not answer");
}

async function prepareRemote(root: string): Promise<{ bare: string; headSha: string }> {
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
	writeFileSync(join(work, "feature.txt"), "feature\n");
	await runGit(["add", "."], { cwd: work });
	await runGit(
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "feature"],
		{ cwd: work },
	);
	const headSha = (await runGit(["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
	const bare = join(root, "bare.git");
	await runGit(["clone", "-q", "--bare", work, bare], { cwd: root });
	await runGit(["update-ref", "refs/pull/5/head", headSha], { cwd: bare });
	return { bare, headSha };
}

test("console to PiG to a patch pull request, over HTTP", async () => {
	const root = mkdtempSync(join(tmpdir(), "pig-e2e-"));
	const workspaceRoot = join(root, "workspaces");
	mkdirSync(workspaceRoot, { recursive: true });
	const { bare, headSha } = await prepareRemote(root);
	const github = fakeGitHub(headSha);
	let pig: Awaited<ReturnType<typeof startPig>> | null = null;
	let consoleRuntime: ConsoleRuntime | null = null;
	try {
		pig = await startPig({ github, workspaceRoot, remoteUrl: bare });

		const consoleOptions = {
			storage: new MemoryStorage(),
			config: consoleConfig(),
			logger: silentLogger(),
			fetch,
			now: () => Date.now(),
			sleep: async () => {},
		};
		consoleRuntime = await createConsoleRuntime(consoleOptions);
		const service = consoleServiceFromRuntime(consoleRuntime);
		const admin = { authorization: "Bearer console-token", "content-type": "application/json" };

		const enrolled = await handleConsoleRequest(
			new Request("https://console.test/api/enrollments", {
				method: "POST",
				headers: admin,
				body: JSON.stringify({ label: "pig" }),
			}),
			{ service, adminToken: "console-token", now: () => Date.now() },
		);
		const enrollment = (await enrolled.json()) as { token: string };

		const registered = await handleConsoleRequest(
			new Request("https://console.test/api/workers", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					enrollmentToken: enrollment.token,
					workerId: "pig-local",
					kind: "pig",
					transport: "inbound",
					baseUrl: pig.baseUrl,
					repos: [FULL_NAME],
					secret: ADMIN_TOKEN,
				}),
			}),
			{ service, adminToken: "console-token", now: () => Date.now() },
		);
		assert.equal(registered.status, 201);
		const registration = (await registered.json()) as {
			worker: { capabilities: { name: string }[] };
		};
		assert.ok(registration.worker.capabilities.some((entry) => entry.name === "pig.work"));

		const submitted = await handleConsoleRequest(
			new Request("https://console.test/api/commands", {
				method: "POST",
				headers: admin,
				body: JSON.stringify({
					workerId: "pig-local",
					capability: "pig.work",
					actor: "alice",
					proposalId: "e2e-1",
					params: {
						repo: FULL_NAME,
						anchor: 5,
						anchorType: "pull_request",
						target: "patch",
						instructions: "Add patch.txt",
					},
				}),
			}),
			{ service, adminToken: "console-token", now: () => Date.now() },
		);
		assert.equal(submitted.status, 202);
		const submittedBody = (await submitted.json()) as {
			dispatch: { dispatchKey: string; state: string; jobId: string };
		};
		assert.equal(submittedBody.dispatch.state, "accepted");
		assert.equal(submittedBody.dispatch.dispatchKey, "console:e2e-1");

		const finished = await waitForTerminalJob(pig.app);
		if (finished.status !== "succeeded") {
			const detail = await pig.app.getJob(finished.id);
			assert.fail(
				`job failed: ${detail?.job.error ?? "unknown"}\nevents: ${(detail?.events ?? []).join(" | ")}`,
			);
		}

		assert.equal(github.pullRequests.length, 1);
		const pullRequestCreated = github.pullRequests[0];
		assert.equal(pullRequestCreated?.base, "feature");
		assert.equal(pullRequestCreated?.draft, true);
		assert.match(pullRequestCreated?.body ?? "", /Patch for #5/);
		assert.match(pullRequestCreated?.head ?? "", /^pig\/5-patch-/);

		const refs = await runGit(["ls-remote", bare], { cwd: root });
		assert.match(refs.stdout, new RegExp(`refs/heads/${pullRequestCreated?.head}`));

		const state = await handleConsoleRequest(
			new Request("https://console.test/api/state?refresh=1", {
				headers: { authorization: "Bearer console-token" },
			}),
			{ service, adminToken: "console-token", now: () => Date.now() },
		);
		assert.equal(state.status, 200);
		const board = (await state.json()) as {
			jobs: { workerId: string; job: { origin: string; status: string } }[];
			dispatches: { state: string; jobId: string }[];
		};
		assert.equal(board.jobs.length, 1);
		assert.equal(board.jobs[0]?.job.origin, "console");
		assert.equal(board.jobs[0]?.job.status, "succeeded");
		assert.equal(board.dispatches[0]?.state, "accepted");

		const resolved = await handleConsoleRequest(
			new Request("https://console.test/api/dispatches/console%3Ae2e-1", {
				headers: { authorization: "Bearer console-token" },
			}),
			{ service, adminToken: "console-token", now: () => Date.now() },
		);
		const resolvedBody = (await resolved.json()) as { dispatch: { jobId: string } };
		assert.equal(resolvedBody.dispatch.jobId, finished.id);

		const statusCommand = await handleConsoleRequest(
			new Request("https://console.test/api/commands", {
				method: "POST",
				headers: admin,
				body: JSON.stringify({
					workerId: "pig-local",
					capability: "pig.status",
					actor: "alice",
					proposalId: "e2e-status",
					params: { repo: FULL_NAME },
				}),
			}),
			{ service, adminToken: "console-token", now: () => Date.now() },
		);
		assert.equal(statusCommand.status, 202);
		const statusBody = (await statusCommand.json()) as { dispatch: { jobId: string } };
		const statusJob = await waitForJobReply(pig.app, statusBody.dispatch.jobId);
		assert.match(statusJob.reply ?? "", /PiG status/);
		assert.equal(statusJob.request.kind, "control");
		assert.equal(statusJob.request.origin, "console");
	} finally {
		await consoleRuntime?.shutdown();
		if (pig) {
			await pig.running.close();
			await pig.app.shutdown();
		}
		rmSync(root, { recursive: true, force: true });
	}
});
