import type { Octokit } from "@octokit/rest";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	defineTask,
	type Harness,
	type RunningTask,
	type Task,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { AppConfig } from "../config.ts";
import type { GitHubClients } from "../github/app.ts";
import { fetchRepository, splitRepository, type RepositoryInfo } from "../github/repo.ts";
import type { RepoConfigLoader } from "../github/repo-config.ts";
import type { OrchestrationContext, JobOutcome, JobSummary } from "../jobs/context.ts";
import { PermanentJobError, toJobError, truncateError } from "../jobs/errors.ts";
import { runControlJob } from "../jobs/handlers/control.ts";
import { runReleaseJob } from "../jobs/handlers/release.ts";
import type { JobRequest } from "../jobs/types.ts";
import type { Logger } from "../logger.ts";
import type { RepoConfig } from "../repo-config.ts";
import { assertAuthorized } from "./authorization.ts";
import { JobDoc, appendEvent } from "./docs.ts";
import {
	ackText,
	backoffForAttempt,
	safeUpdateProgress,
	shouldAck,
	shouldReportFailure,
} from "./failure.ts";
import { jobKey, readJobDoc } from "./job-docs.ts";
import { ProgressComment } from "./progress.ts";
import {
	ORCHESTRATION_TASK_NAME,
	type JobTaskCheckpoint,
	type JobTaskInput,
	type JobTaskResult,
} from "./task-types.ts";

export interface OrchestrationTaskDeps {
	config: AppConfig;
	logger: Logger;
	clients: GitHubClients;
	configLoader: RepoConfigLoader;
	harness: Harness;
	listJobs(repo: string, limit: number): Promise<JobSummary[]>;
	cancelRepoJobs(repo: string, exceptTaskId: TaskId): Promise<{ cancelled: number; running: number }>;
}

export type OrchestrationTaskDefinition = Task<
	JobTaskInput,
	JobTaskCheckpoint,
	JobTaskResult,
	object
>;

interface PreparedJob {
	octokit: Octokit;
	repoInfo: RepositoryInfo;
	repoConfig: RepoConfig;
}

function createProgress(
	deps: OrchestrationTaskDeps,
	task: RunningTask<JobTaskInput, JobTaskCheckpoint, JobTaskResult>,
	runtime: TaskRuntime<JobTaskInput, JobTaskCheckpoint, JobTaskResult, object>,
	context: Context,
	progressCommentId: number | null,
): ProgressComment {
	const { owner, name } = splitRepository(task.input.repo);
	return new ProgressComment({
		octokit: deps.clients.installation(task.input.installationId),
		repoInfo: { owner, name },
		issueNumber: task.input.request.source.number,
		initialId: progressCommentId,
		logger: deps.logger,
		onCreated: async (id) => {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(JobDoc, jobKey(task.id), null);
				doc.progressCommentId = id;
				doc.updatedAt = runtime.now();
				return undefined;
			}, context);
		},
	});
}

async function prepareJob(
	deps: OrchestrationTaskDeps,
	task: RunningTask<JobTaskInput, JobTaskCheckpoint, JobTaskResult>,
	progress: ProgressComment,
): Promise<PreparedJob> {
	const input = task.input;
	const octokit = deps.clients.installation(input.installationId);
	const repoInfo = await fetchRepository(octokit, input.repo);
	if (repoInfo.archived) {
		throw new PermanentJobError("This repository is archived.");
	}
	const repoConfig = await deps.configLoader.get(octokit, repoInfo);
	if (!(input.request.kind === "review" && input.request.auto)) {
		await assertAuthorized(octokit, repoInfo, input.request.actor, repoConfig, deps.logger);
	}
	if (shouldAck(input.request)) {
		await progress.update(ackText(input.request));
	}
	return { octokit, repoInfo, repoConfig };
}

