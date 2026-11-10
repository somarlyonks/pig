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
import { CommandDoc, JobDoc } from "../src/durable/docs.ts";
import {
	admitDispatch,
	admitWebhook,
	type AdmissionDecision,
	type DispatchInput,
} from "../src/durable/admission.ts";
import type { AdmissionPlan } from "../src/webhooks/plan.ts";
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

interface AdmissionTestApp {
	harness: Harness;
	rootId: number;
	admit: (input: { event: string; deliveryId: string; payload: unknown }) => Promise<{
		status: number;
		body: Record<string, unknown>;
	}>;
	dispatch: (input: Omit<DispatchInput, "receivedAt"> & { receivedAt?: number }) => Promise<{
		status: number;
		body: Record<string, unknown>;
	}>;
}

async function setup(
	filterAdmission?: (admission: AdmissionPlan) => AdmissionDecision,
): Promise<AdmissionTestApp> {
	const registry = createRegistry();
	registry.install({ name: "probe", tasks: [Probe] });
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry },
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT);
	const deps = {
		harness,
		rootId: root.id,
		appSlug: "pig",
		logger: silentLogger(),
		task: Probe,
		...(filterAdmission ? { filterAdmission } : {}),
	};
	return {
		harness,
		rootId: root.id,
		admit: (input) => admitWebhook(deps, input),
		dispatch: (input) =>
			admitDispatch(deps, { receivedAt: Date.now(), ...input }),
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


function consoleWork(dispatchKey: string): Omit<DispatchInput, "receivedAt"> {
	return {
		capability: "pig.work",
		params: { repo: "acme/app", instructions: "Add a regression test" },
		dispatchKey,
		actor: "alice",
		notAfter: null,
		installationId: 42,
	};
}

test("admits console commands once per dispatch key", async () => {
	const app = await setup();
	try {
		const first = await app.dispatch(consoleWork("console-1"));
		assert.equal(first.status, 202);
		const jobId = String(first.body.jobId);
		assert.match(jobId, /^\d+$/);

		const replay = await app.dispatch(consoleWork("console-1"));
		assert.equal(replay.body.jobId, jobId);
		assert.equal(replay.body.duplicate, true);

		const other = await app.dispatch(consoleWork("console-2"));
		assert.notEqual(other.body.jobId, jobId);
	} finally {
		await app.harness.close(BACKGROUND_CONTEXT);
	}
});

test("records console origin, claimed actor, and write target", async () => {
	const app = await setup();
	try {
		const result = await app.dispatch(consoleWork("console-origin"));
		const record = await app.harness.getTask(
			Number(result.body.jobId) as TaskId,
			BACKGROUND_CONTEXT,
		);
		assert.ok(record);
		const input = record.input as unknown as JobTaskInput;
		assert.equal(input.request.origin, "console");
		assert.equal(input.request.actor, "alice");
		assert.equal(input.request.source.type, "generated");
		assert.equal(input.request.kind, "work");
		assert.equal(input.request.kind === "work" ? input.request.target : null, "new");
		assert.equal(input.idempotencyKey, "dispatch:console-origin");
	} finally {
		await app.harness.close(BACKGROUND_CONTEXT);
	}
});

test("chains console work but not console control", async () => {
	const app = await setup();
	try {
		const work = await app.dispatch(consoleWork("console-chain-1"));
		const status = await app.dispatch({
			...consoleWork("console-chain-2"),
			capability: "pig.status",
			params: { repo: "acme/app" },
		});
		const next = await app.dispatch(consoleWork("console-chain-3"));

		const read = async (id: unknown): Promise<JobTaskInput> => {
			const record = await app.harness.getTask(Number(id) as TaskId, BACKGROUND_CONTEXT);
			assert.ok(record);
			return record.input as unknown as JobTaskInput;
		};
		assert.equal((await read(work.body.jobId)).previousTaskId, null);
		assert.equal((await read(status.body.jobId)).previousTaskId, null);
		assert.equal(
			(await read(next.body.jobId)).previousTaskId,
			Number(work.body.jobId),
		);
	} finally {
		await app.harness.close(BACKGROUND_CONTEXT);
	}
});

test("rejects an expired console command without creating work", async () => {
	const app = await setup();
	try {
		const expired = await app.dispatch({
			...consoleWork("console-expired"),
			notAfter: Date.now() - 1000,
		});
		assert.equal(expired.status, 410);
		assert.equal(expired.body.error, "dispatch expired");

		const command = await app.harness.snapshot(
			CommandDoc,
			`c:dispatch:console-expired`,
			BACKGROUND_CONTEXT,
		);
		assert.equal(command?.taskId ?? 0, 0);

		const accepted = await app.dispatch({
			...consoleWork("console-expired"),
			notAfter: Date.now() + 60_000,
		});
		assert.equal(accepted.status, 202);
		assert.match(String(accepted.body.jobId), /^\d+$/);
	} finally {
		await app.harness.close(BACKGROUND_CONTEXT);
	}
});

test("rejects malformed console commands", async () => {
	const app = await setup();
	try {
		const unknown = await app.dispatch({
			...consoleWork("console-unknown"),
			capability: "pig.nope",
		});
		assert.equal(unknown.status, 400);
		assert.match(String(unknown.body.error), /unknown capability/);

		const missingRepo = await app.dispatch({
			...consoleWork("console-no-repo"),
			params: { instructions: "x" },
		});
		assert.equal(missingRepo.status, 400);

		const badKey = await app.dispatch({ ...consoleWork("bad key!"), dispatchKey: "bad key!" });
		assert.equal(badKey.status, 400);
	} finally {
		await app.harness.close(BACKGROUND_CONTEXT);
	}
});

test("a host can turn a console coding command into a notice", async () => {
	const app = await setup((admission) =>
		admission.request.kind === "work"
			? {
					...admission,
					jobKind: "control",
					request: {
						kind: "control",
						action: "notice",
						message: "coding is not supported here",
						origin: admission.request.origin,
						actor: admission.request.actor,
						source: admission.request.source,
						trigger: admission.request.trigger,
						receivedAt: admission.request.receivedAt,
					},
					maxAttempts: 1,
					chained: false,
				}
			: admission,
	);
	try {
		const result = await app.dispatch(consoleWork("console-notice"));
		assert.equal(result.status, 202);
		const record = await app.harness.getTask(
			Number(result.body.jobId) as TaskId,
			BACKGROUND_CONTEXT,
		);
		const input = record?.input as unknown as JobTaskInput;
		assert.equal(input.request.kind, "control");
	} finally {
		await app.harness.close(BACKGROUND_CONTEXT);
	}
});
