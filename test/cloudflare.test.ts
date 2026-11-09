import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { TaskInspection } from "@earendil-works/pi-durable";
import { nextAlarmForTasks } from "../src/durable/alarm.ts";
import { extractRepository } from "../src/webhooks/extract.ts";
import { verifyWebhookSignatureWebCrypto } from "../src/webhooks/verify-webcrypto.ts";

const SECRET = "cloudflare-secret";

function arrayBuffer(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sign(body: ArrayBuffer, secret = SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(new Uint8Array(body)).digest("hex")}`;
}

test("verifies webhook signatures with WebCrypto", async () => {
	const body = arrayBuffer('{"action":"created"}');
	assert.equal(await verifyWebhookSignatureWebCrypto(SECRET, body, sign(body)), true);
	assert.equal(await verifyWebhookSignatureWebCrypto(SECRET, body, sign(body, "wrong")), false);
	assert.equal(await verifyWebhookSignatureWebCrypto(SECRET, body, null), false);
	assert.equal(await verifyWebhookSignatureWebCrypto(SECRET, body, "sha256=nope"), false);
	assert.equal(
		await verifyWebhookSignatureWebCrypto(SECRET, body, sign(body).toUpperCase()),
		false,
	);
});

test("extracts the repository name from a webhook payload", () => {
	assert.equal(
		extractRepository({ repository: { full_name: "acme/app" } }),
		"acme/app",
	);
	assert.equal(extractRepository({ repository: {} }), null);
	assert.equal(extractRepository({ repository: { full_name: "invalid" } }), null);
	assert.equal(extractRepository(null), null);
	assert.equal(extractRepository("text"), null);
});

function inspection(kind: string, status: string, until?: number): TaskInspection {
	const state =
		kind === "sleeping"
			? { kind, until: until ?? 0, checkpoint: {} }
			: { kind, checkpoint: {} };
	return {
		state,
		record: {
			id: 1,
			state: { status, ...(until === undefined ? {} : { until }) },
			abortRequested: false,
		},
	} as unknown as TaskInspection;
}

test("projects sleeping and runnable tasks onto one alarm", () => {
	const now = 1_000_000;
	const recovery = 60_000;
	assert.equal(nextAlarmForTasks([], now, recovery), undefined);
	assert.equal(
		nextAlarmForTasks([inspection("sleeping", "sleeping", now + 5_000)], now, recovery),
		now + 5_000,
	);
	assert.equal(
		nextAlarmForTasks([inspection("pending", "pending")], now, recovery),
		now + recovery,
	);
	assert.equal(
		nextAlarmForTasks([inspection("running", "running")], now, recovery),
		now + recovery,
	);
	assert.equal(
		nextAlarmForTasks([inspection("waiting", "waiting")], now, recovery),
		undefined,
	);
	assert.equal(
		nextAlarmForTasks(
			[
				inspection("sleeping", "sleeping", now + 30_000),
				inspection("running", "running"),
				inspection("blocked", "pending"),
			],
			now,
			recovery,
		),
		now + 30_000,
	);
	assert.equal(
		nextAlarmForTasks([inspection("sleeping", "sleeping", now - 1)], now, recovery),
		now + recovery,
	);
});
