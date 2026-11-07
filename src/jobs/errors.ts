import { classifyGitHubError } from "../github/app.ts";

export class JobError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "JobError";
		this.retryable = retryable;
	}
}

export class PermanentJobError extends JobError {
	constructor(message: string) {
		super(message, false);
		this.name = "PermanentJobError";
	}
}

export class TransientJobError extends JobError {
	constructor(message: string) {
		super(message, true);
		this.name = "TransientJobError";
	}
}

export function toJobError(error: unknown): JobError {
	if (error instanceof JobError) {
		return error;
	}
	const classified = classifyGitHubError(error);
	return new JobError(classified.message, classified.retryable);
}

export function truncateError(message: string, limit = 2000): string {
	const compact = message.replace(/\s+/g, " ").trim();
	return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}
