import type { Context } from "@earendil-works/chord";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { JobDoc, type JobDocValue } from "./docs.ts";

export function jobKey(taskId: TaskId): string {
	return String(taskId);
}

export function emptyJobDoc(): JobDocValue {
	return {
		status: "queued",
		checkpoint: null,
		progressCommentId: null,
		conversationId: null,
		conversationAttempt: 0,
		attempt: 1,
		summary: null,
		error: null,
		events: [],
		updatedAt: 0,
	};
}

export async function readJobDoc(
	harness: Harness,
	taskId: TaskId,
	context: Context,
): Promise<JobDocValue> {
	const value = await harness.snapshot(JobDoc, jobKey(taskId), context);
	return value ? { ...emptyJobDoc(), ...value } : emptyJobDoc();
}
