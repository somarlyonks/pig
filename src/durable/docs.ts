import type { JsonValue } from "@earendil-works/chord";
import { defineDocFamily } from "@earendil-works/pi-durable";

export type DurableJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobDocValue {
	[key: string]: JsonValue;
	status: DurableJobStatus;
	checkpoint: JsonValue | null;
	progressCommentId: number | null;
	conversationId: number | null;
	conversationAttempt: number;
	attempt: number;
	summary: string | null;
	error: string | null;
	events: string[];
	updatedAt: number;
}

export interface DeliveryDocValue {
	[key: string]: JsonValue;
	processed: boolean;
	taskId: number | null;
	at: number;
}

export interface CommandDocValue {
	[key: string]: JsonValue;
	taskId: number;
	at: number;
}

export interface RepoDocValue {
	[key: string]: JsonValue;
	tailTaskId: number | null;
}

const CHECKPOINT_EVERY = 50;

export const JobDoc = defineDocFamily<JobDocValue, null>({
	kind: "pig.job",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({
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
	}),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= CHECKPOINT_EVERY,
});

export const DeliveryDoc = defineDocFamily<DeliveryDocValue, null>({
	kind: "pig.delivery",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ processed: false, taskId: null, at: 0 }),
	checkpointWhen: () => false,
});

export const CommandDoc = defineDocFamily<CommandDocValue, null>({
	kind: "pig.command",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ taskId: 0, at: 0 }),
	checkpointWhen: () => false,
});

export const RepoDoc = defineDocFamily<RepoDocValue, null>({
	kind: "pig.repo",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ tailTaskId: null }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= CHECKPOINT_EVERY,
});

export function appendEvent(events: string[], message: string): string[] {
	const next = [...events, message.slice(0, 1000)];
	return next.length > 200 ? next.slice(next.length - 200) : next;
}
