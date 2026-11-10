import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	Harness,
	type ConversationId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppConfig } from "../config.ts";
import { createGitHubClients } from "../github/app.ts";
import { RepoConfigLoader } from "../github/repo-config.ts";
import type { Logger } from "../logger.ts";
import { dispatchCommand } from "../dispatch/admit.ts";
import { admitWebhook } from "./admission.ts";
import {
	countActiveJobs,
	cancelJobsForRepo,
	findJobByCommandKey,
	getJobDetail,
	listJobsForRepo,
} from "./inspect.ts";
import { createJobTask } from "./job-task.ts";
import { createLocalWorkspace } from "./local-workspace.ts";
import { createModelRuntime } from "./models.ts";
import type { PigApp } from "./runtime-types.ts";
import { JOB_TASK_NAME } from "./task-types.ts";
import { ReviewTools, WorkTools } from "./tools.ts";

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
		listJobs: (repo, limit) => listJobsForRepo(harness, JOB_TASK_NAME, repo, limit),
		cancelRepoJobs: (repo, except) =>
			cancelJobsForRepo(harness, JOB_TASK_NAME, repo, except),
		workspaceFactory: (options) => createLocalWorkspace(options),
		toolExtensions: { work: WorkTools, review: ReviewTools },
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
					rootId: root.id as ConversationId,
					appSlug: config.appSlug,
					logger,
					task: jobTask,
				},
				input,
			),
		dispatch: (input) =>
			dispatchCommand({
				app: clients.app,
				input,
				deps: {
					harness,
					rootId: root.id as ConversationId,
					appSlug: config.appSlug,
					logger,
					task: jobTask,
				},
			}),
		listJobs: (repo, limit) => listJobsForRepo(harness, JOB_TASK_NAME, repo, limit),
		getJobByCommandKey: (key) => findJobByCommandKey(harness, JOB_TASK_NAME, key),
		getJob: async (id, repo) => {
			const detail = await getJobDetail(harness, JOB_TASK_NAME, id);
			if (!detail) return null;
			if (repo !== undefined && detail.repo !== repo) return null;
			return detail;
		},
		activeJobs: () => countActiveJobs(harness, JOB_TASK_NAME),
		closed: harness.closed,
		shutdown: () => harness.close(BACKGROUND_CONTEXT),
	};
}
