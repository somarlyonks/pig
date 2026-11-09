export async function verifyWebhookSignatureWebCrypto(
	secret: string,
	body: ArrayBuffer,
	signature: string | null,
): Promise<boolean> {
	if (!signature) return false;
	const match = /^sha256=([0-9a-f]{64})$/.exec(signature.trim());
	if (!match?.[1]) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
	let hex = "";
	for (const byte of digest) {
		hex += byte.toString(16).padStart(2, "0");
	}
	let difference = 0;
	for (let index = 0; index < hex.length; index += 1) {
		difference |= hex.charCodeAt(index) ^ match[1].charCodeAt(index);
	}
	return difference === 0;
}
