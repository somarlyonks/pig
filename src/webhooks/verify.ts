import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
	secret: string,
	rawBody: Buffer | string,
	signature: string | undefined,
): boolean {
	if (!signature) return false;
	const match = /^sha256=([0-9a-f]{64})$/.exec(signature.trim());
	if (!match?.[1]) return false;
	const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
	const actual = match[1];
	return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
