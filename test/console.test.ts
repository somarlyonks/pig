import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { PIG_CAPABILITIES } from "../src/dispatch/capabilities.ts";
import { handleConsoleRequest, consoleServiceFromRuntime } from "../src/console/http.ts";
import {
	createConsoleRuntime,
	hashToken,
	type ConsoleConfig,
	type ConsoleRuntime,
} from "../src/console/runtime.ts";
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

function config(): ConsoleConfig {
	return {
		adminToken: "console-token",
		tablePrefix: "console_",
		enrollmentTtlMs: 60 * 60_000,
		observationTtlMs: 15_000,
		dispatchDeadlineMs: 24 * 60 * 60_000,
		workerTimeoutMs: 5_000,
		logLevel: "error",
		model: null,
		thinking: null,
	};
}

interface Call {
	method: string;
	url: string;
	authorization: string | null;
	body: unknown;
}

const WORKER = "https://pig.test";

function fakeFetch(options: {
	calls: Call[];
	dispatchStatus?: number;
	dispatchBody?: unknown;
	jobs?: { id: string; kind: string; origin: string; status: string; createdAt: number }[];
	lookupJob?: { id: string } | null;
	capabilities?: unknown[];
	capabilitiesStatus?: number;
}): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const authorization = new Headers(init?.headers ?? {}).get("authorization") ?? null;
		options.calls.push({
			method,
			url,
			authorization,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		const parsed = new URL(url);
		if (parsed.pathname === "/api/capabilities") {
			if (options.capabilitiesStatus) {
				return Response.json({ error: "no" }, { status: options.capabilitiesStatus });
			}
			return Response.json({
				worker: { name: "PiG", version: "1.2.3" },
				capabilities: options.capabilities ?? PIG_CAPABILITIES,
			});
		}
		if (parsed.pathname === "/api/dispatch") {
			const status = options.dispatchStatus ?? 202;
			if (status >= 500) {
				return Response.json({ error: "boom" }, { status });
			}
			return Response.json(
				options.dispatchBody ?? { ok: true, jobId: "42" },
				{ status },
			);
		}
		if (parsed.pathname === "/api/jobs" && parsed.searchParams.get("dispatchKey")) {
			return options.lookupJob
				? Response.json({
						job: {
							id: options.lookupJob.id,
							kind: "work",
							status: "running",
							attempts: 1,
							maxAttempts: 2,
							createdAt: 1,
							summary: "",
							error: null,
						},
						repo: "acme/app",
						events: [],
						progressCommentId: null,
						reply: null,
					})
				: Response.json({ error: "job not found" }, { status: 404 });
		}
		if (parsed.pathname === "/api/jobs") {
			return Response.json({ jobs: options.jobs ?? [] });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}) as typeof fetch;
}

async function setup(options: {
	calls: Call[];
	clock?: { value: number };
} & Parameters<typeof fakeFetch>[0]): Promise<{
	runtime: ConsoleRuntime;
	clock: { value: number };
	register(): Promise<void>;
}> {
	const clock = options.clock ?? { value: 1_000_000 };
	const runtime = await createConsoleRuntime({
		storage: new MemoryStorage(),
		config: config(),
		logger: silentLogger(),
		fetch: fakeFetch(options),
		now: () => clock.value,
	});
	const register = async () => {
		const enrollment = await runtime.createEnrollment({ label: "pig" });
		await runtime.registerWorker({
			enrollmentToken: enrollment.token,
			workerId: "pig-a",
			kind: "pig",
			transport: "inbound",
			baseUrl: WORKER,
			repos: ["acme/app"],
			secret: "worker-secret",
		});
	};
	return { runtime, clock, register };
}

