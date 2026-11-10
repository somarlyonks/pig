import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Task } from "@earendil-works/pi-durable";
import type { Logger } from "../logger.ts";
import {
	dispatchIdempotencyKey,
	isValidDispatchKey,
	planDispatch,
	type DispatchPlanInput,
} from "../dispatch/plan.ts";
import { planWebhook, type AdmissionPlan } from "../webhooks/plan.ts";
import { CommandDoc, DeliveryDoc, JobDoc, RepoDoc } from "./docs.ts";
import type { JobTaskInput } from "./task-types.ts";

export interface WebhookInput {
	event: string;
	deliveryId: string;
	payload: unknown;
}

export interface DispatchInput extends DispatchPlanInput {
	installationId: number;
}

export interface WebhookResult {
	status: number;
	body: Record<string, unknown>;
}

export type AdmissionDecision = AdmissionPlan | { kind: "ignore"; reason: string };

export interface AdmissionDeps<S extends { phase: string }, R> {
	harness: Harness;
	rootId: ConversationId;
	appSlug: string;
	logger: Logger;
	task: Task<JobTaskInput, S, R, object>;
	filterAdmission?: (admission: AdmissionPlan) => AdmissionDecision;
}

interface AdmissionOutcome {
	duplicate: boolean;
	taskId: number | null;
	expired: boolean;
}

export function admissionNotice(
	admission: AdmissionPlan,
	message: string,
): AdmissionPlan {
	const base = admission.request;
	return {
		installationId: admission.installationId,
		repo: admission.repo,
		jobKind: "control",
		request: {
			kind: "control",
			action: "notice",
			message,
			origin: base.origin,
			actor: base.actor,
			source: base.source,
			trigger: base.trigger,
			receivedAt: base.receivedAt,
		},
		idempotencyKey: `${admission.idempotencyKey}:unsupported`,
		maxAttempts: 1,
		chained: false,
	};
}

export function isIgnoredDecision(
	decision: AdmissionDecision,
): decision is { kind: "ignore"; reason: string } {
	return (decision as { kind?: string }).kind === "ignore";
}

function deliveryKey(deliveryId: string): string {
	return `d:${deliveryId}`;
}

function dispatchDeliveryKey(dispatchKey: string): string {
	return `w:${dispatchKey}`;
}

export function commandDocKey(idempotencyKey: string): string {
	return `c:${idempotencyKey}`;
}

async function commitAdmission<S extends { phase: string }, R>(
	deps: AdmissionDeps<S, R>,
	options: {
		deliveryDocKey: string;
		admission: AdmissionPlan;
		expiresAt: number | null;
		now: number;
	},
): Promise<AdmissionOutcome> {
	const admission = options.admission;
	return deps.harness.commit(async (tx) => {
		const delivery = await tx.doc(DeliveryDoc, options.deliveryDocKey, null);
		if (delivery.processed) {
			return { duplicate: true, taskId: delivery.taskId, expired: false };
		}
		const command = await tx.doc(CommandDoc, commandDocKey(admission.idempotencyKey), null);
		let taskId = command.taskId;
		if (taskId === 0) {
			if (options.expiresAt !== null && options.now > options.expiresAt) {
				return { duplicate: false, taskId: null, expired: true };
			}
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
			command.at = options.now;
			if (admission.chained) {
				repoDoc.tailTaskId = taskId;
			}
			const jobDoc = await tx.doc(JobDoc, String(taskId), null);
			jobDoc.status = "queued";
			jobDoc.updatedAt = options.now;
		}
		delivery.processed = true;
		delivery.at = options.now;
		delivery.taskId = taskId;
		return { duplicate: false, taskId, expired: false };
	}, BACKGROUND_CONTEXT);
}

async function recordIgnoredDelivery<S extends { phase: string }, R>(
	deps: AdmissionDeps<S, R>,
	deliveryDocKey: string,
	now: number,
): Promise<{ duplicate: boolean }> {
	return deps.harness.commit(async (tx) => {
		const delivery = await tx.doc(DeliveryDoc, deliveryDocKey, null);
		if (delivery.processed) {
			return { duplicate: true };
		}
		delivery.processed = true;
		delivery.at = now;
		return { duplicate: false };
	}, BACKGROUND_CONTEXT);
}

