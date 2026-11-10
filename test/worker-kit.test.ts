import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerKit } from "../src/worker-kit/kit.ts";
import { validateParameters } from "../src/worker-kit/validate.ts";
import { memoryIdempotencyStore } from "../src/worker-kit/types.ts";
import type { CapabilityDescriptor } from "../src/dispatch/capabilities.ts";

const CHAT_CAPABILITY: CapabilityDescriptor = {
	name: "chat.message",
	description: "Send a message to the local agent.",
	scope: "repository",
	dangerous: false,
	parameters: [
		{ name: "conversation", type: "string", required: true, description: "Conversation id" },
		{ name: "text", type: "string", required: true, description: "Message text" },
		{
			name: "mode",
			type: "string",
			required: false,
			description: "Reply mode",
			values: ["reply", "quiet"],
		},
	],
};

function kit(executions: unknown[] = []) {
	return createWorkerKit({
		name: "mac-agent",
		version: "0.1.0",
		secret: "worker-secret",
		now: () => 1_000,
		store: memoryIdempotencyStore(),
		handlers: [
			{
				capability: CHAT_CAPABILITY,
				execute: async (params) => {
					executions.push(params);
					return { jobId: "chat-1" };
				},
			},
		],
	});
}

function dispatchRequest(body: unknown, token = "worker-secret"): Request {
	return new Request("https://mac.test/api/dispatch", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const COMMAND = {
	capability: "chat.message",
	dispatchKey: "console:1",
	actor: "alice",
	params: { conversation: "c1", text: "hello" },
};

test("publishes declared capabilities to the console", async () => {
	const worker = kit();
	const response = await worker.handle(
		new Request("https://mac.test/api/capabilities", {
			headers: { authorization: "Bearer worker-secret" },
		}),
	);
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		worker: { name: string; version: string };
		capabilities: CapabilityDescriptor[];
	};
	assert.equal(body.worker.name, "mac-agent");
	assert.equal(body.capabilities[0]?.name, "chat.message");
});

test("rejects a wrong token and hides the worker without a secret", async () => {
	const worker = kit();
	const unauthorized = await worker.handle(
		new Request("https://mac.test/api/capabilities", {
			headers: { authorization: "Bearer nope" },
		}),
	);
	assert.equal(unauthorized.status, 401);

	const disabled = createWorkerKit({
		name: "mac-agent",
		version: "0.1.0",
		secret: undefined,
		handlers: [],
	});
	const hidden = await disabled.handle(
		new Request("https://mac.test/api/capabilities"),
	);
	assert.equal(hidden.status, 404);
});

test("runs a declared capability and returns its job id", async () => {
	const executions: unknown[] = [];
	const worker = kit(executions);
	const response = await worker.handle(dispatchRequest(COMMAND));
	assert.equal(response.status, 202);
	const body = (await response.json()) as { ok: boolean; jobId: string };
	assert.equal(body.jobId, "chat-1");
	assert.deepEqual(executions[0], { conversation: "c1", text: "hello" });
});

test("deduplicates a dispatch key and never runs it twice", async () => {
	const executions: unknown[] = [];
	const worker = kit(executions);
	const first = await worker.handle(dispatchRequest(COMMAND));
	assert.equal(first.status, 202);
	const replay = await worker.handle(dispatchRequest(COMMAND));
	assert.equal(replay.status, 200);
	const body = (await replay.json()) as { duplicate: boolean; jobId: string };
	assert.equal(body.duplicate, true);
	assert.equal(body.jobId, "chat-1");
	assert.equal(executions.length, 1);
});

test("rejects unknown capabilities, bad parameters, and expired commands", async () => {
	const worker = kit();

	const unknown = await worker.handle(
		dispatchRequest({ ...COMMAND, capability: "chat.other" }),
	);
	assert.equal(unknown.status, 400);

	const missing = await worker.handle(
		dispatchRequest({ ...COMMAND, params: { conversation: "c1" } }),
	);
	assert.equal(missing.status, 400);
	assert.match(((await missing.json()) as { error: string }).error, /text is required/);

	const wrongEnum = await worker.handle(
		dispatchRequest({ ...COMMAND, params: { ...COMMAND.params, mode: "loud" } }),
	);
	assert.equal(wrongEnum.status, 400);

	const expired = await worker.handle(
		dispatchRequest({ ...COMMAND, dispatchKey: "console:old", notAfter: 1 }),
	);
	assert.equal(expired.status, 410);
});

test("reports a handler failure without storing the key", async () => {
	let attempts = 0;
	const worker = createWorkerKit({
		name: "mac-agent",
		version: "0.1.0",
		secret: "worker-secret",
		now: () => 1_000,
		handlers: [
			{
				capability: CHAT_CAPABILITY,
				execute: async () => {
					attempts += 1;
					if (attempts === 1) throw new Error("model offline");
					return { jobId: "chat-2" };
				},
			},
		],
	});

	const failed = await worker.handle(dispatchRequest(COMMAND));
	assert.equal(failed.status, 500);
	assert.match(((await failed.json()) as { error: string }).error, /model offline/);

	const retried = await worker.handle(dispatchRequest(COMMAND));
	assert.equal(retried.status, 202);
	assert.equal(attempts, 2, "a failed dispatch is not remembered as done");
});

test("validates parameters from the descriptor", () => {
	assert.equal(validateParameters(CHAT_CAPABILITY, { conversation: "c", text: "t" }), null);
	assert.match(
		validateParameters(CHAT_CAPABILITY, { conversation: "c" }) ?? "",
		/text is required/,
	);
	assert.match(
		validateParameters(CHAT_CAPABILITY, { conversation: 1, text: "t" }) ?? "",
		/conversation must be a string/,
	);
	assert.match(
		validateParameters(CHAT_CAPABILITY, { conversation: "c", text: "t", mode: "loud" }) ?? "",
		/mode must be one of/,
	);
});
