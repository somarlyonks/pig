import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineTask,
	Harness,
	MemoryStorage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { JobDoc } from "../src/durable/docs.ts";
import { admitWebhook } from "../src/durable/admission.ts";
import type { JobTaskInput } from "../src/durable/job-task.ts";
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

const Probe = defineTask<JobTaskInput, { phase: "run" }, { summary: string }>({
	name: "probe.job",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: {
						status: "completed",
						result: { summary: task.input.request.kind },
					},
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

const REPOSITORY = {
	repository: { full_name: "acme/app" },
	installation: { id: 42 },
};

function issueComment(
	body: string,
	commentId = 1001,
): Record<string, unknown> {
	return {
		action: "created",
		...REPOSITORY,
		issue: {
			number: 7,
			title: "Something is broken",
			body: "An issue",
			user: { login: "alice" },
		},
		comment: {
			id: commentId,
			body,
			user: { login: "alice", type: "User" },
		},
	};
}

async function setup(): Promise<{
	harness: Harness;
	rootId: number;
	admit: (input: { event: string; deliveryId: string; payload: unknown }) => Promise<{
		status: number;
		body: Record<string, unknown>;
	}>;
}> {
	const registry = createRegistry();
	registry.install({ name: "probe", tasks: [Probe] });
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry },
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT);
	return {
		harness,
		rootId: root.id,
		admit: (input) =>
			admitWebhook(
				{
					harness,
					rootId: root.id,
					appSlug: "pig",
					logger: silentLogger(),
					task: Probe,
				},
				input,
			),
	};
}

test("admits once and deduplicates deliveries", async () => {
	const app = await setup();
	try {
		const first = await app.admit({
			event: "issue_comment",
			deliveryId: "delivery-1",
			payload: issueComment("@pig fix the parser"),
		});
		assert.equal(first.status, 202);
		assert.equal(first.body.duplicate, undefined);
		const jobId = String(first.body.jobId);
		assert.match(jobId, /^\d+$/);

		const replay = await app.admit({
			event: "issue_comment",
			deliveryId: "delivery-1",
			payload: issueComment("@pig fix the parser"),
		});
		assert.equal(replay.body.duplicate, true);
		assert.equal(replay.body.jobId, jobId);

		const otherDelivery = await app.admit({
			event: "issue_comment",
			deliveryId: "delivery-2",
			payload: issueComment("@pig fix the parser"),
		});
		assert.equal(otherDelivery.body.jobId, jobId);
		assert.equal(otherDelivery.body.duplicate, undefined);

		await app.harness.waitForTask(Number(jobId) as TaskId, BACKGROUND_CONTEXT);
		const doc = await app.harness.snapshot(JobDoc, jobId, BACKGROUND_CONTEXT);
		assert.equal(doc?.status, "queued");
	} finally {
		await app.harness.close(BACKGROUND_CONTEXT);
	}
});

test("records ignored deliveries so replays are duplicates", async () => {
	const app = await setup();
	try {
		const ignored = await app.admit({
			event: "issue_comment",
			deliveryId: "delivery-ignore",
			payload: issueComment("no mention here"),
		});
		assert.equal(ignored.status, 202);
		assert.equal(ignored.body.jobId, null);
		assert.equal(ignored.body.ignored, "no mention");

		const replay = await app.admit({
			event: "issue_comment",
			deliveryId: "delivery-ignore",
			payload: issueComment("no mention here"),
		});
		assert.equal(replay.body.duplicate, true);
		assert.equal(replay.body.jobId, null);
	} finally {
		await app.harness.close(BACKGROUND_CONTEXT);
	}
});

test("chains agent jobs per repository but not control jobs", async () => {
	const app = await setup();
	try {
		const first = await app.admit({
			event: "issue_comment",
			deliveryId: "work-1",
			payload: issueComment("@pig fix one", 2001),
		});
		const second = await app.admit({
			event: "issue_comment",
			deliveryId: "work-2",
			payload: issueComment("@pig fix two", 2002),
		});
		const status = await app.admit({
			event: "issue_comment",
			deliveryId: "status-1",
			payload: issueComment("@pig status", 2003),
		});
		const third = await app.admit({
			event: "issue_comment",
			deliveryId: "work-3",
			payload: issueComment("@pig fix three", 2004),
		});

		const read = async (id: unknown): Promise<JobTaskInput> => {
			const record = await app.harness.getTask(Number(id) as TaskId, BACKGROUND_CONTEXT);
			assert.ok(record);
			return record.input as unknown as JobTaskInput;
		};
		assert.equal((await read(first.body.jobId)).previousTaskId, null);
		assert.equal((await read(second.body.jobId)).previousTaskId, Number(first.body.jobId));
		assert.equal((await read(status.body.jobId)).previousTaskId, null);
		assert.equal((await read(third.body.jobId)).previousTaskId, Number(second.body.jobId));
	} finally {
		await app.harness.close(BACKGROUND_CONTEXT);
	}
});