function accepted(duplicate: boolean, taskId: number | null): Record<string, unknown> {
	return {
		ok: true,
		jobId: taskId === null ? null : String(taskId),
		...(duplicate ? { duplicate: true } : {}),
	};
}

export async function admitWebhook<S extends { phase: string }, R>(
	deps: AdmissionDeps<S, R>,
	input: WebhookInput,
): Promise<WebhookResult> {
	const now = Date.now();
	const plan = planWebhook(input.event, input.payload, deps.appSlug, now);
	const key = deliveryKey(input.deliveryId);

	if (plan.kind === "ignore") {
		const outcome = await recordIgnoredDelivery(deps, key, now);
		deps.logger.info("Webhook admitted", {
			event: input.event,
			deliveryId: input.deliveryId,
			taskId: null,
			ignored: plan.reason,
			duplicate: outcome.duplicate,
		});
		return {
			status: 202,
			body: { ...accepted(outcome.duplicate, null), ignored: plan.reason },
		};
	}

	const decision = deps.filterAdmission
		? deps.filterAdmission(plan.admission)
		: plan.admission;
	const admission = isIgnoredDecision(decision) ? null : decision;
	const ignoredReason = isIgnoredDecision(decision) ? decision.reason : null;

	const outcome = admission
		? await commitAdmission(deps, {
				deliveryDocKey: key,
				admission,
				expiresAt: null,
				now,
			})
		: { duplicate: (await recordIgnoredDelivery(deps, key, now)).duplicate, taskId: null, expired: false };

	deps.logger.info("Webhook admitted", {
		event: input.event,
		deliveryId: input.deliveryId,
		taskId: outcome.taskId,
		ignored: ignoredReason,
		duplicate: outcome.duplicate,
	});

	return {
		status: 202,
		body: {
			...accepted(outcome.duplicate, outcome.taskId),
			...(ignoredReason ? { ignored: ignoredReason } : {}),
		},
	};
}

export async function admitDispatch<S extends { phase: string }, R>(
	deps: AdmissionDeps<S, R>,
	input: DispatchInput,
): Promise<WebhookResult> {
	if (!isValidDispatchKey(input.dispatchKey)) {
		return { status: 400, body: { error: "dispatchKey is required and must be stable" } };
	}
	if (input.notAfter !== null && !Number.isFinite(input.notAfter)) {
		return { status: 400, body: { error: "notAfter must be a timestamp" } };
	}

	const planned = planDispatch(input, input.installationId);
	if (planned.kind === "reject") {
		return { status: planned.status, body: { error: planned.error } };
	}

	const decision = deps.filterAdmission
		? deps.filterAdmission(planned.admission)
		: planned.admission;
	const key = dispatchDeliveryKey(input.dispatchKey);
	const admission = isIgnoredDecision(decision) ? null : decision;
	const ignoredReason = isIgnoredDecision(decision) ? decision.reason : null;

	const outcome = admission
		? await commitAdmission(deps, {
				deliveryDocKey: key,
				admission,
				expiresAt: input.notAfter,
				now: input.receivedAt,
			})
		: { duplicate: (await recordIgnoredDelivery(deps, key, input.receivedAt)).duplicate, taskId: null, expired: false };

	if (outcome.expired) {
		deps.logger.info("Dispatch rejected as expired", {
			dispatchKey: input.dispatchKey,
		});
		return {
			status: 410,
			body: { error: "dispatch expired", dispatchKey: input.dispatchKey },
		};
	}

	deps.logger.info("Dispatch admitted", {
		capability: input.capability,
		dispatchKey: input.dispatchKey,
		taskId: outcome.taskId,
		ignored: ignoredReason,
		duplicate: outcome.duplicate,
	});

	return {
		status: 202,
		body: {
			...accepted(outcome.duplicate, outcome.taskId),
			...(ignoredReason ? { ignored: ignoredReason } : {}),
		},
	};
}

export { dispatchIdempotencyKey };