test("enrolls a worker and reads its capabilities from the worker", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls });
	try {
		const enrollment = await app.runtime.createEnrollment({ label: "pig" });
		assert.match(enrollment.token, /^enr_/);
		assert.equal(enrollment.expiresAt, 1_000_000 + 60 * 60_000);

		const registered = await app.runtime.registerWorker({
			enrollmentToken: enrollment.token,
			workerId: "pig-a",
			kind: "pig",
			transport: "inbound",
			baseUrl: `${WORKER}/`,
			repos: ["acme/app"],
			secret: "worker-secret",
		});
		const worker = registered.worker;
		assert.match(registered.sessionToken, /^ses_/);
		assert.equal(worker.workerId, "pig-a");
		assert.equal(worker.baseUrl, WORKER);
		assert.equal(worker.version, "1.2.3");
		assert.deepEqual(
			worker.capabilities.map((capability) => capability.name),
			PIG_CAPABILITIES.map((capability) => capability.name),
		);

		const described = calls.find((call) => call.url.endsWith("/api/capabilities"));
		assert.equal(described?.authorization, "Bearer worker-secret");

		const workers = await app.runtime.listWorkers();
		assert.equal(workers.length, 1);
		assert.deepEqual(workers[0]?.repos, ["acme/app"]);

		await assert.rejects(
			app.runtime.registerWorker({
				enrollmentToken: enrollment.token,
				workerId: "pig-b",
				kind: "pig",
				transport: "inbound",
				baseUrl: WORKER,
				repos: ["acme/app"],
				secret: "s",
			}),
			/already used/,
		);
	} finally {
		await app.runtime.shutdown();
	}
});

test("rejects enrollment tokens that are unknown, expired, or unanswerable", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls, capabilitiesStatus: 401 });
	try {
		await assert.rejects(
			app.runtime.registerWorker({
				enrollmentToken: "enr_nope",
				workerId: "pig-a",
				kind: "pig",
				transport: "inbound",
				baseUrl: WORKER,
				repos: ["acme/app"],
				secret: "s",
			}),
			/unknown enrollment token/,
		);

		const enrollment = await app.runtime.createEnrollment({
			label: "pig",
			ttlMs: 1_000,
		});
		app.clock.value += 5_000;
		await assert.rejects(
			app.runtime.registerWorker({
				enrollmentToken: enrollment.token,
				workerId: "pig-a",
				kind: "pig",
				transport: "inbound",
				baseUrl: WORKER,
				repos: ["acme/app"],
				secret: "s",
			}),
			/expired/,
		);

		const reachable = await app.runtime.createEnrollment({ label: "pig" });
		await assert.rejects(
			app.runtime.registerWorker({
				enrollmentToken: reachable.token,
				workerId: "pig-a",
				kind: "pig",
				transport: "inbound",
				baseUrl: WORKER,
				repos: ["acme/app"],
				secret: "s",
			}),
			/did not answer/,
		);
	} finally {
		await app.runtime.shutdown();
	}
});

test("dispatches a command with a stable key and records the job", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls });
	try {
		await app.register();
		const result = await app.runtime.submit({
			workerId: "pig-a",
			capability: "pig.work",
			params: { repo: "acme/app", instructions: "Add a test" },
			actor: "alice",
			proposalId: "draft-1",
		});
		assert.equal(result.status, 202);
		const dispatch = result.body.dispatch as { dispatchKey: string; state: string; jobId: string };
		assert.equal(dispatch.dispatchKey, "console:draft-1");
		assert.equal(dispatch.state, "accepted");
		assert.equal(dispatch.jobId, "42");

		const sent = calls.find((call) => call.method === "POST" && call.url.endsWith("/api/dispatch"));
		assert.equal(sent?.authorization, "Bearer worker-secret");
		const body = sent?.body as { dispatchKey: string; actor: string; params: unknown };
		assert.equal(body.dispatchKey, "console:draft-1");
		assert.equal(body.actor, "alice");
		assert.deepEqual(body.params, { repo: "acme/app", instructions: "Add a test" });

		const replay = await app.runtime.submit({
			workerId: "pig-a",
			capability: "pig.work",
			params: { repo: "acme/app", instructions: "Add a test" },
			actor: "alice",
			proposalId: "draft-1",
		});
		assert.equal(replay.status, 200);
		assert.equal(replay.body.duplicate, true);
		assert.equal(
			calls.filter((call) => call.method === "POST" && call.url.endsWith("/api/dispatch")).length,
			1,
		);
	} finally {
		await app.runtime.shutdown();
	}
});

