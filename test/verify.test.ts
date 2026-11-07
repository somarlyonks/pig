import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../src/webhooks/verify.ts";

const SECRET = "top-secret";
const BODY = Buffer.from('{"action":"opened","number":42}', "utf8");

function sign(body: Buffer, secret = SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("verifies a valid GitHub signature", () => {
	assert.equal(verifyWebhookSignature(SECRET, BODY, sign(BODY)), true);
	assert.equal(verifyWebhookSignature(SECRET, BODY.toString("utf8"), sign(BODY)), true);
});

test("rejects missing, malformed, and incorrect signatures", () => {
	assert.equal(verifyWebhookSignature(SECRET, BODY, undefined), false);
	assert.equal(verifyWebhookSignature(SECRET, BODY, ""), false);
	assert.equal(verifyWebhookSignature(SECRET, BODY, "sha1=abc"), false);
	assert.equal(verifyWebhookSignature(SECRET, BODY, sign(BODY, "other-secret")), false);
	assert.equal(verifyWebhookSignature(SECRET, Buffer.from("tampered"), sign(BODY)), false);
	assert.equal(verifyWebhookSignature(SECRET, BODY, sign(BODY).toUpperCase()), false);
});
