import type { JsonValue } from "@earendil-works/chord";
import type { JobRequest } from "../jobs/types.ts";

export const JOB_TASK_NAME = "pig.job";
export const ORCHESTRATION_TASK_NAME = "pig.orchestration";

export interface JobTaskInput {
	installationId: number;
	repo: string;
	request: JobRequest;
	idempotencyKey: string;
	maxAttempts: number;
	previousTaskId: number | null;
	createdAt: number;
}

export interface JobTaskCheckpoint {
	phase: "run";
	previousTaskId: number | null;
	attempt: number;
}

export interface JobTaskResult {
	summary: string;
	result: Record<string, JsonValue>;
}
