import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Harness } from "@earendil-works/pi-durable";
import type { AppConfig } from "../src/config.ts";
import type { PigApp } from "../src/durable/runtime-types.ts";
import type { JobDetail, JobSummary } from "../src/jobs/context.ts";
import type { Logger } from "../src/logger.ts";
import { startHttpServer, type RunningServer } from "../src/server.ts";
import type { WebhookInput, WebhookResult } from "../src/durable/admission.ts";

const SECRET = "integration-secret";

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

function config(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		appId: 1,
		privateKey: "unused",
		webhookSecret: SECRET,
		appSlug: "pig",
		port: 0,
		databasePath: ":memory:",
		workspaceRoot: "/tmp/pig-test",
		model: undefined,
		thinking: undefined,
		tablePrefix: "pig_",
		jobTimeoutMs: 60_000,
		logLevel: "error",
		adminToken: "admin-token",
		console: null,
		...overrides,
	};
}

function summary(): JobSummary {
	return {
		id: "7",
		kind: "work",
		origin: "github",
		status: "queued",
		attempts: 1,
		maxAttempts: 2,
		createdAt: 1000,
		summary: "",
		error: null,
	};
}

function detail(): JobDetail {
	return {
		job: summary(),
		repo: "acme/app",
		request: {
			kind: "control",
			action: "help",
			message: null,
			origin: "github",
			actor: "alice",
			source: { type: "issue", number: 7, title: null },
			trigger: {
				commentId: null,
				commentBody: null,
				commentAuthor: null,
				reviewComment: null,
			},
			receivedAt: 1000,
		},
		events: ["admitted"],
		progressCommentId: 12,
		reply: null,
	};
}

function fakeApp(overrides: Partial<PigApp> = {}): PigApp {
	return {
		config: config(),
		harness: {} as Harness,
		admit: async (input: WebhookInput): Promise<WebhookResult> => ({
			status: 202,
			body: { ok: true, jobId: "7", event: input.event },
		}),
		dispatch: async () => ({ status: 202, body: { ok: true, jobId: "7" } }),
		listJobs: async () => [summary()],
		getJob: async (id) => (id === "7" ? detail() : null),
		getJobByCommandKey: async (key) => (key === "dispatch:k1" ? detail() : null),
		activeJobs: async () => 0,
		closed: new Promise(() => {}),
		shutdown: async () => {},
		...overrides,
	};
}

async function startApp(app: PigApp): Promise<{
	running: RunningServer;
	baseUrl: string;
}> {
	const running = await startHttpServer({
		config: app.config,
		logger: silentLogger(),
		version: "test",
		app,
	});
	const address = running.server.address() as AddressInfo;
	return { running, baseUrl: `http://127.0.0.1:${address.port}` };
}

function sign(body: string, secret = SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const PING_PAYLOAD = JSON.stringify({ zen: "Non-blocking is better than blocking." });

test("serves health and root metadata", async () => {
	const app = fakeApp({ activeJobs: async () => 3 });
	const { running, baseUrl } = await startApp(app);
	try {
		const health = await fetch(`${baseUrl}/healthz`);
		assert.equal(health.status, 200);
		const body = (await health.json()) as { ok: boolean; activeJobs: number };
		assert.equal(body.ok, true);
		assert.equal(body.activeJobs, 3);

		const root = await fetch(`${baseUrl}/`);
		assert.equal(root.status, 200);
		assert.equal(((await root.json()) as { name: string }).name, "PiG");
	} finally {
		await running.close();
	}
});

test("rejects webhooks without a valid signature", async () => {
	const seen: WebhookInput[] = [];
	const app = fakeApp({
		admit: async (input) => {
			seen.push(input);
			return { status: 202, body: { ok: true } };
		},
	});
	const { running, baseUrl } = await startApp(app);
	try {
		const missing = await fetch(`${baseUrl}/api/github/webhooks`, {
			method: "POST",
			headers: { "x-github-event": "ping", "x-github-delivery": "d1" },
			body: PING_PAYLOAD,
		});
		assert.equal(missing.status, 401);

		const wrongSecret = await fetch(`${baseUrl}/api/github/webhooks`, {
			method: "POST",
			headers: {
				"x-github-event": "ping",
				"x-github-delivery": "d2",
				"x-hub-signature-256": sign(PING_PAYLOAD, "wrong"),
			},
			body: PING_PAYLOAD,
		});
		assert.equal(wrongSecret.status, 401);

		const malformed = await fetch(`${baseUrl}/api/github/webhooks`, {
			method: "POST",
			headers: {
				"x-github-event": "ping",
				"x-github-delivery": "d3",
				"x-hub-signature-256": "sha256=not-a-digest",
			},
			body: PING_PAYLOAD,
		});
		assert.equal(malformed.status, 401);
		assert.equal(seen.length, 0);
	} finally {
		await running.close();
	}
});

test("passes verified webhooks to the durable app", async () => {
	const seen: WebhookInput[] = [];
	const app = fakeApp({
		admit: async (input) => {
			seen.push(input);
			return { status: 202, body: { ok: true, jobId: "7" } };
		},
	});
	const { running, baseUrl } = await startApp(app);
	try {
		const response = await fetch(`${baseUrl}/api/github/webhooks`, {
			method: "POST",
			headers: {
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-1",
				"x-hub-signature-256": sign(PING_PAYLOAD),
			},
			body: PING_PAYLOAD,
		});
		assert.equal(response.status, 202);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.event, "issue_comment");
		assert.equal(seen[0]?.deliveryId, "delivery-1");
		assert.deepEqual(seen[0]?.payload, JSON.parse(PING_PAYLOAD));
	} finally {
		await running.close();
	}
});