function buildContext(
	deps: OrchestrationTaskDeps,
	task: RunningTask<JobTaskInput, JobTaskCheckpoint, JobTaskResult>,
	runtime: TaskRuntime<JobTaskInput, JobTaskCheckpoint, JobTaskResult, object>,
	context: Context,
	prepared: PreparedJob,
	progress: ProgressComment,
	jobDoc: Awaited<ReturnType<typeof readJobDoc>>,
): OrchestrationContext {
	const input = task.input;
	const state = task.state.checkpoint;
	const jobContext: OrchestrationContext = {
		job: {
			id: jobKey(task.id),
			installationId: input.installationId,
			repo: input.repo,
			kind: input.request.kind,
			attempts: state.attempt,
			maxAttempts: input.maxAttempts,
			createdAt: input.createdAt,
		},
		request: input.request,
		repoInfo: prepared.repoInfo,
		config: prepared.repoConfig,
		octokit: prepared.octokit,
		appSlug: deps.config.appSlug,
		appId: deps.config.appId,
		logger: deps.logger,
		signal: runtime.signal,
		checkpoint: jobDoc.checkpoint,
		async setCheckpoint(value) {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(JobDoc, jobKey(task.id), null);
				doc.checkpoint = value as JsonValue;
				doc.updatedAt = runtime.now();
				return undefined;
			}, context);
			jobContext.checkpoint = value;
		},
		updateProgress: (text) => progress.update(text),
		cancelRepositoryJobs: () => deps.cancelRepoJobs(input.repo, task.id),
		listJobs: (limit) => deps.listJobs(input.repo, limit),
		addEvent: async (level, message) => {
			if (level === "debug") {
				deps.logger.debug(message);
				return;
			}
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(JobDoc, jobKey(task.id), null);
				doc.events = appendEvent(doc.events, message);
				doc.updatedAt = runtime.now();
				return undefined;
			}, context);
		},
		now: () => runtime.now(),
	};
	return jobContext;
}

function runHandler(request: JobRequest, context: OrchestrationContext): Promise<JobOutcome> {
	switch (request.kind) {
		case "control":
			return runControlJob(context);
		case "release":
			return runReleaseJob(context);
		default:
			return Promise.reject(new Error("This host does not run coding jobs."));
	}
}

async function handleFailure(
	deps: OrchestrationTaskDeps,
	task: RunningTask<JobTaskInput, JobTaskCheckpoint, JobTaskResult>,
	runtime: TaskRuntime<JobTaskInput, JobTaskCheckpoint, JobTaskResult, object>,
	context: Context,
	error: unknown,
	progress: ProgressComment | null,
): Promise<void> {
	const state = task.state.checkpoint;
	const input = task.input;
	const jobError = toJobError(error);
	deps.logger.warn("Orchestration attempt failed", {
		jobId: jobKey(task.id),
		repo: input.repo,
		attempt: state.attempt,
		error: jobError.message,
		retryable: jobError.retryable,
	});
	const message = truncateError(jobError.message, 2000);

	if (jobError.retryable && state.attempt < input.maxAttempts) {
		const nextAttempt = state.attempt + 1;
		const until = runtime.now() + backoffForAttempt(state.attempt);
		await safeUpdateProgress(
			progress,
			input.request,
			() => `PiG hit a temporary problem and will retry (attempt ${nextAttempt}/${input.maxAttempts}).`,
			deps.logger,
		);
		await runtime.commit(async (tx) => {
			const doc = await tx.doc(JobDoc, jobKey(task.id), null);
			doc.status = "queued";
			doc.attempt = nextAttempt;
			doc.error = message;
			doc.updatedAt = runtime.now();
			return {
				status: "sleeping",
				until,
				checkpoint: { phase: "run", previousTaskId: null, attempt: nextAttempt },
			};
		}, context);
		return;
	}

	await safeUpdateProgress(
		progress,
		input.request,
		() => `PiG could not complete this request: ${message}`,
		deps.logger,
	);
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(JobDoc, jobKey(task.id), null);
		doc.status = "failed";
		doc.error = message;
		doc.updatedAt = runtime.now();
		return { status: "terminal", outcome: { status: "failed", error: { message } } };
	}, context);
}

