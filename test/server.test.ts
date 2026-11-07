import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { JobStore } from "../src/jobs/store.ts";
import type { AppConfig } from "../src/config.ts";
import type { Logger } from "../src/logger.ts";
import { startHttpServer, type RunningServer } from "../src/server.ts";
import { handleWebhook } from "../src/webhooks/handler.ts";

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
		piBin: "pi",
		maxConcurrency: 1,
		jobTimeoutMs: 60_000,
		leaseMs: 120_000,
		heartbeatMs: 20_000,
		logLevel: "error",
		adminToken: "admin-token",
		...overrides,
	};
}

async function startApp(overrides: Partial<AppConfig> = {}): Promise<{
	store: JobStore;
	running: RunningServer;
	baseUrl: string;
}> {
	const store = new JobStore(":memory:");
	const logger = silentLogger();
	const settings = config(overrides);
	const running = await startHttpServer({
		config: settings,
		store,
		logger,
		version: "test",
		handleWebhook: (input) =>
			handleWebhook({ store, logger, appSlug: settings.appSlug }, input),
	});
	const address = running.server.address() as AddressInfo;
	return { store, running, baseUrl: `http://127.0.0.1:${address.port}` };
}

function sign(body: string, secret = SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const PING_PAYLOAD = JSON.stringify({ zen: "Non-blocking is better than blocking." });

test("serves health and root metadata", async () => {
	const app = await startApp();
	try {
		const health = await fetch(`${app.baseUrl}/healthz`);
		assert.equal(health.status, 200);
		assert.equal((await health.json() as { ok: boolean }).ok, true);

		const root = await fetch(`${app.baseUrl}/`);
		assert.equal(root.status, 200);
		assert.equal((await root.json() as { name: string }).name, "PiG");
	} finally {
		await app.running.close();
		app.store.close();
	}
});

test("rejects webhooks without a valid signature", async () => {
	const app = await startApp();
	try {
		const missing = await fetch(`${app.baseUrl}/api/github/webhooks`, {
			method: "POST",
			headers: { "x-github-event": "ping", "x-github-delivery": "d1" },
			body: PING_PAYLOAD,
		});
		assert.equal(missing.status, 401);

		const wrongSecret = await fetch(`${app.baseUrl}/api/github/webhooks`, {
			method: "POST",
			headers: {
				"x-github-event": "ping",
				"x-github-delivery": "d2",
				"x-hub-signature-256": sign(PING_PAYLOAD, "wrong"),
			},
			body: PING_PAYLOAD,
		});
		assert.equal(wrongSecret.status, 401);

		const malformed = await fetch(`${app.baseUrl}/api/github/webhooks`, {
			method: "POST",
			headers: {
				"x-github-event": "ping",
				"x-github-delivery": "d3",
				"x-hub-signature-256": "sha256=not-a-digest",
			},
			body: PING_PAYLOAD,
		});
		assert.equal(malformed.status, 401);
		assert.equal(app.store.hasDelivery("d1"), false);
	} finally {
		await app.running.close();
		app.store.close();
	}
});

test("accepts a valid webhook and deduplicates deliveries", async () => {
	const app = await startApp();
	try {
		const send = () =>
			fetch(`${app.baseUrl}/api/github/webhooks`, {
				method: "POST",
				headers: {
					"x-github-event": "ping",
					"x-github-delivery": "delivery-1",
					"x-hub-signature-256": sign(PING_PAYLOAD),
				},
				body: PING_PAYLOAD,
			});

		const first = await send();
		assert.equal(first.status, 202);
		assert.equal((await first.json() as { ignored: string }).ignored, "ping");
		assert.equal(app.store.hasDelivery("delivery-1"), true);

		const duplicate = await send();
		assert.equal(duplicate.status, 202);
		assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);
	} finally {
		await app.running.close();
		app.store.close();
	}
});

test("requires the admin token for job inspection", async () => {
	const app = await startApp();
	try {
		const unauthorized = await fetch(`${app.baseUrl}/api/jobs?repo=acme/app`);
		assert.equal(unauthorized.status, 401);

		const authorized = await fetch(`${app.baseUrl}/api/jobs?repo=acme/app`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(authorized.status, 200);
		assert.deepEqual((await authorized.json() as { jobs: unknown[] }).jobs, []);

		const missingJob = await fetch(`${app.baseUrl}/api/jobs/nope`, {
			headers: { authorization: "Bearer admin-token" },
		});
		assert.equal(missingJob.status, 404);
	} finally {
		await app.running.close();
		app.store.close();
	}
});

test("hides admin routes when no token is configured", async () => {
	const app = await startApp({ adminToken: undefined });
	try {
		const response = await fetch(`${app.baseUrl}/api/jobs?repo=acme/app`, {
			headers: { authorization: "Bearer anything" },
		});
		assert.equal(response.status, 404);
	} finally {
		await app.running.close();
		app.store.close();
	}
});

test("rejects unknown routes and non-POST webhook requests", async () => {
	const app = await startApp();
	try {
		assert.equal((await fetch(`${app.baseUrl}/nope`)).status, 404);
		assert.equal((await fetch(`${app.baseUrl}/api/github/webhooks`)).status, 405);
	} finally {
		await app.running.close();
		app.store.close();
	}
});
