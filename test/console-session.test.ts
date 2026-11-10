import { test } from "node:test";
import assert from "node:assert/strict";
import { runConsoleSession, type SessionOptions } from "../src/console/session-client.ts";
import type { WebhookResult } from "../src/durable/admission.ts";
import type { Logger } from "../src/logger.ts";

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

interface Call {
	method: string;
	path: string;
	authorization: string | null;
	body: unknown;
	waitMs: string | null;
	cursor: string | null;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

const COMMAND = {
	seq: 4,
	dispatchKey: "console:mac-1",
	capability: "pig.work",
	params: { repo: "acme/app", instructions: "Add a test" },
	actor: "alice",
	notAfter: null,
};

function sessionOptions(
	options: Partial<SessionOptions> & { polls: (() => Response)[] },
): { options: SessionOptions; calls: Call[]; sleeps: number[] } {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	let pollIndex = 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const call: Call = {
			method: init?.method ?? "GET",
			path: url.pathname,
			authorization: new Headers(init?.headers ?? {}).get("authorization"),
			body: init?.body ? JSON.parse(String(init.body)) : null,
			waitMs: url.searchParams.get("waitMs"),
			cursor: url.searchParams.get("cursor"),
		};
		calls.push(call);
		if (url.pathname === "/api/session/report") return json({ recorded: 1 });
		if (url.pathname === "/api/session/ack") return json({ updated: 1 });
		if (url.pathname === "/api/session/commands") {
			const next = options.polls[Math.min(pollIndex, options.polls.length - 1)];
			pollIndex += 1;
			return next ? next() : json({ commands: [], cursor: 0, pollAfterMs: 0 });
		}
		return json({ error: "not found" }, 404);
	}) as typeof fetch;

	const controller = new AbortController();
	return {
		calls,
		sleeps,
		options: {
			consoleBaseUrl: "https://console.test/",
			workerId: "pig-mac",
			token: "ses_token",
			repos: ["acme/app"],
			fetch: fetchImpl,
			dispatch: async (): Promise<WebhookResult> => ({
				status: 202,
				body: { ok: true, jobId: "77" },
			}),
			listJobs: async () => [{ id: "9" }],
			logger: silentLogger(),
			signal: controller.signal,
			reportEveryMs: 0,
			waitMs: 1000,
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
			...options,
			...(options.sleep ? { sleep: options.sleep } : {}),
		} as SessionOptions,
	};
}

test("polls a console, admits the command, and acknowledges the job", async () => {
	const dispatches: unknown[] = [];
	const { options, calls } = sessionOptions({
		polls: [
			() => json({ commands: [COMMAND], cursor: 4, pollAfterMs: 0 }),
			() => json({ commands: [], cursor: 4, pollAfterMs: 0 }),
			() => json({ error: "invalid session token" }, 401),
		],
	});
	options.dispatch = async (input) => {
		dispatches.push(input);
		return { status: 202, body: { ok: true, jobId: "77" } };
	};

	await runConsoleSession(options);

	assert.equal(dispatches.length, 1);
	const dispatched = dispatches[0] as {
		capability: string;
		dispatchKey: string;
		actor: string;
		params: unknown;
	};
	assert.equal(dispatched.dispatchKey, "console:mac-1");
	assert.equal(dispatched.actor, "alice");
	assert.deepEqual(dispatched.params, { repo: "acme/app", instructions: "Add a test" });

	const report = calls.find((call) => call.path === "/api/session/report");
	assert.ok(report, "observations are pushed to the console");
	assert.equal(report?.authorization, "Bearer ses_token");

	const ack = calls.find((call) => call.path === "/api/session/ack");
	const ackBody = ack?.body as {
		workerId: string;
		results: { dispatchKey: string; jobId: string; error: null }[];
	};
	assert.equal(ackBody.workerId, "pig-mac");
	assert.deepEqual(ackBody.results, [
		{ dispatchKey: "console:mac-1", jobId: "77", error: null },
	]);

	const polls = calls.filter((call) => call.path === "/api/session/commands");
	assert.equal(polls[0]?.cursor, "0");
	assert.equal(polls[1]?.cursor, "4", "the worker owns the cursor");
	assert.equal(polls[0]?.waitMs, "1000");
});

test("reports a rejected command instead of a job", async () => {
	const acks: unknown[] = [];
	const { options, calls } = sessionOptions({
		polls: [() => json({ commands: [COMMAND], cursor: 4, pollAfterMs: 0 }), () => json({}, 401)],
	});
	options.dispatch = async () => ({
		status: 400,
		body: { error: "params.repo must be owner/name" },
	});

	await runConsoleSession(options);

	const ack = calls.find((call) => call.path === "/api/session/ack");
	const body = ack?.body as { results: { error: string; jobId: null }[] };
	assert.equal(body.results[0]?.jobId, null);
	assert.match(body.results[0]?.error ?? "", /owner\/name/);
	void acks;
});

test("pauses the session when the console rejects the credential", async () => {
	const { options, calls } = sessionOptions({
		polls: [() => json({ commands: [], cursor: 0, pollAfterMs: 0 }), () => json({}, 401)],
	});
	await runConsoleSession(options);
	assert.equal(
		calls.filter((call) => call.path === "/api/session/commands").length,
		2,
	);
});

test("backs off on console errors and stops when aborted", async () => {
	const controller = new AbortController();
	const polls: number[] = [];
	const { options, sleeps } = sessionOptions({
		polls: [() => json({ error: "boom" }, 503)],
	});
	options.signal = controller.signal;
	options.sleep = async (ms) => {
		sleeps.push(ms);
		controller.abort();
	};
	options.fetch = (async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/session/report") return json({ recorded: 1 });
		polls.push(1);
		return json({ error: "boom" }, 503);
	}) as typeof fetch;

	await runConsoleSession(options);
	assert.equal(polls.length, 1);
	assert.equal(sleeps[0], 1_000, "the first retry waits one second");
});
