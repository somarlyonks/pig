import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantUnavailableError } from "../src/console/assistant.ts";
import { handleConsoleRequest, consoleServiceFromRuntime } from "../src/console/http.ts";
import { createConsoleRuntime, type ConsoleConfig, type ConsoleRuntime } from "../src/console/runtime.ts";
import { PIG_CAPABILITIES } from "../src/dispatch/capabilities.ts";
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

function config(model: string | null = null): ConsoleConfig {
	return {
		adminToken: "console-token",
		tablePrefix: "console_",
		enrollmentTtlMs: 60 * 60_000,
		observationTtlMs: 15_000,
		dispatchDeadlineMs: 24 * 60 * 60_000,
		workerTimeoutMs: 5_000,
		logLevel: "error",
		model,
		thinking: null,
	};
}

function modelRuntime(text: string) {
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(text)]);
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

function fakeFetch(): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/capabilities") {
			return Response.json({
				worker: { name: "PiG", version: "1.0.0" },
				capabilities: PIG_CAPABILITIES,
			});
		}
		if (url.pathname === "/api/jobs") return Response.json({ jobs: [] });
		if (url.pathname === "/api/dispatch") return Response.json({ ok: true, jobId: "5" }, { status: 202 });
		return Response.json({ error: "not found" }, { status: 404 });
	}) as typeof fetch;
}

async function setup(options: {
	models?: ReturnType<typeof createModels>;
	model?: string | null;
}): Promise<ConsoleRuntime> {
	const runtime = await createConsoleRuntime({
		storage: new MemoryStorage(),
		config: config(options.model ?? null),
		logger: silentLogger(),
		fetch: fakeFetch(),
		now: () => 1_000_000,
		...(options.models ? { models: options.models } : {}),
	});
	const enrollment = await runtime.createEnrollment({ label: "pig" });
	await runtime.registerWorker({
		enrollmentToken: enrollment.token,
		workerId: "pig-a",
		kind: "pig",
		transport: "inbound",
		baseUrl: "https://pig.test",
		repos: ["acme/app"],
		secret: "worker-secret",
	});
	return runtime;
}

test("turns a request into validated proposals without dispatching", async () => {
	const runtime = await setup({
		models: modelRuntime(
			JSON.stringify({
				reply: "I can add that test.",
				proposals: [
					{
						workerId: "pig-a",
						capability: "pig.work",
						params: { repo: "acme/app", instructions: "Add a regression test" },
						rationale: "the parser has no test",
					},
					{
						workerId: "pig-a",
						capability: "pig.work",
						params: { repo: "other/app", instructions: "x" },
						rationale: "out of scope",
					},
					{
						workerId: "ghost",
						capability: "pig.work",
						params: { repo: "acme/app", instructions: "x" },
						rationale: "unknown worker",
					},
				],
			}),
		),
	});
	try {
		const answer = await runtime.assist({ message: "add a test", actor: "alice" });
		assert.equal(answer.proposals.length, 1);
		const proposal = answer.proposals[0];
		assert.equal(proposal?.workerId, "pig-a");
		assert.equal(proposal?.capability, "pig.work");
		assert.equal(proposal?.dispatchKey.startsWith("console:"), true);
		assert.equal(proposal?.rationale, "the parser has no test");
		assert.match(answer.reply, /Dropped 2 unusable proposal/);
		assert.equal(
			(await runtime.state()).dispatches.length,
			0,
			"an assistant answer never dispatches on its own",
		);
	} finally {
		await runtime.shutdown();
	}
});

test("drops a proposal with parameters the worker would reject", async () => {
	const runtime = await setup({
		models: modelRuntime(
			JSON.stringify({
				reply: "ok",
				proposals: [
					{
						workerId: "pig-a",
						capability: "pig.work",
						params: { repo: "acme/app" },
						rationale: "missing instructions",
					},
				],
			}),
		),
	});
	try {
		const answer = await runtime.assist({ message: "do it", actor: "alice" });
		assert.equal(answer.proposals.length, 0);
		assert.match(answer.reply, /instructions is required/);
	} finally {
		await runtime.shutdown();
	}
});

test("reports that no model is configured instead of inventing proposals", async () => {
	const runtime = await setup({});
	try {
		await assert.rejects(
			runtime.assist({ message: "add a test", actor: "alice" }),
			AssistantUnavailableError,
		);
	} finally {
		await runtime.shutdown();
	}
});

test("serves the assistant behind the admin token and fails closed without a model", async () => {
	const runtime = await setup({});
	try {
		const service = consoleServiceFromRuntime(runtime);
		const options = { service, adminToken: "console-token", now: () => 1_000_000 };

		const unauthorized = await handleConsoleRequest(
			new Request("https://console.test/api/assistant", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "hi", actor: "alice" }),
			}),
			options,
		);
		assert.equal(unauthorized.status, 401);

		const unavailable = await handleConsoleRequest(
			new Request("https://console.test/api/assistant", {
				method: "POST",
				headers: {
					authorization: "Bearer console-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ message: "hi", actor: "alice" }),
			}),
			options,
		);
		assert.equal(unavailable.status, 503);
	} finally {
		await runtime.shutdown();
	}
});
