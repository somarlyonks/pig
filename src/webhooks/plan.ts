import type { JobKind, JobRequest, JobSource, TriggerContext } from "../jobs/types.ts";
import { parseMentionCommand, type ParsedCommand } from "./commands.ts";

export interface AdmissionPlan {
	installationId: number;
	repo: string;
	jobKind: JobKind;
	request: JobRequest;
	idempotencyKey: string;
	maxAttempts: number;
	chained: boolean;
}

export type WebhookPlan =
	| { kind: "admit"; admission: AdmissionPlan }
	| { kind: "ignore"; reason: string };

interface RepositoryWebhook {
	installationId: number;
	repo: string;
}

interface CommandJobInput {
	repo: RepositoryWebhook;
	actor: string;
	source: JobSource;
	trigger: TriggerContext;
	command: ParsedCommand;
	keyPrefix: string;
	now: number;
}

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
	return { installationId, repo: fullName };
}

function isBot(login: string, type: string | null, appSlug: string): boolean {
	if (type === "Bot") return true;
	return login.toLowerCase() === `${appSlug.toLowerCase()}[bot]`;
}

function controlAdmission(
	input: CommandJobInput,
	action: "help" | "status" | "cancel" | "notice",
	message: string | null,
): AdmissionPlan {
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
		installationId: input.repo.installationId,
		repo: input.repo.repo,
		jobKind: "control",
		request,
		idempotencyKey: `${input.keyPrefix}:${action === "notice" ? "notice" : input.command.kind}`,
		maxAttempts: 1,
		chained: false,
	};
}

function buildCommentAdmission(input: CommandJobInput): AdmissionPlan {
	const command = input.command;
	const key = `${input.keyPrefix}:${command.kind === "invalid" ? "notice" : command.kind}`;
	const base = {
		actor: input.actor,
		source: input.source,
		trigger: input.trigger,
		receivedAt: input.now,
	};

	const admit = (jobKind: JobKind, request: JobRequest, maxAttempts: number): AdmissionPlan => ({
		installationId: input.repo.installationId,
		repo: input.repo.repo,
		jobKind,
		request,
		idempotencyKey: key,
		maxAttempts,
		chained: true,
	});

	switch (command.kind) {
		case "help":
			return controlAdmission(input, "help", null);
		case "status":
			return controlAdmission(input, "status", null);
		case "cancel":
			return { ...controlAdmission(input, "cancel", null), idempotencyKey: key };
		case "review": {
			if (input.source.type !== "pull_request") {
				return controlAdmission(
					input,
					"notice",
					"Reviews run on pull requests. Comment `@pig review` on a PR to review it.",
				);
			}
			return admit(
				"review",
				{ kind: "review", auto: false, headSha: null, focus: command.focus, ...base },
				2,
			);
		}
		case "release":
			return admit(
				"release",
				{
					kind: "release",
					bump: command.bump,
					version: command.version,
					draft: command.draft,
					prerelease: command.prerelease,
					...base,
				},
				2,
			);
		case "work":
			return admit("work", { kind: "work", instructions: command.instructions, ...base }, 2);
		case "invalid":
			return controlAdmission(input, "notice", command.message);
	}
}

function handleIssueComment(
	payload: Record<string, unknown>,
	appSlug: string,
	now: number,
): WebhookPlan {
	if (asString(payload.action) !== "created") {
		return { kind: "ignore", reason: "action" };
	}
	const repo = resolveRepository(payload);
	if (!repo) return { kind: "ignore", reason: "missing installation" };

	const issue = asRecord(payload.issue);
	const comment = asRecord(payload.comment);
	const user = asRecord(comment?.user);
	const issueNumber = asNumber(issue?.number);
	const commentId = asNumber(comment?.id);
	const body = asString(comment?.body);
	const login = asString(user?.login);
	const userType = asString(user?.type);
	if (!issue || !comment || issueNumber === null || commentId === null || !body || !login) {
		return { kind: "ignore", reason: "malformed issue comment" };
	}
	if (isBot(login, userType, appSlug)) {
		return { kind: "ignore", reason: "bot author" };
	}
	const command = parseMentionCommand(body, appSlug);
	if (!command) return { kind: "ignore", reason: "no mention" };

	const source: JobSource = {
		type: asRecord(issue.pull_request) ? "pull_request" : "issue",
		number: issueNumber,
		title: asString(issue.title),
	};
	const trigger: TriggerContext = {
		commentId,
		commentBody: body,
		commentAuthor: login,
		reviewComment: null,
	};
	return {
		kind: "admit",
		admission: buildCommentAdmission({
			repo,
			actor: login,
			source,
			trigger,
			command,
			keyPrefix: `comment:${repo.repo}:${commentId}`,
			now,
		}),
	};
}

function handleReviewComment(
	payload: Record<string, unknown>,
	appSlug: string,
	now: number,
): WebhookPlan {
	if (asString(payload.action) !== "created") {
		return { kind: "ignore", reason: "action" };
	}
	const repo = resolveRepository(payload);
	if (!repo) return { kind: "ignore", reason: "missing installation" };

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
		return { kind: "ignore", reason: "malformed review comment" };
	}
	if (isBot(login, userType, appSlug)) {
		return { kind: "ignore", reason: "bot author" };
	}
	const command = parseMentionCommand(body, appSlug);
	if (!command) return { kind: "ignore", reason: "no mention" };

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
	return {
		kind: "admit",
		admission: buildCommentAdmission({
			repo,
			actor: login,
			source: { type: "pull_request", number, title: asString(pullRequest?.title) },
			trigger,
			command,
			keyPrefix: `review-comment:${repo.repo}:${commentId}`,
			now,
		}),
	};
}

const AUTO_REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

function handlePullRequest(
	payload: Record<string, unknown>,
	appSlug: string,
	now: number,
): WebhookPlan {
	const action = asString(payload.action);
	if (!action || !AUTO_REVIEW_ACTIONS.has(action)) {
		return { kind: "ignore", reason: "action" };
	}
	const repo = resolveRepository(payload);
	if (!repo) return { kind: "ignore", reason: "missing installation" };
	const pullRequest = asRecord(payload.pull_request);
	const head = asRecord(pullRequest?.head);
	const user = asRecord(pullRequest?.user);
	const number = asNumber(pullRequest?.number);
	const headSha = asString(head?.sha);
	const login = asString(user?.login);
	const userType = asString(user?.type);
	if (!pullRequest || number === null || !headSha || !login) {
		return { kind: "ignore", reason: "malformed pull request" };
	}
	if (isBot(login, userType, appSlug)) {
		return { kind: "ignore", reason: "own pull request" };
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
	return {
		kind: "admit",
		admission: {
			installationId: repo.installationId,
			repo: repo.repo,
			jobKind: "review",
			request,
			idempotencyKey: `auto-review:${repo.repo}:${number}:${headSha}${action === "ready_for_review" ? ":ready" : ""}`,
			maxAttempts: 2,
			chained: true,
		},
	};
}

export function planWebhook(event: string, payload: unknown, appSlug: string, now = Date.now()): WebhookPlan {
	const record = asRecord(payload);
	if (!record) {
		return { kind: "ignore", reason: "non-object payload" };
	}
	switch (event) {
		case "ping":
			return { kind: "ignore", reason: "ping" };
		case "issue_comment":
			return handleIssueComment(record, appSlug, now);
		case "pull_request_review_comment":
			return handleReviewComment(record, appSlug, now);
		case "pull_request":
			return handlePullRequest(record, appSlug, now);
		default:
			return { kind: "ignore", reason: "event" };
	}
}