test("requires the admin token for job inspection", async () => {
	const app = fakeApp();
	const { running, baseUrl } = await startApp(app);
	try {
		const unauthorized = await fetch(`${baseUrl}/api/jobs?repo=acme/app`);
		assert.equal(unauthorized.status, 401);

		const authorized = await fetch(`${baseUrl}/api/jobs?repo=acme/app`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(authorized.status, 200);
		const jobs = ((await authorized.json()) as { jobs: JobSummary[] }).jobs;
		assert.equal(jobs.length, 1);
		assert.equal(jobs[0]?.id, "7");

		const missingRepo = await fetch(`${baseUrl}/api/jobs`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(missingRepo.status, 400);

		const job = await fetch(`${baseUrl}/api/jobs/7`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(job.status, 200);
		assert.equal(((await job.json()) as JobDetail).progressCommentId, 12);

		const missingJob = await fetch(`${baseUrl}/api/jobs/nope`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(missingJob.status, 404);
	} finally {
		await running.close();
	}
});

test("hides admin routes when no token is configured", async () => {
	const app = fakeApp({ config: config({ adminToken: undefined }) });
	const { running, baseUrl } = await startApp(app);
	try {
		const response = await fetch(`${baseUrl}/api/jobs?repo=acme/app`, {
			headers: { authorization: "Bearer anything" },
		});
		assert.equal(response.status, 404);
	} finally {
		await running.close();
	}
});

test("rejects unknown routes and non-POST webhook requests", async () => {
	const app = fakeApp();
	const { running, baseUrl } = await startApp(app);
	try {
		assert.equal((await fetch(`${baseUrl}/nope`)).status, 404);
		assert.equal((await fetch(`${baseUrl}/api/github/webhooks`)).status, 405);
	} finally {
		await running.close();
	}
});

test("serves capabilities and dispatch to the admin token only", async () => {
	const seen: unknown[] = [];
	const app = fakeApp({
		dispatch: async (input) => {
			seen.push(input);
			return { status: 202, body: { ok: true, jobId: "7" } };
		},
	});
	const { running, baseUrl } = await startApp(app);
	try {
		const unauthorized = await fetch(`${baseUrl}/api/capabilities`);
		assert.equal(unauthorized.status, 401);

		const capabilities = await fetch(`${baseUrl}/api/capabilities`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(capabilities.status, 200);
		const listed = (await capabilities.json()) as {
			worker: { name: string };
			capabilities: { name: string }[];
		};
		assert.equal(listed.worker.name, "PiG");
		assert.ok(listed.capabilities.some((entry) => entry.name === "pig.work"));

		const invalid = await fetch(`${baseUrl}/api/dispatch`, {
			method: "POST",
			headers: {
				authorization: "Bearer admin-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({ capability: "pig.status" }),
		});
		assert.equal(invalid.status, 400);

		const dispatched = await fetch(`${baseUrl}/api/dispatch`, {
			method: "POST",
			headers: {
				authorization: "Bearer admin-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				capability: "pig.work",
				params: { repo: "acme/app", instructions: "Add a test" },
				dispatchKey: "console-1",
				actor: "alice",
			}),
		});
		assert.equal(dispatched.status, 202);
		assert.equal(seen.length, 1);
		const input = seen[0] as { capability: string; dispatchKey: string };
		assert.equal(input.capability, "pig.work");
		assert.equal(input.dispatchKey, "console-1");
	} finally {
		await running.close();
	}
});

test("looks up a job by dispatch key", async () => {
	const app = fakeApp();
	const { running, baseUrl } = await startApp(app);
	try {
		const found = await fetch(`${baseUrl}/api/jobs?dispatchKey=k1`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(found.status, 200);
		const detail = (await found.json()) as { job: { id: string } };
		assert.equal(detail.job.id, "7");

		const missing = await fetch(`${baseUrl}/api/jobs?dispatchKey=other`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(missing.status, 404);

		const invalid = await fetch(`${baseUrl}/api/jobs?dispatchKey=bad%20key`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(invalid.status, 400);
	} finally {
		await running.close();
	}
});