test("requires confirmation for dangerous capabilities", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls });
	try {
		await app.register();
		const unconfirmed = await app.runtime.submit({
			workerId: "pig-a",
			capability: "pig.release",
			params: { repo: "acme/app" },
			actor: "alice",
			proposalId: "draft-release",
		});
		assert.equal(unconfirmed.status, 409);
		assert.equal(unconfirmed.body.requiresConfirmation, true);
		assert.equal(
			calls.filter((call) => call.method === "POST" && call.url.endsWith("/api/dispatch")).length,
			0,
		);
		assert.equal(await app.runtime.lookup("console:draft-release"), null);

		const confirmed = await app.runtime.submit({
			workerId: "pig-a",
			capability: "pig.release",
			params: { repo: "acme/app" },
			actor: "alice",
			proposalId: "draft-release",
			confirm: true,
		});
		assert.equal(confirmed.status, 202);
	} finally {
		await app.runtime.shutdown();
	}
});

test("rejects commands outside the registered scope", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls });
	try {
		await app.register();
		const wrongRepo = await app.runtime.submit({
			workerId: "pig-a",
			capability: "pig.work",
			params: { repo: "other/app", instructions: "x" },
			actor: "alice",
		});
		assert.equal(wrongRepo.status, 403);

		const wrongCapability = await app.runtime.submit({
			workerId: "pig-a",
			capability: "pig.deploy",
			params: { repo: "acme/app" },
			actor: "alice",
		});
		assert.equal(wrongCapability.status, 400);

		const unknownWorker = await app.runtime.submit({
			workerId: "nobody",
			capability: "pig.work",
			params: { repo: "acme/app" },
			actor: "alice",
		});
		assert.equal(unknownWorker.status, 404);
	} finally {
		await app.runtime.shutdown();
	}
});

test("an unknown outcome stays submitted and is resolved by dispatch-key lookup", async () => {
	const calls: Call[] = [];
	const unresolved = await setup({ calls, dispatchStatus: 503, lookupJob: null });
	try {
		await unresolved.register();
		const result = await unresolved.runtime.submit({
			workerId: "pig-a",
			capability: "pig.work",
			params: { repo: "acme/app", instructions: "x" },
			actor: "alice",
			proposalId: "draft-unknown",
		});
		assert.equal(result.status, 502);
		assert.equal(result.body.dispatchKey, "console:draft-unknown");
		const pending = result.body.dispatch as { state: string; error: string };
		assert.equal(pending.state, "submitted");
		assert.match(pending.error, /boom/);
		assert.equal((await unresolved.runtime.lookup("console:draft-unknown"))?.state, "submitted");
	} finally {
		await unresolved.runtime.shutdown();
	}

	const settled = await setup({ calls, dispatchStatus: 503, lookupJob: { id: "99" } });
	try {
		await settled.register();
		const result = await settled.runtime.submit({
			workerId: "pig-a",
			capability: "pig.work",
			params: { repo: "acme/app", instructions: "x" },
			actor: "alice",
			proposalId: "draft-settled",
		});
		assert.equal(result.status, 502);
		const accepted = result.body.dispatch as { state: string; jobId: string };
		assert.equal(accepted.state, "accepted");
		assert.equal(accepted.jobId, "99");
	} finally {
		await settled.runtime.shutdown();
	}
});

test("observes worker jobs and caches them until the TTL elapses", async () => {
	const calls: Call[] = [];
	const app = await setup({
		calls,
		jobs: [
			{ id: "7", kind: "work", origin: "console", status: "running", createdAt: 20 },
			{ id: "6", kind: "review", origin: "github", status: "succeeded", createdAt: 10 },
		],
	});
	try {
		await app.register();
		const first = await app.runtime.state({ refresh: true });
		assert.equal(first.jobs.length, 2);
		assert.equal(first.jobs[0]?.job.id, "7");
		assert.equal(first.workers[0]?.observations[0]?.ok, true);

		const jobCalls = () =>
			calls.filter((call) => call.url.includes("/api/jobs") && call.url.includes("repo="));
		assert.equal(jobCalls().length, 1);

		await app.runtime.state({ refresh: true });
		assert.equal(jobCalls().length, 1, "a fresh observation is reused inside the TTL");

		app.clock.value += 60_000;
		await app.runtime.state({ refresh: true });
		assert.equal(jobCalls().length, 2);
	} finally {
		await app.runtime.shutdown();
	}
});

