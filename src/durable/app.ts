import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	Harness,
	type ConversationId,
	type SessionEnd,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppConfig } from "../config.ts";
import { createGitHubClients } from "../github/app.ts";
import { RepoConfigLoader } from "../github/repo-config.ts";
import type {
	JobDetail,
	JobSummary,
	JobSummaryStatus,
} from "../jobs/context.ts";
import type { JobKind, JobRequest } from "../jobs/types.ts";
import type { Logger } from "../logger.ts";
import { admitWebhook, type WebhookInput, type WebhookResult } from "./admission.ts";
import { JobDoc } from "./docs.ts";
import {
	createJobTask,
	JOB_TASK_NAME,
	type JobTaskCheckpoint,
	type JobTaskInput,
} from "./job-task.ts";
import { createModelRuntime } from "./models.ts";
import { ReviewTools, WorkTools } from "./tools.ts";

export interface PigApp {
	config: AppConfig;
	harness: Harness;
	admit(input: WebhookInput): Promise<WebhookResult>;
	listJobs(repo: string, limit: number): Promise<JobSummary[]>;
	getJob(id: string): Promise<JobDetail | null>;
	activeJobs(): Promise<number>;
	closed: Promise<SessionEnd>;
	shutdown(): Promise<void>;
}

function taskInput(record: TaskRecord<unknown, unknown, unknown>): JobTaskInput {
	return record.input as JobTaskInput;
}

function mapLiveStatus(status: string): JobSummaryStatus {
	switch (status) {
		case "pending":
			return "queued";
		case "running":
			return "running";
		case "waiting":
			return "waiting";
		case "sleeping":
			return "sleeping";
		case "completing":
			return "running";
		default:
			return "queued";
	}
}

function mapTerminalStatus(record: TaskRecord<unknown, unknown, unknown>): JobSummaryStatus {
	if (record.state.status !== "terminal") {
		return mapLiveStatus(record.state.status);
	}
	switch (record.state.outcome.status) {
		case "completed":
			return "succeeded";
		case "aborted":
			return "cancelled";
		case "failed":
		case "faulted":
		case "orphaned":
			return "failed";
	}
}

function taskAttempt(record: TaskRecord<unknown, unknown, unknown>, docAttempt: number | undefined): number {
	if (typeof docAttempt === "number" && docAttempt > 0) return docAttempt;
	if (record.state.status !== "terminal" && record.state.status !== "completing") {
		const checkpoint = record.state.checkpoint as Partial<JobTaskCheckpoint> | undefined;
		if (typeof checkpoint?.attempt === "number") return checkpoint.attempt;
	}
	return 1;
}

function taskSummary(record: TaskRecord<unknown, unknown, unknown>): string {
	if (record.state.status === "terminal" && record.state.outcome.status === "completed") {
		const result = record.state.outcome.result as { summary?: unknown } | undefined;
		if (typeof result?.summary === "string") return result.summary;
	}
	return "";
}

function taskError(record: TaskRecord<unknown, unknown, unknown>): string | null {
	if (
		record.state.status === "terminal" &&
		(record.state.outcome.status === "failed" || record.state.outcome.status === "faulted")
	) {
		return record.state.outcome.error.message;
	}
	return null;
}

function toSummary(
	record: TaskRecord<unknown, unknown, unknown>,
	doc: { summary: string | null; error: string | null; attempt: number } | undefined,
): JobSummary {
	const input = taskInput(record);
	const status =
		record.state.status === "terminal" || record.state.status === "completing"
			? mapTerminalStatus(record)
			: mapLiveStatus(record.state.status);
	return {
		id: String(record.id),
		kind: input.request.kind as JobKind,
		status,
		attempts: taskAttempt(record, doc?.attempt),
		maxAttempts: input.maxAttempts,
		createdAt: input.createdAt,
		summary: doc?.summary ?? taskSummary(record),
		error: doc?.error ?? taskError(record),
	};
}

