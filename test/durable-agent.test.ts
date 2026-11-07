import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineTask,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { runDurableAgent } from "../src/durable/agent.ts";
import { JobDoc } from "../src/durable/docs.ts";
import { ModelResolutionError, resolveModel } from "../src/durable/models.ts";
import {
	buildShellEnvironment,
	isAllowedReviewWritePath,
	ReviewTools,
	WorkTools,
} from "../src/durable/tools.ts";
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

test("resolves provider-qualified, bare, and default models", async () => {
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
	const models = createModels();
	models.setProvider(faux.provider);

	const bare = await resolveModel(models, "faux-1", null);
	assert.deepEqual(bare.ref, { provider: "faux", modelId: "faux-1" });
	assert.equal(bare.thinking, null);

	const qualified = await resolveModel(models, "faux/faux-1:high", null);
	assert.deepEqual(qualified.ref, { provider: "faux", modelId: "faux-1" });
	assert.equal(qualified.thinking, "high");

	const withThinking = await resolveModel(models, "faux-2", "low");
	assert.equal(withThinking.thinking, "low");

	const fallback = await resolveModel(models, null, null);
	assert.deepEqual(fallback.ref, { provider: "faux", modelId: "faux-1" });

	const fuzzy = await resolveModel(models, "faux", null);
	assert.deepEqual(fuzzy.ref, { provider: "faux", modelId: "faux-1" });
});

test("rejects unknown models and invalid thinking levels", async () => {
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	await assert.rejects(
		() => resolveModel(models, "missing-model", null),
		(error: unknown) => error instanceof ModelResolutionError && /Could not find model/.test(error.message),
	);
	await assert.rejects(
		() => resolveModel(models, "faux-1", "ultra"),
		(error: unknown) => error instanceof ModelResolutionError && /Invalid thinking level/.test(error.message),
	);
	await assert.rejects(
		() => resolveModel(models, "faux-1:ultra", null),
		(error: unknown) => error instanceof ModelResolutionError && /Could not find model/.test(error.message),
	);
});

test("builds a minimal shell environment for agent commands", () => {
	const environment = buildShellEnvironment({
		PATH: "/usr/bin",
		HOME: "/home/agent",
		PIG_GITHUB_PRIVATE_KEY: "private",
		PIG_WEBHOOK_SECRET: "secret",
		GITHUB_TOKEN: "github",
		GH_TOKEN: "gh",
		ANTHROPIC_API_KEY: "model-key",
		NPM_TOKEN: "npm",
		AWS_SECRET_ACCESS_KEY: "aws",
		CI: "false",
	});
	assert.equal(environment.PATH, "/usr/bin");
	assert.equal(environment.HOME, "/home/agent");
	assert.equal(environment.PIG_GITHUB_PRIVATE_KEY, undefined);
	assert.equal(environment.PIG_WEBHOOK_SECRET, undefined);
	assert.equal(environment.GITHUB_TOKEN, undefined);
	assert.equal(environment.GH_TOKEN, undefined);
	assert.equal(environment.ANTHROPIC_API_KEY, undefined);
	assert.equal(environment.NPM_TOKEN, undefined);
	assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(environment.CI, "1");
	assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
});

test("review jobs may write only their result file", () => {
	assert.equal(isAllowedReviewWritePath(".pig/review.json"), true);
	assert.equal(isAllowedReviewWritePath("./.pig/review.json"), true);
	assert.equal(isAllowedReviewWritePath(".pig/result.json"), false);
	assert.equal(isAllowedReviewWritePath("src/app.ts"), false);
	assert.equal(isAllowedReviewWritePath("../review.json"), false);
	assert.equal(isAllowedReviewWritePath("/tmp/review.json"), false);
	assert.equal(isAllowedReviewWritePath(".pig/../review.json"), false);
});

test("runs a durable conversation and returns the assistant answer", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pig-agent-"));
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage("the durable answer")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(WorkTools);
	registry.install(ReviewTools);

	let harness: Harness;
	const logger = silentLogger();

	const Probe = defineTask<Record<string, never>, { phase: "run" }, { text: string }>({
		name: "probe.agent",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const result = await runDurableAgent(
					{
						harness,
						jobId: String(task.id),
						taskId: task.id,
						attempt: 1,
						model: { provider: "faux", modelId: "faux-1" },
						thinking: null,
						maxTurns: 5,
						instructions: "Answer the user.",
						logger,
					},
					{
						cwd: workspace,
						prompt: "Say something.",
						tools: "review",
						timeoutMs: 5_000,
						signal: runtime.signal,
					},
					context,
				);
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: { text: result.finalText } },
					}),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) =>
			runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				context,
			),
	});
	registry.install({ name: "probe-agent", tasks: [Probe] });

	harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { extensions: [] } },
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT);
	const id = await harness.commit(
		(tx) =>
			tx.createTask(Probe, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
		BACKGROUND_CONTEXT,
	);
	try {
		const settled = await harness.waitForTask(id, BACKGROUND_CONTEXT);
		assert.equal(settled.state.outcome.status, "completed");
		assert.equal(
			settled.state.outcome.status === "completed" ? settled.state.outcome.result.text : "",
			"the durable answer",
		);
		const doc = await harness.snapshot(JobDoc, String(id), BACKGROUND_CONTEXT);
		assert.equal(typeof doc?.conversationId, "number");
		assert.equal(doc?.conversationAttempt, 1);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		rmSync(workspace, { recursive: true, force: true });
	}
});
