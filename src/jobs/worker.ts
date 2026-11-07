import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import type { AgentRunner } from "../agent/runner.ts";
import type { AppConfig } from "../config.ts";
import type { GitHubClients } from "../github/app.ts";
import { fetchRepository, type RepositoryInfo } from "../github/repo.ts";
import type { RepoConfigLoader } from "../github/repo-config.ts";
import { createWorkspace, removeWorkspace } from "../git.ts";
import type { Logger } from "../logger.ts";
import type { RepoConfig } from "../repo-config.ts";
import type { AgentSettings, JobContext, JobOutcome } from "./context.ts";
import { PermanentJobError, toJobError, TransientJobError, truncateError } from "./errors.ts";
import { runControlJob } from "./handlers/control.ts";
import { runReleaseJob } from "./handlers/release.ts";
import { runReviewJob } from "./handlers/review.ts";
import { runWorkJob } from "./handlers/work.ts";
import type { JobRequest, JobRow } from "./types.ts";
import type { JobStore } from "./store.ts";

const POLL_INTERVAL_MS = 500;
const RECOVERY_INTERVAL_MS = 60_000;
const CANCEL_POLL_INTERVAL_MS = 3_000;
const STOP_TIMEOUT_MS = 20_000;

interface ExecutionState {
	stopping: boolean;
	lostLease: boolean;
	cancelRequested: boolean;
}

interface ActiveJob {
	controller: AbortController;
	state: ExecutionState;
	promise: Promise<void>;
}

interface PermissionCacheEntry {
	allowed: boolean;
	expiresAt: number;
}

export interface WorkerOptions {
	config: AppConfig;
	store: JobStore;
	clients: GitHubClients;
	configLoader: RepoConfigLoader;
	agentRunner: AgentRunner;
	logger: Logger;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseJobRequest(job: JobRow): JobRequest | null {
	const record = asRecord(job.request);
	if (!record) return null;
	if (record.kind !== job.kind) return null;
	if (typeof record.actor !== "string") return null;
	const source = asRecord(record.source);
	if (!source || typeof source.type !== "string" || typeof source.number !== "number") return null;
	return job.request as JobRequest;
}

function shouldAck(request: JobRequest): boolean {
	if (request.kind === "control") return false;
	if (request.kind === "review" && request.auto) return false;
	return true;
}

function shouldReportFailure(request: JobRequest): boolean {
	return !(request.kind === "review" && request.auto);
}

function ackText(request: JobRequest, job: JobRow): string {
	const retry = job.attempts > 1 ? ` Retrying (attempt ${job.attempts}/${job.maxAttempts}).` : "";
	switch (request.kind) {
		case "work":
			return `PiG is working on this request.${retry}`;
		case "review":
			return `PiG is reviewing this pull request.${retry}`;
		case "release":
			return `PiG is preparing the release.${retry}`;
		case "control":
			return "";
	}
}

function truncateComment(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > 60_000 ? `${trimmed.slice(0, 59_999)}…` : trimmed;
}

function backoffForAttempt(attempt: number): number {
	return Math.min(120_000, 15_000 * 2 ** Math.max(0, attempt - 1));
}

class ProgressComment {
	private id: number | null;
	private readonly octokit: Octokit;
	private readonly repoInfo: RepositoryInfo;
	private readonly issueNumber: number;
	private readonly store: JobStore;
	private readonly jobId: string;
	private readonly logger: Logger;

	constructor(options: {
		octokit: Octokit;
		repoInfo: RepositoryInfo;
		issueNumber: number;
		store: JobStore;
		jobId: string;
		initialId: number | null;
		logger: Logger;
	}) {
		this.octokit = options.octokit;
		this.repoInfo = options.repoInfo;
		this.issueNumber = options.issueNumber;
		this.store = options.store;
		this.jobId = options.jobId;
		this.id = options.initialId;
		this.logger = options.logger;
	}

	async update(body: string): Promise<void> {
		const text = truncateComment(body);
		if (this.id === null) {
			await this.create(text);
			return;
		}
		try {
			await this.octokit.issues.updateComment({
				owner: this.repoInfo.owner,
				repo: this.repoInfo.name,
				comment_id: this.id,
				body: text,
			});
		} catch (error) {
			if ((error as { status?: number }).status === 404) {
				this.id = null;
				await this.create(text);
				return;
			}
			this.logger.warn("Could not update progress comment", { error });
		}
	}