test("records observation errors instead of failing the board", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls, dispatchStatus: 202 });
	try {
		await app.register();
		const broken = await createConsoleRuntime({
			storage: new MemoryStorage(),
			config: config(),
			logger: silentLogger(),
			fetch: (async () =>
				Response.json({ error: "offline" }, { status: 503 })) as typeof fetch,
			now: () => 1_000_000,
		});
		try {
			const enrollment = await broken.createEnrollment({ label: "pig" });
			await assert.rejects(
				broken.registerWorker({
					enrollmentToken: enrollment.token,
					workerId: "pig-offline",
					kind: "pig",
					transport: "inbound",
					baseUrl: WORKER,
					repos: ["acme/app"],
					secret: "s",
				}),
				/did not answer/,
			);
		} finally {
			await broken.shutdown();
		}
	} finally {
		await app.runtime.shutdown();
	}
});

test("serves the console API behind the admin token", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls });
	try {
		await app.register();
		const service = consoleServiceFromRuntime(app.runtime);
		const options = { service, adminToken: "console-token", now: () => 1_000_000 };

		const unauthorized = await handleConsoleRequest(
			new Request("https://console.test/api/state"),
			options,
		);
		assert.equal(unauthorized.status, 401);

		const state = await handleConsoleRequest(
			new Request("https://console.test/api/state", {
				headers: { authorization: "Bearer console-token" },
			}),
			options,
		);
		assert.equal(state.status, 200);
		const body = (await state.json()) as { workers: { workerId: string }[] };
		assert.equal(body.workers[0]?.workerId, "pig-a");

		const enrolled = await handleConsoleRequest(
			new Request("https://console.test/api/enrollments", {
				method: "POST",
				headers: {
					authorization: "Bearer console-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ label: "second" }),
			}),
			options,
		);
		assert.equal(enrolled.status, 201);
		const enrollment = (await enrolled.json()) as { token: string };
		assert.match(enrollment.token, /^enr_/);

		const commands = await handleConsoleRequest(
			new Request("https://console.test/api/commands", {
				method: "POST",
				headers: {
					authorization: "Bearer console-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					workerId: "pig-a",
					capability: "pig.status",
					actor: "alice",
					params: { repo: "acme/app" },
					proposalId: "draft-status",
				}),
			}),
			options,
		);
		assert.equal(commands.status, 202);

		const dispatch = await handleConsoleRequest(
			new Request("https://console.test/api/dispatches/console%3Adraft-status", {
				headers: { authorization: "Bearer console-token" },
			}),
			options,
		);
		assert.equal(dispatch.status, 200);
	} finally {
		await app.runtime.shutdown();
	}
});

test("derives dispatch keys from proposal ids and hashes enrollment tokens", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls });
	try {
		const enrollment = await app.runtime.createEnrollment({ label: "pig" });
		const digest = await hashToken(enrollment.token);
		assert.match(digest, /^[0-9a-f]{64}$/);
		assert.notEqual(digest, enrollment.token);
	} finally {
		await app.runtime.shutdown();
	}
});

void BACKGROUND_CONTEXT;

async function registerOutbound(
	runtime: ConsoleRuntime,
	workerId = "pig-mac",
): Promise<string> {
	const enrollment = await runtime.createEnrollment({ label: "mac" });
	const registered = await runtime.registerWorker({
		enrollmentToken: enrollment.token,
		workerId,
		kind: "pig",
		version: "0.1.0",
		transport: "outbound",
		baseUrl: "http://127.0.0.1:1",
		repos: ["acme/app"],
		secret: "worker-secret",
		capabilities: PIG_CAPABILITIES,
	});
	return registered.sessionToken;
}

test("an outbound worker declares capabilities instead of being probed", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls });
	try {
		const sessionToken = await registerOutbound(app.runtime);
		assert.match(sessionToken, /^ses_/);
		assert.equal(
			calls.filter((call) => call.url.endsWith("/api/capabilities")).length,
			0,
		);
		const workers = await app.runtime.listWorkers();
		assert.equal(workers[0]?.transport, "outbound");
		assert.ok(workers[0]?.capabilities.some((entry) => entry.name === "pig.work"));

		const enrollment = await app.runtime.createEnrollment({ label: "mac" });
		await assert.rejects(
			app.runtime.registerWorker({
				enrollmentToken: enrollment.token,
				workerId: "pig-mac-2",
				kind: "pig",
				transport: "outbound",
				baseUrl: "http://127.0.0.1:1",
				repos: ["acme/app"],
				secret: "s",
			}),
			/must declare its capabilities/,
		);
	} finally {
		await app.runtime.shutdown();
	}
});

