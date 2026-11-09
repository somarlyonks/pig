import type { Octokit } from "@octokit/rest";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { RepositoryInfo } from "../github/repo.ts";
import type { Logger } from "../logger.ts";
import type { RepoConfig } from "../repo-config.ts";
import type { JobKind, JobRequest } from "./types.ts";

export interface JobInfo {
	id: string;
	installationId: number;
	repo: string;
	kind: JobKind;
	attempts: number;
	maxAttempts: number;
	createdAt: number;
}

export type AgentToolSet = "work" | "review";

export interface AgentRunOptions {
	cwd: string;
	prompt: string;
	tools: AgentToolSet;
	timeoutMs: number;
	signal: AbortSignal;
	onLog?: (message: string) => void;
}

export type AgentRunStatus = "done" | "failed" | "timeout" | "aborted";

export interface AgentRunResult {
	status: AgentRunStatus;
	finalText: string;
	error: string | null;
	retryable: boolean;
}

export interface AgentSettings {
	model: ModelRef | null;
	thinking: ModelThinkingLevel | null;
	timeoutMs: number;
}

export interface CheckoutRequest {
	ref: string;
	localBranch?: string | null;
	detached?: boolean;
	depth?: number;
}

export interface Checkout {
	repoDir: string;
	baseSha: string;
}

export type JobSummaryStatus =
	| "queued"
	| "running"
	| "waiting"
	| "sleeping"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface JobSummary {
	id: string;
	kind: JobKind;
	status: JobSummaryStatus;
	attempts: number;
	maxAttempts: number;
	createdAt: number;
	summary: string;
	error: string | null;
}

export interface JobDetail {
	job: JobSummary;
	repo: string;
	request: JobRequest;
	events: string[];
	progressCommentId: number | null;
}

export interface OrchestrationContext {
	job: JobInfo;
	request: JobRequest;
	repoInfo: RepositoryInfo;
	config: RepoConfig;
	octokit: Octokit;
	appSlug: string;
	appId: number;
	logger: Logger;
	signal: AbortSignal;
	checkpoint: unknown;
	setCheckpoint(value: unknown): Promise<void>;
	updateProgress(text: string): Promise<void>;
	cancelRepositoryJobs(): Promise<{ cancelled: number; running: number }>;
	listJobs(limit: number): Promise<JobSummary[]>;
	addEvent(level: string, message: string): Promise<void>;
	now(): number;
}

export interface JobContext extends OrchestrationContext {
	settings: AgentSettings;
	prepareCheckout(request: CheckoutRequest): Promise<Checkout>;
	workspaceRoot: string;
	workspaceDir: string;
	remoteUrl: string;
	getGitToken(): Promise<string>;
	agent: (options: AgentRunOptions) => Promise<AgentRunResult>;
}

export interface JobOutcome {
	comment: string | null;
	summary: string;
	result: Record<string, unknown>;
}

export function skippedOutcome(summary: string): JobOutcome {
	return { comment: null, summary, result: { skipped: true, reason: summary } };
}
