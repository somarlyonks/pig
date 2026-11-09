import type { Logger } from "../logger.ts";
import type { JobRequest } from "../jobs/types.ts";
import type { ProgressComment } from "./progress.ts";

export function shouldAck(request: JobRequest): boolean {
	if (request.kind === "control") return false;
	if (request.kind === "review" && request.auto) return false;
	return true;
}

export function shouldReportFailure(request: JobRequest): boolean {
	return !(request.kind === "review" && request.auto);
}

export function ackText(request: JobRequest): string {
	switch (request.kind) {
		case "work":
			return "PiG is working on this request.";
		case "review":
			return "PiG is reviewing this pull request.";
		case "release":
			return "PiG is preparing the release.";
		case "control":
			return "";
	}
}

export function backoffForAttempt(attempt: number): number {
	return Math.min(120_000, 15_000 * 2 ** Math.max(0, attempt - 1));
}

export async function safeUpdateProgress(
	progress: ProgressComment | null,
	request: JobRequest,
	render: () => string,
	logger: Logger,
): Promise<void> {
	if (!progress || !shouldReportFailure(request)) return;
	try {
		await progress.update(render());
	} catch (error) {
		logger.warn("Could not update the progress comment", { error });
	}
}
