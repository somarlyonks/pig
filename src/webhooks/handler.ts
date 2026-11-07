import { randomUUID } from "node:crypto";
import type { JobKind, JobRequest, JobSource, TriggerContext } from "../jobs/types.ts";
import type { JobStore } from "../jobs/store.ts";
import type { Logger } from "../logger.ts";
import { parseMentionCommand, type ParsedCommand } from "./commands.ts";

export interface WebhookDependencies {
	store: JobStore;
	logger: Logger;
	appSlug: string;
	newId?: () => string;
	now?: () => number;
}

export interface WebhookInput {
	event: string;
	deliveryId: string;
	payload: unknown;
}

export interface WebhookResult {
	status: number;
	body: Record<string, unknown>;
}

interface RepositoryWebhook {
	installationId: number;
	repo: string;
	repoOwner: string;
	repoName: string;
}

interface CommentJobInput {
	deps: WebhookDependencies;
	installationId: number;
	repo: string;
	actor: string;
	source: JobSource;
	trigger: TriggerContext;
	command: ParsedCommand;
	keyPrefix: string;
	now: number;
}

type DispatchResult = { jobId: string | null; ignored?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function resolveRepository(payload: Record<string, unknown>): RepositoryWebhook | null {
	const repository = asRecord(payload.repository);
	const installation = asRecord(payload.installation);
	const fullName = asString(repository?.full_name);
	const installationId = asNumber(installation?.id);
	if (!fullName || installationId === null) {
		return null;
	}
	const slash = fullName.indexOf("/");
	if (slash <= 0) {
		return null;
	}
	return {
		installationId,
		repo: fullName,
		repoOwner: fullName.slice(0, slash),
		repoName: fullName.slice(slash + 1),
	};
}

function isBot(login: string, type: string | null, appSlug: string): boolean {
	if (type === "Bot") return true;
	return login.toLowerCase() === `${appSlug.toLowerCase()}[bot]`;
}

function commandKey(command: ParsedCommand): string {
	return command.kind === "invalid" ? "notice" : command.kind;
}

function controlJob(
	input: CommentJobInput,
	action: "help" | "status" | "cancel" | "notice",
	message: string | null,
): { kind: JobKind; request: JobRequest; idempotencyKey: string; maxAttempts: number } {
	const request: JobRequest = {
		kind: "control",
		action,
		message,
		actor: input.actor,
		source: input.source,
		trigger: input.trigger,
		receivedAt: input.now,
	};
	return {
		kind: "control",
		request,
		idempotencyKey: `${input.keyPrefix}:${action === "notice" ? "notice" : input.command.kind}`,
		maxAttempts: 1,
	};
}

function buildCommentJob(
	input: CommentJobInput,
): { kind: JobKind; request: JobRequest; idempotencyKey: string; maxAttempts: number } {
	const command = input.command;
	const key = `${input.keyPrefix}:${commandKey(command)}`;
	const base = {
		actor: input.actor,
		source: input.source,
		trigger: input.trigger,
		receivedAt: input.now,
	};

	switch (command.kind) {
		case "help":
			return controlJob(input, "help", null);
		case "status":
			return controlJob(input, "status", null);
		case "cancel":
			return controlJob(input, "cancel", null);
		case "review": {
			if (input.source.type !== "pull_request") {
				return controlJob(
					input,
					"notice",
					"Reviews run on pull requests. Comment `@pig review` on a PR to review it.",
				);
			}
			const request: JobRequest = {
				kind: "review",
				auto: false,
				headSha: null,
				focus: command.focus,
				...base,
			};
			return {
				kind: "review",
				request,
				idempotencyKey: key,
				maxAttempts: 2,
			};
		}
		case "release": {
			const request: JobRequest = {
				kind: "release",
				bump: command.bump,
				version: command.version,
				draft: command.draft,
				prerelease: command.prerelease,
				...base,
			};
			return {
				kind: "release",
				request,
				idempotencyKey: key,
				maxAttempts: 2,
			};
		}
		case "work": {
			const request: JobRequest = {
				kind: "work",
				instructions: command.instructions,
				...base,
			};
			return {
				kind: "work",
				request,
				idempotencyKey: key,
				maxAttempts: 2,
			};
		}
		case "invalid":
			return controlJob(input, "notice", command.message);
	}
}

function enqueueCommentJob(
	deps: WebhookDependencies,
	repo: RepositoryWebhook,
	input: CommentJobInput,
): string {
	const job = buildCommentJob(input);
	const result = deps.store.enqueue(
		{
			id: (deps.newId ?? randomUUID)(),
			installationId: repo.installationId,
			repo: repo.repo,
			kind: job.kind,
			idempotencyKey: job.idempotencyKey,
			request: job.request,
			maxAttempts: job.maxAttempts,
		},
		input.now,
	);
	if (!result.created) {
		deps.logger.debug("Duplicate command ignored", {
			repo: repo.repo,
			key: job.idempotencyKey,
			jobId: result.job.id,
		});
	}
	return result.job.id;
}

function handleIssueComment(
	deps: WebhookDependencies,
	payload: Record<string, unknown>,
	now: number,
): DispatchResult {
	if (asString(payload.action) !== "created") {
		return { jobId: null, ignored: "action" };
	}
	const repo = resolveRepository(payload);
	if (!repo) return { jobId: null, ignored: "missing installation" };

	const issue = asRecord(payload.issue);
	const comment = asRecord(payload.comment);
	const user = asRecord(comment?.user);
	const issueNumber = asNumber(issue?.number);
	const commentId = asNumber(comment?.id);
	const body = asString(comment?.body);
	const login = asString(user?.login);
	const userType = asString(user?.type);
	if (!issue || !comment || issueNumber === null || commentId === null || !body || !login) {
		return { jobId: null, ignored: "malformed issue comment" };
	}
	if (isBot(login, userType, deps.appSlug)) {
		return { jobId: null, ignored: "bot author" };
	}
	const command = parseMentionCommand(body, deps.appSlug);
	if (!command) return { jobId: null, ignored: "no mention" };

	const pullRequest = asRecord(issue.pull_request);
	const source: JobSource = {
		type: pullRequest ? "pull_request" : "issue",
		number: issueNumber,
		title: asString(issue.title),
	};
	const trigger: TriggerContext = {
		commentId,
		commentBody: body,
		commentAuthor: login,
		reviewComment: null,
	};

	const jobId = enqueueCommentJob(deps, repo, {
		deps,
		installationId: repo.installationId,
		repo: repo.repo,
		actor: login,
		source,
		trigger,
		command,
		keyPrefix: `comment:${repo.repo}:${commentId}`,
		now,
	});
	return { jobId };
}

function handleReviewComment(
	deps: WebhookDependencies,
	payload: Record<string, unknown>,
	now: number,
): DispatchResult {
	if (asString(payload.action) !== "created") {
		return { jobId: null, ignored: "action" };
	}
	const repo = resolveRepository(payload);
	if (!repo) return { jobId: null, ignored: "missing installation" };

	const comment = asRecord(payload.comment);
	const user = asRecord(comment?.user);
	const pullRequest = asRecord(payload.pull_request);
	const commentId = asNumber(comment?.id);
	const body = asString(comment?.body);
	const login = asString(user?.login);
	const userType = asString(user?.type);
	let number = asNumber(pullRequest?.number);
	if (number === null) {
		const pullRequestUrl = asString(comment?.pull_request_url);
		const match = pullRequestUrl ? /\/pulls\/(\d+)(?:$|[?#])/.exec(pullRequestUrl) : null;
		number = match?.[1] ? Number(match[1]) : null;
	}
	if (!comment || commentId === null || number === null || !body || !login) {
		return { jobId: null, ignored: "malformed review comment" };
	}
	if (isBot(login, userType, deps.appSlug)) {
		return { jobId: null, ignored: "bot author" };
	}
	const command = parseMentionCommand(body, deps.appSlug);
	if (!command) return { jobId: null, ignored: "no mention" };

	const path = asString(comment.path);
	const line = asNumber(comment.line) ?? asNumber(comment.original_line);
	const trigger: TriggerContext = {
		commentId,
		commentBody: body,
		commentAuthor: login,
		reviewComment:
			path !== null
				? {
						id: commentId,
						path,
						line,
						body,
					}
				: null,
	};
	const source: JobSource = {
		type: "pull_request",
		number,
		title: asString(pullRequest?.title),
	};

	const jobId = enqueueCommentJob(deps, repo, {
		deps,
		installationId: repo.installationId,
		repo: repo.repo,
		actor: login,
		source,
		trigger,
		command,
		keyPrefix: `review-comment:${repo.repo}:${commentId}`,
		now,
	});
	return { jobId };
}

const AUTO_REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

function handlePullRequest(
	deps: WebhookDependencies,
	payload: Record<string, unknown>,
	now: number,
): DispatchResult {
	const action = asString(payload.action);
	if (!action || !AUTO_REVIEW_ACTIONS.has(action)) {
		return { jobId: null, ignored: "action" };
	}
	const repo = resolveRepository(payload);
	if (!repo) return { jobId: null, ignored: "missing installation" };
	const pullRequest = asRecord(payload.pull_request);
	const head = asRecord(pullRequest?.head);
	const user = asRecord(pullRequest?.user);
	const number = asNumber(pullRequest?.number);
	const headSha = asString(head?.sha);
	const login = asString(user?.login);
	const userType = asString(user?.type);
	if (!pullRequest || number === null || !headSha || !login) {
		return { jobId: null, ignored: "malformed pull request" };
	}
	if (isBot(login, userType, deps.appSlug)) {
		return { jobId: null, ignored: "own pull request" };
	}

	const request: JobRequest = {
		kind: "review",
		auto: true,
		headSha,
		focus: null,
		actor: login,
		source: {
			type: "pull_request",
			number,
			title: asString(pullRequest.title),
		},
		trigger: {
			commentId: null,
			commentBody: null,
			commentAuthor: null,
			reviewComment: null,
		},
		receivedAt: now,
	};
	const result = deps.store.enqueue(
		{
			id: (deps.newId ?? randomUUID)(),
			installationId: repo.installationId,
			repo: repo.repo,
			kind: "review",
			idempotencyKey: `auto-review:${repo.repo}:${number}:${headSha}${action === "ready_for_review" ? ":ready" : ""}`,
			request,
			maxAttempts: 2,
		},
		now,
	);
	return { jobId: result.job.id };
}

function dispatch(
	deps: WebhookDependencies,
	input: WebhookInput,
	now: number,
): DispatchResult {
	const payload = asRecord(input.payload);
	if (!payload) {
		return { jobId: null, ignored: "non-object payload" };
	}
	switch (input.event) {
		case "ping":
			return { jobId: null, ignored: "ping" };
		case "issue_comment":
			return handleIssueComment(deps, payload, now);
		case "pull_request_review_comment":
			return handleReviewComment(deps, payload, now);
		case "pull_request":
			return handlePullRequest(deps, payload, now);
		default:
			return { jobId: null, ignored: "event" };
	}
}

export function handleWebhook(
	deps: WebhookDependencies,
	input: WebhookInput,
): WebhookResult {
	const now = (deps.now ?? Date.now)();
	if (deps.store.hasDelivery(input.deliveryId)) {
		return { status: 202, body: { ok: true, duplicate: true } };
	}

	const result = dispatch(deps, input, now);
	deps.store.recordDelivery(input.deliveryId, input.event, result.jobId, now);
	deps.logger.info("Webhook processed", {
		event: input.event,
		deliveryId: input.deliveryId,
		jobId: result.jobId,
		ignored: result.ignored,
	});

	return {
		status: 202,
		body: {
			ok: true,
			jobId: result.jobId,
			...(result.ignored ? { ignored: result.ignored } : {}),
		},
	};
}