test("queues a command for an outbound worker and delivers it on poll", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls });
	try {
		const sessionToken = await registerOutbound(app.runtime);
		const submitted = await app.runtime.submit({
			workerId: "pig-mac",
			capability: "pig.work",
			params: { repo: "acme/app", instructions: "Add a test" },
			actor: "alice",
			proposalId: "mac-1",
		});
		assert.equal(submitted.status, 202);
		assert.equal(submitted.body.queued, true);
		assert.equal(
			calls.filter((call) => call.method === "POST" && call.url.endsWith("/api/dispatch")).length,
			0,
		);

		await assert.rejects(
			app.runtime.pollSession({ workerId: "pig-mac", token: "ses_wrong", cursor: 0, waitMs: 0 }),
			/invalid session token/,
		);

		const first = await app.runtime.pollSession({
			workerId: "pig-mac",
			token: sessionToken,
			cursor: 0,
			waitMs: 0,
		});
		assert.equal(first.commands.length, 1);
		assert.equal(first.commands[0]?.dispatchKey, "console:mac-1");
		assert.equal(first.commands[0]?.capability, "pig.work");
		assert.equal(first.commands[0]?.actor, "alice");
		assert.ok(first.cursor > 0);

		const second = await app.runtime.pollSession({
			workerId: "pig-mac",
			token: sessionToken,
			cursor: first.cursor,
			waitMs: 0,
		});
		assert.equal(second.commands.length, 0);

		const acked = await app.runtime.ackSession({
			workerId: "pig-mac",
			token: sessionToken,
			results: [{ dispatchKey: "console:mac-1", jobId: "77", error: null }],
		});
		assert.equal(acked.updated, 1);
		const accepted = await app.runtime.lookup("console:mac-1");
		assert.equal(accepted?.state, "accepted");
		assert.equal(accepted?.jobId, "77");

		const ignored = await app.runtime.ackSession({
			workerId: "pig-mac",
			token: sessionToken,
			results: [{ dispatchKey: "console:mac-1", jobId: "77", error: null }],
		});
		assert.equal(ignored.updated, 0);

		const third = await app.runtime.pollSession({
			workerId: "pig-mac",
			token: sessionToken,
			cursor: 0,
			waitMs: 0,
		});
		assert.equal(third.commands.length, 0, "an accepted command is not redelivered");
	} finally {
		await app.runtime.shutdown();
	}
});

test("an outbound worker reports its own observations", async () => {
	const calls: Call[] = [];
	const app = await setup({ calls });
	try {
		const sessionToken = await registerOutbound(app.runtime);
		const reported = await app.runtime.reportSession({
			workerId: "pig-mac",
			token: sessionToken,
			reports: [
				{
					repo: "acme/app",
					jobs: [
						{
							id: "9",
							kind: "work",
							origin: "console",
							status: "running",
							attempts: 1,
							maxAttempts: 2,
							createdAt: 5,
							summary: "",
							error: null,
						},
					],
				},
				{ repo: "other/app", jobs: [] },
			],
		});
		assert.equal(reported.recorded, 1, "a repository outside the scope is not recorded");

		const state = await app.runtime.state({ refresh: true });
		assert.equal(state.jobs.length, 1);
		assert.equal(state.jobs[0]?.workerId, "pig-mac");
		assert.equal(state.workers[0]?.observations[0]?.ok, true);
		assert.equal(
			calls.filter((call) => call.url.includes("/api/jobs")).length,
			0,
			"an outbound worker is never dialled",
		);

		await assert.rejects(
			app.runtime.reportSession({
				workerId: "pig-mac",
				token: "ses_wrong",
				reports: [],
			}),
			/invalid session token/,
		);
	} finally {
		await app.runtime.shutdown();
	}
});