export async function listJobsForRepo(
	harness: Harness,
	repo: string,
	limit: number,
): Promise<JobSummary[]> {
	const page = await harness.commit(
		(tx) => tx.scanTasks({ kind: JOB_TASK_NAME, order: "descending" }, 300),
		BACKGROUND_CONTEXT,
	);
	const jobs: JobSummary[] = [];
	for (const record of page.items) {
		const input = taskInput(record);
		if (input.repo !== repo) continue;
		const doc = await harness.snapshot(JobDoc, String(record.id), BACKGROUND_CONTEXT);
		jobs.push(toSummary(record, doc));
		if (jobs.length >= limit) break;
	}
	return jobs;
}

export async function getJobDetail(
	harness: Harness,
	id: string,
): Promise<JobDetail | null> {
	const taskId = Number(id);
	if (!Number.isInteger(taskId) || taskId <= 0) return null;
	const record = await harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT);
	if (!record || record.kind !== JOB_TASK_NAME) return null;
	const input = taskInput(record);
	const doc = await harness.snapshot(JobDoc, String(record.id), BACKGROUND_CONTEXT);
	const summary = toSummary(record, doc);
	return {
		job: summary,
		repo: input.repo,
		request: input.request as JobRequest,
		events: doc?.events ?? [],
		progressCommentId: doc?.progressCommentId ?? null,
	};
}

export async function cancelJobsForRepo(
	harness: Harness,
	repo: string,
	exceptTaskId: TaskId,
): Promise<{ cancelled: number; running: number }> {
	const inspection = await harness.inspect(BACKGROUND_CONTEXT);
	let cancelled = 0;
	let running = 0;
	for (const item of inspection.tasks) {
		const record = item.record;
		if (record.kind !== JOB_TASK_NAME) continue;
		const input = taskInput(record);
		if (input.repo !== repo || record.id === exceptTaskId) continue;
		if (record.state.status === "terminal" || record.state.status === "completing") {
			continue;
		}
		const wasRunning = record.state.status === "running";
		const result = await harness.abortTask(record.id, BACKGROUND_CONTEXT);
		if (result === "marked") {
			cancelled += 1;
			if (wasRunning) running += 1;
		}
	}
	return { cancelled, running };
}

export async function openPigApp(config: AppConfig, logger: Logger): Promise<PigApp> {
	const clients = createGitHubClients(config, logger);
	const configLoader = new RepoConfigLoader(30, logger);
	const models = createModelRuntime();
	const storage = await openNodeSqliteStorage(
		config.databasePath,
		config.tablePrefix === "" ? {} : { prefix: config.tablePrefix },
	);
	const registry = createRegistry();
	registry.install(WorkTools);
	registry.install(ReviewTools);

	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: {
				extensions: [],
				toolExecution: "sequential",
				stream: { timeoutMs: Math.min(config.jobTimeoutMs, 15 * 60_000) },
				retry: { maxRetries: 2 },
				restartLimit: 5,
			},
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workspaceRoot }),
			now: () => Date.now(),
			onReport: (report) => {
				logger.error("Pi-durable report", {
					kind: report.kind,
					reason: "reason" in report ? report.reason : undefined,
					task: "task" in report ? report.task?.id : undefined,
					extension: "extension" in report ? report.extension : undefined,
					error: report.error,
				});
			},
		},
		BACKGROUND_CONTEXT,
	);

	const root = await harness.root(BACKGROUND_CONTEXT);
	const jobTask = createJobTask({
		config,
		logger,
		clients,
		configLoader,
		models,
		harness,
		listJobs: (repo, limit) => listJobsForRepo(harness, repo, limit),
		cancelRepoJobs: (repo, except) => cancelJobsForRepo(harness, repo, except),
	});
	registry.install({ name: "pig.jobs", tasks: [jobTask] });
	harness.resume();

	const app: PigApp = {
		config,
		harness,
		admit: (input) =>
			admitWebhook(
				{
					harness,
					rootId: root.id as ConversationId,
					appSlug: config.appSlug,
					logger,
					task: jobTask,
				},
				input,
			),
		listJobs: (repo, limit) => listJobsForRepo(harness, repo, limit),
		getJob: (id) => getJobDetail(harness, id),
		activeJobs: async () => {
			const inspection = await harness.inspect(BACKGROUND_CONTEXT);
			return inspection.tasks.filter((item) => item.record.kind === JOB_TASK_NAME).length;
		},
		closed: harness.closed,
		shutdown: () => harness.close(BACKGROUND_CONTEXT),
	};
	return app;
}
