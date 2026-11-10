import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId, TaskRecord } from "@earendil-works/pi-durable";
import type {
	JobDetail,
	JobSummary,
	JobSummaryStatus,
} from "../jobs/context.ts";
import type { JobKind, JobRequest } from "../jobs/types.ts";
import { commandDocKey } from "./admission.ts";
import { CommandDoc, JobDoc } from "./docs.ts";
import { readJobDoc } from "./job-docs.ts";
import type { JobTaskCheckpoint, JobTaskInput } from "./task-types.ts";

function taskInput(record: TaskRecord<unknown, unknown, unknown>): JobTaskInput {
	return record.input as JobTaskInput;
}

function mapLiveStatus(status: string): JobSummaryStatus {
	switch (status) {
		case "pending":
			return "queued";
		case "running":
			return "running";
		case "waiting":
			return "waiting";
		case "sleeping":
			return "sleeping";
		case "completing":
			return "running";
		default:
			return "queued";
	}
}

function mapTerminalStatus(record: TaskRecord<unknown, unknown, unknown>): JobSummaryStatus {
	if (record.state.status !== "terminal") {
		return mapLiveStatus(record.state.status);
	}
	switch (record.state.outcome.status) {
		case "completed":
			return "succeeded";
		case "aborted":
			return "cancelled";
		case "failed":
		case "faulted":
		case "orphaned":
			return "failed";
	}
}

function taskAttempt(
	record: TaskRecord<unknown, unknown, unknown>,
	docAttempt: number | undefined,
): number {
	if (typeof docAttempt === "number" && docAttempt > 0) return docAttempt;
	if (record.state.status !== "terminal" && record.state.status !== "completing") {
		const checkpoint = record.state.checkpoint as Partial<JobTaskCheckpoint> | undefined;
		if (typeof checkpoint?.attempt === "number") return checkpoint.attempt;
	}
	return 1;
}

function taskSummary(record: TaskRecord<unknown, unknown, unknown>): string {
	if (record.state.status === "terminal" && record.state.outcome.status === "completed") {
		const result = record.state.outcome.result as { summary?: unknown } | undefined;
		if (typeof result?.summary === "string") return result.summary;
	}
	return "";
}

function taskError(record: TaskRecord<unknown, unknown, unknown>): string | null {
	if (
		record.state.status === "terminal" &&
		(record.state.outcome.status === "failed" || record.state.outcome.status === "faulted")
	) {
		return record.state.outcome.error.message;
	}
	return null;
}

function toSummary(
	record: TaskRecord<unknown, unknown, unknown>,
	doc: { summary: string | null; error: string | null; attempt: number } | undefined,
): JobSummary {
	const input = taskInput(record);
	const status =
		record.state.status === "terminal" || record.state.status === "completing"
			? mapTerminalStatus(record)
			: mapLiveStatus(record.state.status);
	return {
		id: String(record.id),
		kind: input.request.kind as JobKind,
		origin: input.request.origin,
		status,
		attempts: taskAttempt(record, doc?.attempt),
		maxAttempts: input.maxAttempts,
		createdAt: input.createdAt,
		summary: doc?.summary ?? taskSummary(record),
		error: doc?.error ?? taskError(record),
	};
}

export async function listJobsForRepo(
	harness: Harness,
	taskName: string,
	repo: string,
	limit: number,
): Promise<JobSummary[]> {
	const page = await harness.commit(
		(tx) => tx.scanTasks({ kind: taskName, order: "descending" }, 300),
		BACKGROUND_CONTEXT,
	);
	const jobs: JobSummary[] = [];
	for (const record of page.items) {
		const input = taskInput(record);
		if (input.repo !== repo) continue;
		const doc = await readJobDoc(harness, record.id, BACKGROUND_CONTEXT);
		jobs.push(toSummary(record, doc));
		if (jobs.length >= limit) break;
	}
	return jobs;
}

function taskResult(
	record: TaskRecord<unknown, unknown, unknown>,
): Record<string, unknown> {
	if (record.state.status !== "terminal") return {};
	if (record.state.outcome.status !== "completed") return {};
	const result = record.state.outcome.result as { result?: unknown } | null | undefined;
	return typeof result?.result === "object" && result.result !== null
		? (result.result as Record<string, unknown>)
		: {};
}

export async function getJobDetail(
	harness: Harness,
	taskName: string,
	id: string,
): Promise<JobDetail | null> {
	const taskId = Number(id);
	if (!Number.isInteger(taskId) || taskId <= 0) return null;
	const record = await harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT);
	if (!record || record.kind !== taskName) return null;
	const input = taskInput(record);
	const doc = await harness.snapshot(JobDoc, String(record.id), BACKGROUND_CONTEXT);
	return {
		job: toSummary(record, doc),
		repo: input.repo,
		request: input.request as JobRequest,
		events: doc?.events ?? [],
		progressCommentId: doc?.progressCommentId ?? null,
		reply: doc?.reply ?? null,
		result: taskResult(record),
	};
}

export async function findJobByCommandKey(
	harness: Harness,
	taskName: string,
	idempotencyKey: string,
): Promise<JobDetail | null> {
	const command = await harness.snapshot(
		CommandDoc,
		commandDocKey(idempotencyKey),
		BACKGROUND_CONTEXT,
	);
	if (!command || command.taskId === 0) return null;
	return getJobDetail(harness, taskName, String(command.taskId));
}

export async function cancelJobsForRepo(
	harness: Harness,
	taskName: string,
	repo: string,
	exceptTaskId: TaskId,
): Promise<{ cancelled: number; running: number }> {
	const inspection = await harness.inspect(BACKGROUND_CONTEXT);
	let cancelled = 0;
	let running = 0;
	for (const item of inspection.tasks) {
		const record = item.record;
		if (record.kind !== taskName) continue;
		const input = taskInput(record);
		if (input.repo !== repo || record.id === exceptTaskId) continue;
		if (record.state.status === "terminal" || record.state.status === "completing") {
			continue;
		}
		const wasRunning = record.state.status === "running";
		const result = await harness.abortTask(record.id, BACKGROUND_CONTEXT);
		if (result === "marked") {
			cancelled += 1;
			if (wasRunning) running += 1;
		}
	}
	return { cancelled, running };
}

export async function countActiveJobs(harness: Harness, taskName: string): Promise<number> {
	const inspection = await harness.inspect(BACKGROUND_CONTEXT);
	return inspection.tasks.filter((item) => item.record.kind === taskName).length;
}
