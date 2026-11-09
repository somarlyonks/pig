import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	Harness,
	createRegistry,
	type Report,
	type SessionEnd,
	type Storage,
	type Wake,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import type { AppConfig } from "../config.ts";
import type { GitHubClients } from "../github/app.ts";
import { RepoConfigLoader } from "../github/repo-config.ts";
import type { JobDetail, JobSummary } from "../jobs/context.ts";
import type { Logger } from "../logger.ts";
import { admitWebhook, type WebhookInput, type WebhookResult } from "./admission.ts";
import { nextAlarmForTasks } from "./alarm.ts";
import { countActiveJobs, cancelJobsForRepo, getJobDetail, listJobsForRepo } from "./inspect.ts";
import { createJobTask } from "./job-task.ts";
import type { RemoteRunnerClient } from "./remote-runner.ts";
import { createRemoteReviewTools, createRemoteWorkTools } from "./remote-tools.ts";
import { RemoteJobWorkspace } from "./remote-workspace.ts";
import { JOB_TASK_NAME } from "./task-types.ts";

export interface CloudflareCodingRuntimeOptions {
	storage: Storage;
	config: AppConfig;
	clients: GitHubClients;
	logger: Logger;
	runner: RemoteRunnerClient;
	remoteUrlForRepo?: (repo: string) => string;
	configLoader?: RepoConfigLoader;
	now?: () => number;
	onWake?: (wake: Wake) => void;
	onReport?: (report: Report) => void;
	recoveryMs?: number;
}

export interface CloudflareCodingRuntime {
	config: AppConfig;
	harness: Harness;
	admit(input: WebhookInput): Promise<WebhookResult>;
	listJobs(repo: string, limit: number): Promise<JobSummary[]>;
	getJob(id: string, repo?: string): Promise<JobDetail | null>;
	activeJobs(): Promise<number>;
	nextAlarm(now?: number): Promise<number | undefined>;
	wake(): Wake;
	resume(): void;
	closed: Promise<SessionEnd>;
	shutdown(): Promise<void>;
}

export async function createCloudflareCodingRuntime(
	options: CloudflareCodingRuntimeOptions,
): Promise<CloudflareCodingRuntime> {
	const { config, logger } = options;
	const registry = createRegistry();
	const models = createModels();
	const remoteUrlForRepo =
		options.remoteUrlForRepo ?? ((repo: string) => `https://github.com/${repo}.git`);
	const workTools = createRemoteWorkTools(options.runner);
	const reviewTools = createRemoteReviewTools(options.runner);
	registry.install(workTools);
	registry.install(reviewTools);
	const onReport =
		options.onReport ??
		((report: Report) => {
			logger.error("Pi-durable report", {
				kind: report.kind,
				error: report.error,
			});
		});
	const harness = await Harness.open(
		options.storage,
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
			...(options.now ? { now: options.now } : {}),
			...(options.onWake ? { onWake: options.onWake } : {}),
			onReport,
		},
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT);
	const configLoader = options.configLoader ?? new RepoConfigLoader(30, logger);
	const jobTask = createJobTask({
		config,
		logger,
		clients: options.clients,
		configLoader,
		models,
		harness,
		listJobs: (repo, limit) => listJobsForRepo(harness, JOB_TASK_NAME, repo, limit),
		cancelRepoJobs: (repo, except) =>
			cancelJobsForRepo(harness, JOB_TASK_NAME, repo, except),
		workspaceFactory: (workspaceOptions) =>
			new RemoteJobWorkspace({
				...workspaceOptions,
				client: options.runner,
				remoteUrl: remoteUrlForRepo(workspaceOptions.input.repo),
			}),
		toolExtensions: { work: workTools, review: reviewTools },
	});
	registry.install({ name: "pig.jobs", tasks: [jobTask] });
	harness.resume();

	return {
		config,
		harness,
		admit: (input) =>
			admitWebhook(
				{
					harness,
					rootId: root.id,
					appSlug: config.appSlug,
					logger,
					task: jobTask,
				},
				input,
			),
		listJobs: (repo, limit) => listJobsForRepo(harness, JOB_TASK_NAME, repo, limit),
		getJob: async (id, repo) => {
			const detail = await getJobDetail(harness, JOB_TASK_NAME, id);
			if (!detail) return null;
			if (repo !== undefined && detail.repo !== repo) return null;
			return detail;
		},
		activeJobs: () => countActiveJobs(harness, JOB_TASK_NAME),
		nextAlarm: async (now = Date.now()) => {
			const inspection = await harness.inspect(BACKGROUND_CONTEXT);
			return nextAlarmForTasks(inspection.tasks, now, options.recoveryMs ?? 60_000);
		},
		wake: () => harness.wake(),
		resume: () => harness.resume(),
		closed: harness.closed,
		shutdown: () => harness.close(BACKGROUND_CONTEXT),
	};
}
