import { test } from "node:test";
import assert from "node:assert/strict";
import { JobStore } from "../src/jobs/store.ts";
import type { ControlJobRequest, JobRow, ReleaseJobRequest, ReviewJobRequest, WorkJobRequest } from "../src/jobs/types.ts";
import type { Logger } from "../src/logger.ts";
import { handleWebhook, type WebhookDependencies } from "../src/webhooks/handler.ts";

function silentLogger(): Logger {
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => logger,
	};
	return logger;
}

interface Harness {
	store: JobStore;
	deps: WebhookDependencies;
	next(): number;
}

function harness(): Harness {
	const store = new JobStore(":memory:");
	let clock = 1000;
	let ids = 0;
	const deps: WebhookDependencies = {
		store,
		logger: silentLogger(),
		appSlug: "pig",
		newId: () => `job-${++ids}`,
		now: () => clock++,
	};
	return { store, deps, next: () => clock++ };
}

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

function jobs(store: JobStore): JobRow[] {
	return store.getJobsForRepo("acme/app", 100);
}

test("queues one automatic review per pull request head", () => {
	const { store, deps } = harness();
	const first = handleWebhook(deps, {
		event: "pull_request",
		deliveryId: "delivery-1",
		payload: pullRequestPayload({}),
	});
	assert.equal(first.status, 202);
	assert.match(String(first.body.jobId), /job-/);

	const reviewJob = jobs(store).find((job) => job.request.kind === "review")?.request as ReviewJobRequest;
	assert.equal(reviewJob.auto, true);
	assert.equal(reviewJob.headSha, "abc1234");
	assert.equal(reviewJob.source.number, 5);
	assert.equal(reviewJob.actor, "alice");

	const duplicate = handleWebhook(deps, {
		event: "pull_request",
		deliveryId: "delivery-1",
		payload: pullRequestPayload({}),
	});
	assert.equal(duplicate.body.duplicate, true);

	handleWebhook(deps, {
		event: "pull_request",
		deliveryId: "delivery-2",
		payload: pullRequestPayload({}),
	});
	assert.equal(jobs(store).length, 1);
	store.close();
});

test("a draft review then a ready-for-review event still reviews the same head", () => {
	const { store, deps } = harness();
	handleWebhook(deps, {
		event: "pull_request",
		deliveryId: "delivery-draft",
		payload: pullRequestPayload({ action: "opened", draft: true, sha: "same-sha" }),
	});
	handleWebhook(deps, {
		event: "pull_request",
		deliveryId: "delivery-ready",
		payload: pullRequestPayload({ action: "ready_for_review", draft: false, sha: "same-sha" }),
	});
	const reviews = jobs(store).filter((job) => job.request.kind === "review");
	assert.equal(reviews.length, 2);
	assert.notEqual(reviews[0]?.idempotencyKey, reviews[1]?.idempotencyKey);
	store.close();
});

test("ignores bot authors and non-trigger pull request actions", () => {
	const { store, deps } = harness();
	const bot = handleWebhook(deps, {
		event: "pull_request",
		deliveryId: "delivery-bot",
		payload: pullRequestPayload({ login: "pig[bot]", type: "Bot" }),
	});
	assert.equal(bot.body.jobId, null);
	const closed = handleWebhook(deps, {
		event: "pull_request",
		deliveryId: "delivery-closed",
		payload: pullRequestPayload({ action: "closed" }),
	});
	assert.equal(closed.body.jobId, null);
	assert.equal(jobs(store).length, 0);
	store.close();
});

test("turns issue comments into work jobs", () => {
	const { store, deps } = harness();
	const result = handleWebhook(deps, {
		event: "issue_comment",
		deliveryId: "delivery-work",
		payload: issueCommentPayload({ body: "@pig fix the failing tests" }),
	});
	assert.match(String(result.body.jobId), /job-/);
	const request = jobs(store)[0]?.request as WorkJobRequest;
	assert.equal(request.kind, "work");
	assert.equal(request.instructions, "the failing tests");
	assert.equal(request.source.type, "issue");
	assert.equal(request.source.number, 7);
	assert.equal(request.actor, "alice");
	assert.equal(request.trigger.commentId, 1001);

	handleWebhook(deps, {
		event: "issue_comment",
		deliveryId: "delivery-work-2",
		payload: issueCommentPayload({ body: "no mention here" }),
	});
	assert.equal(jobs(store).length, 1);
	assert.equal(store.hasDelivery("delivery-work-2"), true);
	store.close();
});