async function runPhase(
	deps: OrchestrationTaskDeps,
	task: RunningTask<JobTaskInput, JobTaskCheckpoint, JobTaskResult>,
	runtime: TaskRuntime<JobTaskInput, JobTaskCheckpoint, JobTaskResult, object>,
	context: Context,
): Promise<void> {
	const state = task.state.checkpoint;
	if (state.previousTaskId !== null) {
		const previous = await runtime.getTask(state.previousTaskId as TaskId, context);
		if (previous && previous.state.status !== "terminal") {
			await runtime.commit(
				() => ({
					status: "waiting",
					on: [state.previousTaskId as TaskId],
					policy: "allSettled",
					checkpoint: { ...state, previousTaskId: null },
				}),
				context,
			);
			return;
		}
	}

	await runtime.commit(async (tx) => {
		const doc = await tx.doc(JobDoc, jobKey(task.id), null);
		doc.status = "running";
		doc.attempt = state.attempt;
		doc.updatedAt = runtime.now();
		return undefined;
	}, context);

	const jobDoc = await readJobDoc(deps.harness, task.id, context);
	const progress = createProgress(deps, task, runtime, context, jobDoc.progressCommentId);
	let prepared: PreparedJob | null = null;
	try {
		prepared = await prepareJob(deps, task, progress);
		const jobContext = buildContext(deps, task, runtime, context, prepared, progress, jobDoc);
		const outcome = await runHandler(task.input.request, jobContext);
		if (runtime.signal.aborted) return;
		if (outcome.comment !== null) {
			await progress.update(outcome.comment);
		}
		const result: JobTaskResult = {
			summary: outcome.summary,
			result: outcome.result as Record<string, JsonValue>,
		};
		await runtime.commit(async (tx) => {
			const doc = await tx.doc(JobDoc, jobKey(task.id), null);
			doc.status = "succeeded";
			doc.summary = outcome.summary;
			doc.error = null;
			doc.updatedAt = runtime.now();
			return { status: "terminal", outcome: { status: "completed", result } };
		}, context);
		deps.logger.info("Orchestration job succeeded", {
			jobId: jobKey(task.id),
			repo: task.input.repo,
			summary: outcome.summary,
		});
	} catch (error) {
		if (runtime.signal.aborted) return;
		try {
			await handleFailure(deps, task, runtime, context, error, progress);
		} catch (failureError) {
			deps.logger.error("Could not record the orchestration failure", { error: failureError });
		}
	}
}

async function abortPhase(
	deps: OrchestrationTaskDeps,
	task: RunningTask<JobTaskInput, JobTaskCheckpoint, JobTaskResult>,
	runtime: TaskRuntime<JobTaskInput, JobTaskCheckpoint, JobTaskResult, object>,
	context: Context,
): Promise<void> {
	const input = task.input;
	const jobDoc = await readJobDoc(deps.harness, task.id, context);
	try {
		const progress = createProgress(deps, task, runtime, context, jobDoc.progressCommentId);
		if (shouldReportFailure(input.request)) {
			await progress.update("PiG cancelled this job.");
		}
	} catch (error) {
		deps.logger.warn("Could not post the cancellation comment", { error });
	}
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(JobDoc, jobKey(task.id), null);
		doc.status = "cancelled";
		doc.error = "Cancelled by request";
		doc.updatedAt = runtime.now();
		return { status: "terminal", outcome: { status: "aborted", reason: "cancelled" } };
	}, context);
	deps.logger.info("Orchestration job cancelled", { jobId: jobKey(task.id), repo: input.repo });
}

export function createOrchestrationTask(
	deps: OrchestrationTaskDeps,
): OrchestrationTaskDefinition {
	return defineTask<JobTaskInput, JobTaskCheckpoint, JobTaskResult>({
		name: ORCHESTRATION_TASK_NAME,
		version: 1,
		initial: (input) => ({
			phase: "run",
			previousTaskId: input.previousTaskId,
			attempt: 1,
		}),
		phases: {
			run: (task, runtime, context) => runPhase(deps, task, runtime, context),
		},
		abort: (task, runtime, context) => abortPhase(deps, task, runtime, context),
	});
}
