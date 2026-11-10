import type { JobDetail } from "./jobs/context.ts";
import { signWebhookPayload } from "./webhooks/sign.ts";

export interface SmokeOptions {
	repo: string;
	installationId: number;
	anchor: { number: number; title: string | null; isPullRequest?: boolean };
	actor: string;
	mode: "status" | "work";
	instructions: string;
	baseUrl: string;
	webhookSecret: string;
	getJob(id: string): Promise<JobDetail | null>;
	fetch?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
}

export interface SmokeReport {
	jobId: string;
	status: string;
	summary: string;
	error: string | null;
	result: Record<string, unknown>;
	events: string[];
}

/**
 * A synthetic GitHub delivery that is shaped exactly like the real one, so the
 * smoke run exercises signature verification, planning, admission, authorization,
 * the job task, and GitHub output — everything except GitHub's own delivery.
 */
export function buildIssueCommentPayload(options: {
	repo: string;
	installationId: number;
	number: number;
	title: string | null;
	actor: string;
	body: string;
	commentId: number;
	isPullRequest?: boolean;
	now?: number;
}): Record<string, unknown> {
	const now = options.now ?? Date.now();
	return {
		action: "created",
		repository: {
			full_name: options.repo,
			name: options.repo.split("/")[1] ?? options.repo,
			private: false,
		},
		installation: { id: options.installationId },
		issue: {
			number: options.number,
			title: options.title,
			body: "PiG smoke run.",
			state: "open",
			user: { login: options.actor, type: "User" },
			...(options.isPullRequest ? { pull_request: { url: "" } } : {}),
		},
		comment: {
			id: options.commentId,
			body: options.body,
			created_at: new Date(now).toISOString(),
			user: { login: options.actor, type: "User" },
		},
		sender: { login: options.actor, type: "User" },
	};
}

export function smokeCommand(options: {
	mode: "status" | "work";
	instructions: string;
}): string {
	return options.mode === "status" ? "@pig status" : `@pig fix ${options.instructions}`;
}

async function poll(
	options: SmokeOptions,
	jobId: string,
): Promise<JobDetail | null> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const detail = await options.getJob(jobId);
		if (
			detail &&
			(detail.job.status === "succeeded" ||
				detail.job.status === "failed" ||
				detail.job.status === "cancelled")
		) {
			return detail;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return options.getJob(jobId);
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
	const now = options.now ?? (() => Date.now());
	const payload = buildIssueCommentPayload({
		repo: options.repo,
		installationId: options.installationId,
		number: options.anchor.number,
		title: options.anchor.title,
		actor: options.actor,
		body: smokeCommand({ mode: options.mode, instructions: options.instructions }),
		commentId: now(),
		isPullRequest: options.anchor.isPullRequest === true,
		now: now(),
	});
	const body = JSON.stringify(payload);
	const response = await (options.fetch ?? fetch)(
		`${options.baseUrl.replace(/\/+$/, "")}/api/github/webhooks`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-github-event": "issue_comment",
				"x-github-delivery": `smoke-${now()}`,
				"x-hub-signature-256": signWebhookPayload(options.webhookSecret, body),
			},
			body,
		},
	);
	const result = (await response.json().catch(() => null)) as
		| { jobId?: unknown; error?: unknown; ignored?: unknown }
		| null;
	if (!response.ok || result === null) {
		throw new Error(
			`webhook delivery failed: ${response.status} ${String(result?.error ?? "")}`.trim(),
		);
	}
	if (typeof result.jobId !== "string") {
		throw new Error(`webhook was accepted but planned no job: ${JSON.stringify(result)}`);
	}
	const jobId = result.jobId;
	const detail = await poll(options, jobId);
	if (!detail) {
		throw new Error(`job ${jobId} was admitted but could not be read back`);
	}
	return {
		jobId,
		status: detail.job.status,
		summary: detail.job.summary,
		error: detail.job.error,
		result: detail.result,
		events: detail.events,
	};
}
