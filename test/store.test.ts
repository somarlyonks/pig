import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JobStore } from "../src/jobs/store.ts";
import type { NewJob } from "../src/jobs/types.ts";

function newJob(overrides: Partial<NewJob> = {}): NewJob {
	const id = randomUUID();
	return {
		id,
		installationId: 1,
		repo: "acme/app",
		kind: "work",
		idempotencyKey: `key-${id}`,
		request: { kind: "work", instructions: "test" },
		maxAttempts: 3,
		...overrides,
	};
}

function makeStore(): JobStore {
	return new JobStore(":memory:");
}

test("enqueue is idempotent by key", () => {
	const store = makeStore();
	const job = newJob();
	const first = store.enqueue(job, 1000);
	assert.equal(first.created, true);
	assert.equal(first.job.status, "queued");

	const duplicate = store.enqueue({ ...job, id: randomUUID() }, 1001);
	assert.equal(duplicate.created, false);
	assert.equal(duplicate.job.id, job.id);
	store.close();
});

test("claims jobs and serializes work per repository", () => {
	const store = makeStore();
	const first = newJob({ repo: "acme/app" });
	const second = newJob({ repo: "acme/app" });
	const otherRepo = newJob({ repo: "acme/other" });
	store.enqueue(first, 1000);
	store.enqueue(second, 1001);
	store.enqueue(otherRepo, 1002);

	const claimed = store.claimNext("worker-a", 1003, 60_000);
	assert.equal(claimed?.id, first.id);
	assert.equal(claimed?.attempts, 1);
	assert.equal(store.claimNext("worker-a", 1004, 60_000)?.id, otherRepo.id);
	assert.equal(store.claimNext("worker-a", 1005, 60_000), null);

	assert.equal(store.finish(first.id, "worker-a", "succeeded", { now: 1006 }), true);
	const next = store.claimNext("worker-a", 1007, 60_000);
	assert.equal(next?.id, second.id);
	store.close();
});

test("control jobs bypass the repository lock", () => {
	const store = makeStore();
	const running = newJob({ repo: "acme/app", kind: "work" });
	const control = newJob({ repo: "acme/app", kind: "control", maxAttempts: 1 });
	store.enqueue(running, 1000);
	const first = store.claimNext("worker-a", 1002, 60_000);
	assert.equal(first?.id, running.id);
	store.enqueue(control, 1003);

	const second = store.claimNext("worker-a", 1004, 60_000);
	assert.equal(second?.id, control.id);
	assert.equal(second?.kind, "control");
	store.close();
});

test("recovers expired leases and respects max attempts", () => {
	const store = makeStore();
	const retryable = newJob({ maxAttempts: 3, repo: "acme/app" });
	const final = newJob({ maxAttempts: 1, repo: "acme/other" });
	store.enqueue(retryable, 1000);
	store.enqueue(final, 1001);

	assert.equal(store.claimNext("worker-a", 1002, 100)?.id, retryable.id);
	assert.equal(store.claimNext("worker-b", 1003, 100)?.id, final.id);
	assert.deepEqual(store.recoverExpiredLeases(1100), { requeued: 0, failed: 0 });

	const recovered = store.recoverExpiredLeases(1104);
	assert.equal(recovered.requeued, 1);
	assert.equal(recovered.failed, 1);

	const retried = store.claimNext("worker-a", 1105, 60_000);
	assert.equal(retried?.id, retryable.id);
	assert.equal(retried?.attempts, 2);
	const failed = store.getJob(final.id);
	assert.equal(failed?.status, "failed");
	store.close();
});

test("heartbeats only succeed for the lease owner", () => {
	const store = makeStore();
	const job = newJob();
	store.enqueue(job, 1000);
	const claimed = store.claimNext("owner-a", 1001, 100);
	assert.equal(claimed?.id, job.id);
	assert.equal(claimed?.leaseOwner, "owner-a");
	assert.equal(store.heartbeat(job.id, "owner-b", 1002, 100), false);
	assert.equal(store.heartbeat(job.id, "owner-a", 1003, 100), true);
	store.close();
});

test("requeue can refund an attempt for graceful shutdown", () => {
	const store = makeStore();
	const job = newJob({ maxAttempts: 2 });
	store.enqueue(job, 1000);
	const claimed = store.claimNext("worker-a", 1001, 60_000);
	assert.equal(claimed?.attempts, 1);
	assert.equal(
		store.requeue(job.id, "worker-a", { availableAt: 1002, refundAttempt: true }),
		true,
	);
	const again = store.claimNext("worker-a", 1003, 60_000);
	assert.equal(again?.attempts, 1);
	store.close();
});

test("requestCancel cancels queued jobs and flags running jobs", () => {
	const store = makeStore();
	const running = newJob({ repo: "acme/app" });
	const queued = newJob({ repo: "acme/app" });
	const control = newJob({ repo: "acme/app", kind: "control", maxAttempts: 1 });
	store.enqueue(running, 1000);
	store.claimNext("worker-a", 1001, 60_000);
	store.enqueue(queued, 1002);
	store.enqueue(control, 1003);
	store.claimNext("worker-a", 1004, 60_000);

	const counts = store.requestCancel("acme/app", 1005, control.id);
	assert.deepEqual(counts, { queued: 1, running: 1 });
	assert.equal(store.getJob(queued.id)?.status, "cancelled");
	assert.equal(store.isCancelRequested(running.id), true);
	assert.equal(store.isCancelRequested(control.id), false);
	store.close();
});

test("persists checkpoints for the lease owner", () => {
	const store = makeStore();
	const job = newJob();
	store.enqueue(job, 1000);
	store.claimNext("worker-a", 1001, 60_000);
	assert.equal(store.setCheckpoint(job.id, "worker-b", { step: 1 }), false);
	assert.equal(store.setCheckpoint(job.id, "worker-a", { step: 2 }), true);
	assert.deepEqual(store.getJob(job.id)?.checkpoint, { step: 2 });
	store.close();
});

test("records deliveries once and retains job events", () => {
	const store = makeStore();
	assert.equal(store.hasDelivery("delivery-1"), false);
	assert.equal(store.recordDelivery("delivery-1", "issues", null, 1000), true);
	assert.equal(store.recordDelivery("delivery-1", "issues", null, 1001), false);
	assert.equal(store.hasDelivery("delivery-1"), true);

	const job = newJob();
	store.enqueue(job, 1002);
	for (let index = 0; index < 205; index += 1) {
		store.appendEvent(job.id, "info", `event ${index}`, 1003 + index);
	}
	const events = store.getEvents(job.id, 1000);
	assert.equal(events.length, 200);
	assert.equal(events[0]?.message, "event 5");
	assert.equal(events[199]?.message, "event 204");
	store.close();
});
