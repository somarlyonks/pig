import { createHmac } from "node:crypto";

export function signWebhookPayload(secret: string, rawBody: string | Buffer): string {
	const digest = createHmac("sha256", secret)
		.update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
		.digest("hex");
	return `sha256=${digest}`;
}