test("queues manual reviews only on pull requests", () => {
	const { store, deps } = harness();
	handleWebhook(deps, {
		event: "issue_comment",
		deliveryId: "delivery-review-issue",
		payload: issueCommentPayload({ body: "@pig review", number: 8 }),
	});
	const notice = jobs(store)[0]?.request as ControlJobRequest;
	assert.equal(notice.kind, "control");
	assert.equal(notice.action, "notice");
	assert.match(notice.message ?? "", /pull requests/);

	handleWebhook(deps, {
		event: "issue_comment",
		deliveryId: "delivery-review-pr",
		payload: issueCommentPayload({
			body: "@pig review security",
			number: 5,
			isPullRequest: true,
		}),
	});
	const review = jobs(store).find((job) => job.request.kind === "review")?.request as ReviewJobRequest;
	assert.equal(review.auto, false);
	assert.equal(review.focus, "security");
	store.close();
});

test("queues cancellation without touching jobs in the webhook handler", () => {
	const { store, deps, next } = harness();
	store.enqueue(
		{
			id: "running-job",
			installationId: 42,
			repo: "acme/app",
			kind: "work",
			idempotencyKey: "running",
			request: { kind: "work" },
			maxAttempts: 3,
		},
		next(),
	);
	store.claimNext("worker", next(), 60_000);

	const result = handleWebhook(deps, {
		event: "issue_comment",
		deliveryId: "delivery-cancel",
		payload: issueCommentPayload({ body: "@pig cancel" }),
	});
	assert.match(String(result.body.jobId), /job-/);
	assert.equal(store.isCancelRequested("running-job"), false);
	const control = jobs(store).find((job) => job.request.kind === "control")?.request as ControlJobRequest;
	assert.equal(control.action, "cancel");
	store.close();
});

test("rejects invalid commands through a visible notice", () => {
	const { store, deps } = harness();
	handleWebhook(deps, {
		event: "issue_comment",
		deliveryId: "delivery-invalid-release",
		payload: issueCommentPayload({ body: "@pig release banana" }),
	});
	const notice = jobs(store)[0]?.request as ControlJobRequest;
	assert.equal(notice.kind, "control");
	assert.equal(notice.action, "notice");
	assert.match(notice.message ?? "", /Unrecognized release target/);
	store.close();
});

test("parses release commands into release jobs", () => {
	const { store, deps } = harness();
	handleWebhook(deps, {
		event: "issue_comment",
		deliveryId: "delivery-release",
		payload: issueCommentPayload({ body: "@pig release minor --draft" }),
	});
	const release = jobs(store)[0]?.request as ReleaseJobRequest;
	assert.equal(release.kind, "release");
	assert.equal(release.bump, "minor");
	assert.equal(release.draft, true);
	assert.equal(release.version, null);
	store.close();
});

test("handles inline review comments with file and line context", () => {
	const { store, deps } = harness();
	handleWebhook(deps, {
		event: "pull_request_review_comment",
		deliveryId: "delivery-inline",
		payload: reviewCommentPayload({ body: "@pig fix this off-by-one" }),
	});
	const request = jobs(store)[0]?.request as WorkJobRequest;
	assert.equal(request.kind, "work");
	assert.equal(request.source.type, "pull_request");
	assert.equal(request.source.number, 5);
	assert.equal(request.trigger.reviewComment?.path, "src/parser.ts");
	assert.equal(request.trigger.reviewComment?.line, 12);
	assert.equal(request.instructions, "this off-by-one");
	store.close();
});

test("falls back to the review comment's pull request URL", () => {
	const { store, deps } = harness();
	handleWebhook(deps, {
		event: "pull_request_review_comment",
		deliveryId: "delivery-inline-url",
		payload: reviewCommentPayload({ body: "@pig fix this", omitPullRequest: true }),
	});
	const request = jobs(store)[0]?.request as WorkJobRequest;
	assert.equal(request.kind, "work");
	assert.equal(request.source.number, 5);
	store.close();
});