	private async create(text: string): Promise<void> {
		try {
			const { data } = await this.octokit.issues.createComment({
				owner: this.repoInfo.owner,
				repo: this.repoInfo.name,
				issue_number: this.issueNumber,
				body: text,
			});
			this.id = data.id;
			this.store.setProgressComment(this.jobId, data.id);
		} catch (error) {
			this.logger.warn("Could not create progress comment", { error });
		}
	}
}

export class JobWorker {
	private readonly ownerId: string;
	private readonly active = new Map<string, ActiveJob>();
	private readonly permissionCache = new Map<string, PermissionCacheEntry>();
	private readonly tokenCache = new Map<number, { token: string; expiresAt: number }>();
	private readonly options: WorkerOptions;
	private pollTimer: NodeJS.Timeout | null = null;
	private recoveryTimer: NodeJS.Timeout | null = null;
	private stopping = false;

	constructor(options: WorkerOptions) {
		this.options = options;
		this.ownerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
	}

	start(): void {
		const recovered = this.options.store.recoverExpiredLeases(Date.now());
		if (recovered.requeued > 0 || recovered.failed > 0) {
			this.options.logger.info("Recovered interrupted jobs", recovered);
		}
		this.pollTimer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
		this.recoveryTimer = setInterval(() => {
			const result = this.options.store.recoverExpiredLeases(Date.now());
			if (result.requeued > 0 || result.failed > 0) {
				this.options.logger.info("Recovered expired job leases", result);
			}
		}, RECOVERY_INTERVAL_MS);
		this.tick();
	}

	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.recoveryTimer) clearInterval(this.recoveryTimer);
		const promises: Promise<void>[] = [];
		for (const active of this.active.values()) {
			active.state.stopping = true;
			active.controller.abort();
			promises.push(active.promise);
		}
		if (promises.length > 0) {
			await Promise.race([
				Promise.allSettled(promises).then(() => undefined),
				new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
			]);
		}
		if (this.active.size > 0) {
			this.options.logger.warn("Stopped with jobs still active", {
				active: this.active.size,
			});
		}
	}

	private tick(): void {
		if (this.stopping) return;
		try {
			while (true) {
				const onlyControl = this.active.size >= this.options.config.maxConcurrency;
				if (onlyControl && this.active.size >= this.options.config.maxConcurrency + 2) {
					break;
				}
				const job = this.options.store.claimNext(
					this.ownerId,
					Date.now(),
					this.options.config.leaseMs,
					{ onlyControl },
				);
				if (!job) break;
				this.startJob(job);
			}
		} catch (error) {
			this.options.logger.error("Could not claim jobs", { error });
		}
	}

	private startJob(job: JobRow): void {
		const controller = new AbortController();
		const state: ExecutionState = {
			stopping: false,
			lostLease: false,
			cancelRequested: false,
		};
		const promise = this.executeJob(job, controller, state).finally(() => {
			this.active.delete(job.id);
			if (!this.stopping) this.tick();
		});
		this.active.set(job.id, { controller, state, promise });
	}

	private async executeJob(
		job: JobRow,
		controller: AbortController,
		state: ExecutionState,
	): Promise<void> {
		const logger = this.options.logger.child({
			jobId: job.id,
			repo: job.repo,
			kind: job.kind,
			attempt: job.attempts,
		});
		let request: JobRequest | null = null;
		let octokit: Octokit | null = null;
		let repoInfo: RepositoryInfo | null = null;
		let progress: ProgressComment | null = null;
		let workspaceDir: string | null = null;
		let heartbeatTimer: NodeJS.Timeout | null = null;
		let cancelTimer: NodeJS.Timeout | null = null;

		try {
			request = parseJobRequest(job);
			if (!request) {
				throw new PermanentJobError("The stored job request is malformed.");
			}

			heartbeatTimer = setInterval(() => {
				if (!this.options.store.heartbeat(job.id, this.ownerId, Date.now(), this.options.config.leaseMs)) {
					state.lostLease = true;
					logger.warn("Lost the job lease; aborting this attempt");
					controller.abort();
				}
			}, this.options.config.heartbeatMs);
			cancelTimer = setInterval(() => {
				if (this.options.store.isCancelRequested(job.id)) {
					state.cancelRequested = true;
					logger.info("Cancellation requested; aborting this job");
					controller.abort();
				}
			}, CANCEL_POLL_INTERVAL_MS);

			octokit = this.options.clients.installation(job.installationId);
			repoInfo = await fetchRepository(octokit, job.repo);
			if (repoInfo.archived) {
				throw new PermanentJobError("This repository is archived.");
			}
			const repoConfig = await this.options.configLoader.get(octokit, repoInfo);
			if (!(request.kind === "review" && request.auto)) {
				await this.assertAuthorized(octokit, repoInfo, request.actor, repoConfig, logger);
			}

			progress = new ProgressComment({
				octokit,
				repoInfo,
				issueNumber: request.source.number,
				store: this.options.store,
				jobId: job.id,
				initialId: job.progressCommentId,
				logger,
			});
			if (shouldAck(request)) {
				await progress.update(ackText(request, job));
			}

			workspaceDir = createWorkspace(this.options.config.workspaceRoot, job.id);
			const settings: AgentSettings = {
				model: repoConfig.agent.model ?? this.options.config.model ?? null,
				thinking: repoConfig.agent.thinking ?? this.options.config.thinking ?? null,
				timeoutMs: Math.min(
					repoConfig.agent.timeoutMinutes * 60_000,
					this.options.config.jobTimeoutMs,
				),
			};
			const context: JobContext = {
				job,
				request,
				store: this.options.store,
				repoInfo,
				config: repoConfig,
				octokit,
				appSlug: this.options.config.appSlug,
				appId: this.options.config.appId,
				logger,
				signal: controller.signal,
				workspaceRoot: this.options.config.workspaceRoot,
				workspaceDir,
				agent: this.options.agentRunner,
				settings,
				checkpoint: job.checkpoint,
				setCheckpoint: (value) => {
					if (!this.options.store.setCheckpoint(job.id, this.ownerId, value)) {
						state.lostLease = true;
						controller.abort();
						throw new Error("Lost the job lease while saving a checkpoint.");
					}
					context.checkpoint = value;
				},
				getGitToken: () => this.getInstallationToken(job.installationId),
				cancelRepositoryJobs: () =>
					this.options.store.requestCancel(job.repo, Date.now(), job.id),
				addEvent: (level, message) =>
					this.options.store.appendEvent(job.id, level, message.slice(0, 2000)),
				now: () => Date.now(),
			};

			const outcome = await this.runHandler(request, context);

			if (state.stopping) {
				this.requeueForShutdown(job, logger);
				return;
			}
			if (state.lostLease) {
				logger.warn("Not finalizing a job whose lease was lost");
				return;
			}
			if (state.cancelRequested || this.options.store.isCancelRequested(job.id)) {
				await this.finishCancelled(job, progress, request, logger);
				return;
			}

			const finished = this.options.store.finish(job.id, this.ownerId, "succeeded", {
				result: { summary: outcome.summary, ...outcome.result },
			});
			if (!finished) {
				logger.warn("Could not mark job as succeeded; lease was lost");
				return;
			}
			logger.info("Job succeeded", { summary: outcome.summary });
			if (outcome.comment !== null) {
				await progress.update(outcome.comment);
			}
		} catch (error) {
			try {
				await this.handleFailure(job, request, progress, repoInfo, octokit, state, error, logger);
			} catch (nestedError) {
				logger.error("Could not record job failure", { error: nestedError });
				this.forceFinalize(job, state, error, logger);
			}
		} finally {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (cancelTimer) clearInterval(cancelTimer);
			if (workspaceDir) {
				removeWorkspace(workspaceDir);
			}
		}
	}

	private runHandler(request: JobRequest, context: JobContext): Promise<JobOutcome> {
		switch (request.kind) {
			case "control":
				return runControlJob(context);
			case "review":
				return runReviewJob(context);
			case "work":
				return runWorkJob(context);
			case "release":
				return runReleaseJob(context);
		}
	}

	private async handleFailure(
		job: JobRow,
		request: JobRequest | null,
		progress: ProgressComment | null,
		repoInfo: RepositoryInfo | null,
		octokit: Octokit | null,
		state: ExecutionState,
		error: unknown,
		logger: Logger,
	): Promise<void> {
		if (state.lostLease) {
			logger.warn("Not recording failure for a job whose lease was lost");
			return;
		}
		if (state.stopping) {
			this.requeueForShutdown(job, logger);
			return;
		}
		if (state.cancelRequested || this.options.store.isCancelRequested(job.id)) {
			await this.finishCancelled(job, progress, request, logger);
			return;
		}

		const jobError = toJobError(error);
		logger.warn("Job attempt failed", { error: jobError.message, retryable: jobError.retryable });

		if (jobError.retryable && job.attempts < job.maxAttempts) {
			const availableAt = Date.now() + backoffForAttempt(job.attempts);
			const requeued = this.options.store.requeue(job.id, this.ownerId, {
				availableAt,
				error: truncateError(jobError.message, 2000),
			});
			if (!requeued) {
				logger.warn("Could not requeue job; lease was lost");
				return;
			}
			logger.info("Job requeued for retry", {
				availableAt,
				nextAttempt: job.attempts + 1,
			});
			await this.safeUpdateProgress(progress, request, () =>
				`PiG hit a temporary problem and will retry (attempt ${job.attempts + 1}/${job.maxAttempts}).`,
			);
			return;
		}

		const message = truncateError(jobError.message, 2000);
		const finished = this.options.store.finish(job.id, this.ownerId, "failed", {
			error: message,
		});
		if (!finished) {
			logger.warn("Could not mark job as failed; lease was lost");
			return;
		}
		logger.error("Job failed", { error: message });

		if (!request || !shouldReportFailure(request)) {
			return;
		}
		if (!progress && repoInfo && octokit) {
			progress = new ProgressComment({
				octokit,
				repoInfo,
				issueNumber: request.source.number,
				store: this.options.store,
				jobId: job.id,
				initialId: job.progressCommentId,
				logger,
			});
		}
		await this.safeUpdateProgress(progress, request, () =>
			`PiG could not complete this request: ${message}`,
		);
	}

	private async finishCancelled(
		job: JobRow,
		progress: ProgressComment | null,
		request: JobRequest | null,
		logger: Logger,
	): Promise<void> {
		const cancelled = this.options.store.markCancelled(job.id, this.ownerId, "Cancelled by request");
		if (!cancelled) {
			logger.warn("Could not mark job as cancelled; lease was lost");
			return;
		}
		logger.info("Job cancelled");
		await this.safeUpdateProgress(progress, request, () => "PiG cancelled this job.");
	}

	private forceFinalize(
		job: JobRow,
		state: ExecutionState,
		error: unknown,
		logger: Logger,
	): void {
		if (state.lostLease) return;
		if (state.stopping) {
			this.requeueForShutdown(job, logger);
			return;
		}
		try {
			const message = truncateError(toJobError(error).message, 2000);
			const status = state.cancelRequested ? "cancelled" : "failed";
			if (this.options.store.finish(job.id, this.ownerId, status, { error: message })) {
				logger.error("Job finalized after a secondary failure", { status, error: message });
			}
		} catch (finalizeError) {
			logger.error("Could not finalize job; the lease will expire", { error: finalizeError });
		}
	}

	private async safeUpdateProgress(
		progress: ProgressComment | null,
		request: JobRequest | null,
		render: () => string,
	): Promise<void> {
		if (!progress || !request || !shouldReportFailure(request)) {
			return;
		}
		try {
			await progress.update(render());
		} catch (error) {
			this.options.logger.warn("Could not update the progress comment", { error });
		}
	}

	private requeueForShutdown(job: JobRow, logger: Logger): void {
		const requeued = this.options.store.requeue(job.id, this.ownerId, {
			availableAt: Date.now(),
			refundAttempt: true,
		});
		if (requeued) {
			logger.info("Job requeued for shutdown");
		} else {
			logger.warn("Could not requeue job during shutdown");
		}
	}

	private async getInstallationToken(installationId: number): Promise<string> {
		const cached = this.tokenCache.get(installationId);
		if (cached && cached.expiresAt > Date.now() + 5 * 60_000) {
			return cached.token;
		}
		const response = await this.options.clients.app.request(
			"POST /app/installations/{installation_id}/access_tokens",
			{ installation_id: installationId },
		);
		const data = response.data as { token?: unknown; expires_at?: unknown };
		if (typeof data.token !== "string" || data.token === "") {
			throw new TransientJobError("GitHub did not return an installation token.");
		}
		const expiresAt =
			typeof data.expires_at === "string" ? Date.parse(data.expires_at) : Number.NaN;
		this.tokenCache.set(installationId, {
			token: data.token,
			expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 50 * 60_000,
		});
		return data.token;
	}

	private async assertAuthorized(
		octokit: Octokit,
		repoInfo: RepositoryInfo,
		actor: string,
		config: RepoConfig,
		logger: Logger,
	): Promise<void> {
		if (config.permissions.allow.includes(actor.toLowerCase())) {
			return;
		}
		const key = `${repoInfo.fullName}:${actor.toLowerCase()}`;
		const cached = this.permissionCache.get(key);
		const now = Date.now();
		if (cached && cached.expiresAt > now) {
			if (cached.allowed) return;
			throw new PermanentJobError(
				`@${actor} needs write access to this repository to use PiG.`,
			);
		}

		let allowed = false;
		try {
			const { data } = await octokit.repos.getCollaboratorPermissionLevel({
				owner: repoInfo.owner,
				repo: repoInfo.name,
				username: actor,
			});
			allowed = ["admin", "maintain", "write", "push"].includes(data.permission.toLowerCase());
		} catch (error) {
			if ((error as { status?: number }).status !== 404) {
				throw error;
			}
		}
		this.permissionCache.set(key, {
			allowed,
			expiresAt: now + (allowed ? 10 * 60_000 : 60_000),
		});
		if (!allowed) {
			logger.info("Authorization denied", { actor });
			throw new PermanentJobError(
				`@${actor} needs write access to this repository to use PiG.`,
			);
		}
	}
}

