import { test } from "node:test";
import assert from "node:assert/strict";
import { planWebhook, type WebhookPlan } from "../src/webhooks/plan.ts";
import type {
	AdmissionPlan,
} from "../src/webhooks/plan.ts";
import type {
	ControlJobRequest,
	ReleaseJobRequest,
	ReviewJobRequest,
	WorkJobRequest,
} from "../src/jobs/types.ts";

const REPOSITORY = {
	repository: { full_name: "acme/app" },
	installation: { id: 42 },
};

function issueCommentPayload(options: {
	number?: number;
	commentId?: number;
	body: string;
	login?: string;
	type?: string;
	isPullRequest?: boolean;
	title?: string;
}): Record<string, unknown> {
	return {
		action: "created",
		...REPOSITORY,
		issue: {
			number: options.number ?? 7,
			title: options.title ?? "Something is broken",
			body: "An issue",
			user: { login: "alice" },
			...(options.isPullRequest ? { pull_request: { url: "https://example.test/pr/7" } } : {}),
		},
		comment: {
			id: options.commentId ?? 1001,
			body: options.body,
			user: { login: options.login ?? "alice", type: options.type ?? "User" },
			author_association: "MEMBER",
		},
	};
}

function pullRequestPayload(options: {
	number?: number;
	sha?: string;
	action?: string;
	login?: string;
	type?: string;
	draft?: boolean;
}): Record<string, unknown> {
	return {
		action: options.action ?? "opened",
		...REPOSITORY,
		pull_request: {
			number: options.number ?? 5,
			title: "Add a feature",
			body: "PR body",
			draft: options.draft ?? false,
			merged: false,
			state: "open",
			user: { login: options.login ?? "alice", type: options.type ?? "User" },
			head: { sha: options.sha ?? "abc1234", ref: "feature" },
			base: { ref: "main" },
		},
	};
}

function reviewCommentPayload(options: {
	commentId?: number;
	body: string;
	login?: string;
	omitPullRequest?: boolean;
}): Record<string, unknown> {
	return {
		action: "created",
		...REPOSITORY,
		...(options.omitPullRequest
			? {}
			: {
					pull_request: {
						number: 5,
						title: "Add a feature",
						head: { sha: "abc1234", ref: "feature" },
					},
				}),
		comment: {
			id: options.commentId ?? 2001,
			body: options.body,
			path: "src/parser.ts",
			line: 12,
			user: { login: options.login ?? "bob", type: "User" },
			author_association: "COLLABORATOR",
			...(options.omitPullRequest
				? { pull_request_url: "https://api.github.com/repos/acme/app/pulls/5" }
				: {}),
		},
	};
}

function admission(plan: WebhookPlan): AdmissionPlan {
	assert.equal(plan.kind, "admit");
	if (plan.kind !== "admit") throw new Error("expected admission");
	return plan.admission;
}

test("queues one automatic review per pull request head", () => {
	const first = admission(
		planWebhook("pull_request", pullRequestPayload({}), "pig"),
	);
	assert.equal(first.jobKind, "review");
	assert.equal(first.chained, true);
	assert.equal(first.maxAttempts, 2);
	const review = first.request as ReviewJobRequest;
	assert.equal(review.auto, true);
	assert.equal(review.headSha, "abc1234");
	assert.equal(review.source.number, 5);
	assert.equal(review.actor, "alice");
	assert.equal(first.idempotencyKey, "auto-review:acme/app:5:abc1234");
});

test("a ready-for-review event has its own dedupe key", () => {
	const opened = admission(
		planWebhook("pull_request", pullRequestPayload({ action: "opened", sha: "same-sha" }), "pig"),
	);
	const ready = admission(
		planWebhook(
			"pull_request",
			pullRequestPayload({ action: "ready_for_review", sha: "same-sha" }),
			"pig",
		),
	);
	assert.notEqual(opened.idempotencyKey, ready.idempotencyKey);
});

test("ignores bot authors and non-trigger pull request actions", () => {
	assert.deepEqual(
		planWebhook("pull_request", pullRequestPayload({ login: "pig[bot]", type: "Bot" }), "pig"),
		{ kind: "ignore", reason: "own pull request" },
	);
	assert.deepEqual(
		planWebhook("pull_request", pullRequestPayload({ action: "closed" }), "pig"),
		{ kind: "ignore", reason: "action" },
	);
});

