import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Task } from "@earendil-works/pi-durable";
import type { Logger } from "../logger.ts";
import { planWebhook } from "../webhooks/plan.ts";
import { CommandDoc, DeliveryDoc, JobDoc, RepoDoc } from "./docs.ts";
import type { JobTaskInput } from "./job-task.ts";

export interface WebhookInput {
	event: string;
	deliveryId: string;
	payload: unknown;
}

export interface WebhookResult {
	status: number;
	body: Record<string, unknown>;
}

export interface AdmissionDeps<S extends { phase: string }, R> {
	harness: Harness;
	rootId: ConversationId;
	appSlug: string;
	logger: Logger;
	task: Task<JobTaskInput, S, R, object>;
}

function deliveryKey(deliveryId: string): string {
	return `d:${deliveryId}`;
}

function commandKey(key: string): string {
	return `c:${key}`;
}

export async function admitWebhook<S extends { phase: string }, R>(
	deps: AdmissionDeps<S, R>,
	input: WebhookInput,
): Promise<WebhookResult> {
	const now = Date.now();
	const plan = planWebhook(input.event, input.payload, deps.appSlug, now);

	const outcome = await deps.harness.commit(async (tx) => {
		const delivery = await tx.doc(DeliveryDoc, deliveryKey(input.deliveryId), null);
		if (delivery.processed) {
			return { duplicate: true, taskId: delivery.taskId, ignored: null };
		}
		delivery.processed = true;
		delivery.at = now;

		if (plan.kind === "ignore") {
			return { duplicate: false, taskId: null, ignored: plan.reason };
		}

		const admission = plan.admission;
		const command = await tx.doc(CommandDoc, commandKey(admission.idempotencyKey), null);
		let taskId = command.taskId;
		if (taskId === 0) {
			const repoDoc = await tx.doc(RepoDoc, admission.repo, null);
			const previousTaskId = admission.chained ? repoDoc.tailTaskId : null;
			const taskInput: JobTaskInput = {
				installationId: admission.installationId,
				repo: admission.repo,
				request: admission.request,
				idempotencyKey: admission.idempotencyKey,
				maxAttempts: admission.maxAttempts,
				previousTaskId,
				createdAt: admission.request.receivedAt,
			};
			taskId = await tx.createTask(deps.task, taskInput, {
				ownership: { kind: "conversation" },
				conversationId: deps.rootId,
			});
			command.taskId = taskId;
			command.at = now;
			if (admission.chained) {
				repoDoc.tailTaskId = taskId;
			}
			const jobDoc = await tx.doc(JobDoc, String(taskId), null);
			jobDoc.status = "queued";
			jobDoc.updatedAt = now;
		}
		delivery.taskId = taskId;
		return { duplicate: false, taskId, ignored: null };
	}, BACKGROUND_CONTEXT);

	deps.logger.info("Webhook admitted", {
		event: input.event,
		deliveryId: input.deliveryId,
		taskId: outcome.taskId,
		ignored: outcome.ignored,
		duplicate: outcome.duplicate,
	});

	return {
		status: 202,
		body: {
			ok: true,
			jobId: outcome.taskId === null ? null : String(outcome.taskId),
			...(outcome.duplicate ? { duplicate: true } : {}),
			...(outcome.ignored ? { ignored: outcome.ignored } : {}),
		},
	};
}
