import { test } from "node:test";
import assert from "node:assert/strict";
import { planWebhook } from "../src/webhooks/plan.ts";
import { verifyWebhookSignature } from "../src/webhooks/verify.ts";
import { buildIssueCommentPayload, smokeCommand } from "../src/smoke.ts";
import { signWebhookPayload } from "../src/webhooks/sign.ts";
import type { ControlJobRequest, WorkJobRequest } from "../src/jobs/types.ts";

const NOW = 1_700_000_000_000;

function payload(options: { body?: string; isPullRequest?: boolean } = {}): Record<string, unknown> {
	return buildIssueCommentPayload({
		repo: "acme/app",
		installationId: 42,
		number: 7,
		title: "Smoke",
		actor: "alice",
		body: options.body ?? smokeCommand({ mode: "status", instructions: "" }),
		commentId: 9001,
		...(options.isPullRequest === undefined ? {} : { isPullRequest: options.isPullRequest }),
		now: NOW,
	});
}

test("a synthetic status delivery plans a control job", () => {
	const plan = planWebhook("issue_comment", payload(), "pig", NOW);
	assert.equal(plan.kind, "admit");
	if (plan.kind !== "admit") return;
	assert.equal(plan.admission.repo, "acme/app");
	assert.equal(plan.admission.installationId, 42);
	assert.equal(plan.admission.jobKind, "control");
	assert.equal(plan.admission.chained, false);
	const request = plan.admission.request as ControlJobRequest;
	assert.equal(request.kind, "control");
	assert.equal(request.action, "status");
	assert.equal(request.origin, "github");
	assert.equal(request.actor, "alice");
});

test("a synthetic work delivery on an issue plans a new-branch work job", () => {
	const plan = planWebhook(
		"issue_comment",
		payload({ body: smokeCommand({ mode: "work", instructions: "Add smoke.txt" }) }),
		"pig",
		NOW,
	);
	assert.equal(plan.kind, "admit");
	if (plan.kind !== "admit") return;
	const request = plan.admission.request as WorkJobRequest;
	assert.equal(request.kind, "work");
	assert.equal(request.target, "new");
	assert.equal(request.instructions, "Add smoke.txt");
	assert.equal(request.source.type, "issue");
});

test("a synthetic work delivery on a pull request targets its head branch", () => {
	const plan = planWebhook(
		"issue_comment",
		payload({
			body: smokeCommand({ mode: "work", instructions: "Add smoke.txt" }),
			isPullRequest: true,
		}),
		"pig",
		NOW,
	);
	assert.equal(plan.kind, "admit");
	if (plan.kind !== "admit") return;
	const request = plan.admission.request as WorkJobRequest;
	assert.equal(request.target, "head");
	assert.equal(request.source.type, "pull_request");
});

test("the smoke delivery carries a signature GitHub would accept", () => {
	const body = JSON.stringify(payload());
	const signature = signWebhookPayload("secret", body);
	assert.equal(signature.startsWith("sha256="), true);
	assert.equal(verifyWebhookSignature("secret", Buffer.from(body, "utf8"), signature), true);
	assert.equal(verifyWebhookSignature("other", Buffer.from(body, "utf8"), signature), false);
});

test("the synthetic payload is a plain bot-safe comment", () => {
	const record = payload();
	const comment = record.comment as { user: { type: string } };
	assert.equal(comment.user.type, "User");
	assert.equal(
		planWebhook("issue_comment", payload({ body: "no mention here" }), "pig", NOW).kind,
		"ignore",
	);
});

test("posts a signed delivery to the real server and reads the job back", async () => {
	const { startHttpServer } = await import("../src/server.ts");
	const { runSmoke } = await import("../src/smoke.ts");
	const seen: { event: string; deliveryId: string }[] = [];
	let admitted = 0;
	const detail = {
		job: {
			id: "1",
			kind: "work" as const,
			origin: "github" as const,
			status: "succeeded" as const,
			attempts: 1,
			maxAttempts: 2,
			createdAt: NOW,
			summary: "Opened a pull request",
			error: null,
		},
		repo: "acme/app",
		request: {
			kind: "control" as const,
			action: "status" as const,
			message: null,
			origin: "github" as const,
			actor: "alice",
			source: { type: "repository" as const, number: null, title: null },
			trigger: {
				commentId: null,
				commentBody: null,
				commentAuthor: null,
				reviewComment: null,
			},
			receivedAt: NOW,
		},
		events: ["admitted"],
		progressCommentId: null,
		reply: null,
		result: { prUrl: "https://github.com/acme/app/pull/99" },
	};

	const app = {
		config: {
			appId: 1,
			privateKey: "unused",
			webhookSecret: "secret",
			appSlug: "pig",
			port: 0,
			databasePath: ":memory:",
			workspaceRoot: "/tmp",
			model: undefined,
			thinking: undefined,
			tablePrefix: "pig_",
			jobTimeoutMs: 1_000,
			logLevel: "error" as const,
			adminToken: "admin",
			console: null,
		},
		harness: {} as never,
		admit: async (input: { event: string; deliveryId: string }) => {
			seen.push(input);
			admitted += 1;
			return { status: 202, body: { ok: true, jobId: "1" } };
		},
		dispatch: async () => ({ status: 202, body: {} }),
		listJobs: async () => [],
		getJob: async () => detail,
		getJobByCommandKey: async () => null,
		activeJobs: async () => 0,
		closed: new Promise<never>(() => {}),
		shutdown: async () => {},
	} as unknown as Parameters<typeof startHttpServer>[0]["app"];

	const logger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => logger,
	};
	const running = await startHttpServer({
		config: app.config,
		logger,
		version: "smoke",
		app,
	});
	const address = running.server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	try {
		const report = await runSmoke({
			repo: "acme/app",
			installationId: 42,
			anchor: { number: 7, title: "Smoke" },
			actor: "alice",
			mode: "work",
			instructions: "Add smoke.txt",
			baseUrl: `http://127.0.0.1:${port}`,
			webhookSecret: "secret",
			getJob: async () => detail,
			now: () => NOW,
		});
		assert.equal(admitted, 1);
		assert.equal(seen[0]?.event, "issue_comment");
		assert.match(seen[0]?.deliveryId ?? "", /^smoke-/);
		assert.equal(report.jobId, "1");
		assert.equal(report.status, "succeeded");
		assert.equal(report.result.prUrl, "https://github.com/acme/app/pull/99");
	} finally {
		await running.close();
	}
});