test("turns issue comments into chained work jobs", () => {
	const plan = admission(
		planWebhook("issue_comment", issueCommentPayload({ body: "@pig fix the failing tests" }), "pig"),
	);
	assert.equal(plan.jobKind, "work");
	assert.equal(plan.chained, true);
	assert.equal(plan.maxAttempts, 2);
	const request = plan.request as WorkJobRequest;
	assert.equal(request.kind, "work");
	assert.equal(request.instructions, "the failing tests");
	assert.equal(request.source.type, "issue");
	assert.equal(request.source.number, 7);
	assert.equal(request.actor, "alice");
	assert.equal(request.trigger.commentId, 1001);
	assert.equal(plan.idempotencyKey, "comment:acme/app:1001:work");
});

test("ignores comments without a mention", () => {
	assert.deepEqual(
		planWebhook("issue_comment", issueCommentPayload({ body: "no mention here" }), "pig"),
		{ kind: "ignore", reason: "no mention" },
	);
});

test("queues manual reviews only on pull requests", () => {
	const issuePlan = admission(
		planWebhook(
			"issue_comment",
			issueCommentPayload({ body: "@pig review", number: 8 }),
			"pig",
		),
	);
	const notice = issuePlan.request as ControlJobRequest;
	assert.equal(notice.kind, "control");
	assert.equal(notice.action, "notice");
	assert.match(notice.message ?? "", /pull requests/);
	assert.equal(issuePlan.chained, false);

	const prPlan = admission(
		planWebhook(
			"issue_comment",
			issueCommentPayload({ body: "@pig review security", number: 5, isPullRequest: true }),
			"pig",
		),
	);
	const review = prPlan.request as ReviewJobRequest;
	assert.equal(review.auto, false);
	assert.equal(review.focus, "security");
	assert.equal(prPlan.chained, true);
});

test("queues cancellation without touching jobs in the planner", () => {
	const plan = admission(
		planWebhook("issue_comment", issueCommentPayload({ body: "@pig cancel" }), "pig"),
	);
	assert.equal(plan.jobKind, "control");
	assert.equal((plan.request as ControlJobRequest).action, "cancel");
	assert.equal(plan.chained, false);
	assert.equal(plan.maxAttempts, 1);
});

test("rejects invalid commands through a visible notice", () => {
	const plan = admission(
		planWebhook("issue_comment", issueCommentPayload({ body: "@pig release banana" }), "pig"),
	);
	assert.equal(plan.request.kind, "control");
	assert.equal((plan.request as ControlJobRequest).action, "notice");
	assert.match((plan.request as ControlJobRequest).message ?? "", /Unrecognized release target/);
});

test("parses release commands into chained release jobs", () => {
	const plan = admission(
		planWebhook("issue_comment", issueCommentPayload({ body: "@pig release minor --draft" }), "pig"),
	);
	assert.equal(plan.jobKind, "release");
	assert.equal(plan.chained, true);
	const release = plan.request as ReleaseJobRequest;
	assert.equal(release.kind, "release");
	assert.equal(release.bump, "minor");
	assert.equal(release.draft, true);
	assert.equal(release.version, null);
});

test("handles inline review comments with file and line context", () => {
	const plan = admission(
		planWebhook(
			"pull_request_review_comment",
			reviewCommentPayload({ body: "@pig fix this off-by-one" }),
			"pig",
		),
	);
	assert.equal(plan.jobKind, "work");
	const request = plan.request as WorkJobRequest;
	assert.equal(request.kind, "work");
	assert.equal(request.source.type, "pull_request");
	assert.equal(request.source.number, 5);
	assert.equal(request.trigger.reviewComment?.path, "src/parser.ts");
	assert.equal(request.trigger.reviewComment?.line, 12);
	assert.equal(request.instructions, "this off-by-one");
});

test("falls back to the review comment's pull request URL", () => {
	const plan = admission(
		planWebhook(
			"pull_request_review_comment",
			reviewCommentPayload({ body: "@pig fix this", omitPullRequest: true }),
			"pig",
		),
	);
	assert.equal(plan.request.kind, "work");
	assert.equal(plan.request.source.number, 5);
});
