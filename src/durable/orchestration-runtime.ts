import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	Harness,
	createRegistry,
	type Report,
	type SessionEnd,
	type Storage,
	type Wake,
} from "@earendil-works/pi-durable";
import type { AppConfig } from "../config.ts";
import type { GitHubClients } from "../github/app.ts";
import { RepoConfigLoader } from "../github/repo-config.ts";
import type { JobDetail, JobSummary } from "../jobs/context.ts";
import type { Logger } from "../logger.ts";
import { admissionNotice, admitWebhook, type WebhookInput, type WebhookResult } from "./admission.ts";
import { nextAlarmForTasks } from "./alarm.ts";
import { countActiveJobs, cancelJobsForRepo, getJobDetail, listJobsForRepo } from "./inspect.ts";
import { createNoModels } from "./no-models.ts";
import { createOrchestrationTask } from "./orchestration-task.ts";
import { ORCHESTRATION_TASK_NAME } from "./task-types.ts";

const UNSUPPORTED_CODING_MESSAGE =
	"This PiG deployment runs control and release jobs only. Work and review commands need the Node host or a configured coding execution backend.";

export interface OrchestrationRuntimeOptions {
	storage: Storage;
	config: AppConfig;
	clients: GitHubClients;
	logger: Logger;
	configLoader?: RepoConfigLoader;
	now?: () => number;
	onWake?: (wake: Wake) => void;
	onReport?: (report: Report) => void;
	recoveryMs?: number;
}

export interface OrchestrationRuntime {
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

export async function createOrchestrationRuntime(
	options: OrchestrationRuntimeOptions,
): Promise<OrchestrationRuntime> {
	const { config, logger } = options;
	const registry = createRegistry();
	const models = createNoModels();
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
			settings: { extensions: [] },
			...(options.now ? { now: options.now } : {}),
			...(options.onWake ? { onWake: options.onWake } : {}),
			onReport,
		},
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT);
	const configLoader = options.configLoader ?? new RepoConfigLoader(30, logger);
	const task = createOrchestrationTask({
		config,
		logger,
		clients: options.clients,
		configLoader,
		harness,
		listJobs: (repo, limit) =>
			listJobsForRepo(harness, ORCHESTRATION_TASK_NAME, repo, limit),
		cancelRepoJobs: (repo, except) =>
			cancelJobsForRepo(harness, ORCHESTRATION_TASK_NAME, repo, except),
	});
	registry.install({ name: "pig.orchestration", tasks: [task] });
	harness.resume();

	const runtime: OrchestrationRuntime = {
		config,
		harness,
		admit: (input) =>
			admitWebhook(
				{
					harness,
					rootId: root.id,
					appSlug: config.appSlug,
					logger,
					task,
					filterPlan: (plan) => {
						if (plan.kind !== "admit") return plan;
						const kind = plan.admission.jobKind;
						if (kind === "control" || kind === "release") return plan;
						if (plan.admission.request.kind === "review" && plan.admission.request.auto) {
							return {
								kind: "ignore",
								reason: "coding jobs are not supported on this host",
							};
						}
						return {
							kind: "admit",
							admission: admissionNotice(plan.admission, UNSUPPORTED_CODING_MESSAGE),
						};
					},
				},
				input,
			),
		listJobs: (repo, limit) =>
			listJobsForRepo(harness, ORCHESTRATION_TASK_NAME, repo, limit),
		getJob: async (id, repo) => {
			const detail = await getJobDetail(harness, ORCHESTRATION_TASK_NAME, id);
			if (!detail) return null;
			if (repo !== undefined && detail.repo !== repo) return null;
			return detail;
		},
		activeJobs: () => countActiveJobs(harness, ORCHESTRATION_TASK_NAME),
		nextAlarm: async (now = Date.now()) => {
			const inspection = await harness.inspect(BACKGROUND_CONTEXT);
			return nextAlarmForTasks(
				inspection.tasks,
				now,
				options.recoveryMs ?? 60_000,
			);
		},
		wake: () => harness.wake(),
		resume: () => harness.resume(),
		closed: harness.closed,
		shutdown: () => harness.close(BACKGROUND_CONTEXT),
	};
	return runtime;
}
