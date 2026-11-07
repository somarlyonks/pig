import type { Octokit } from "@octokit/rest";
import type { AgentRunner } from "../agent/runner.ts";
import type { RepositoryInfo } from "../github/repo.ts";
import type { Logger } from "../logger.ts";
import type { RepoConfig } from "../repo-config.ts";
import type { JobStore } from "./store.ts";
import type { JobRequest, JobRow } from "./types.ts";

export interface AgentSettings {
	model: string | null;
	thinking: string | null;
	timeoutMs: number;
}

export interface JobContext {
	job: JobRow;
	request: JobRequest;
	store: JobStore;
	repoInfo: RepositoryInfo;
	config: RepoConfig;
	octokit: Octokit;
	appSlug: string;
	appId: number;
	logger: Logger;
	signal: AbortSignal;
	workspaceRoot: string;
	workspaceDir: string;
	agent: AgentRunner;
	settings: AgentSettings;
	checkpoint: unknown;
	setCheckpoint(value: unknown): void;
	getGitToken(): Promise<string>;
	cancelRepositoryJobs(): { queued: number; running: number };
	addEvent(level: string, message: string): void;
	now(): number;
}

export interface JobOutcome {
	comment: string | null;
	summary: string;
	result: Record<string, unknown>;
}

export function skippedOutcome(summary: string): JobOutcome {
	return { comment: null, summary, result: { skipped: true, reason: summary } };
}
