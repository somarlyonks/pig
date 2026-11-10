import type { ExportedHandler } from "@cloudflare/workers-types";
import { PIG_CAPABILITIES } from "../dispatch/capabilities.ts";
import { parseDispatchEnvelope } from "../dispatch/input.ts";
import { dispatchIdempotencyKey, dispatchRepository, isValidDispatchKey } from "../dispatch/plan.ts";
import { extractRepository } from "../webhooks/extract.ts";
import { verifyWebhookSignatureWebCrypto } from "../webhooks/verify-webcrypto.ts";
import type { CloudflareEnv } from "./env.ts";
import { RepoDurableObject } from "./repo-do.ts";

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function tokenEquals(provided: string, expected: string): boolean {
	if (provided.length !== expected.length) return false;
	let difference = 0;
	for (let index = 0; index < provided.length; index += 1) {
		difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
	}
	return difference === 0;
}

function isAdmin(request: Request, token: string | undefined): boolean {
	if (!token) return false;
	const authorization = request.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) return false;
	return tokenEquals(authorization.slice("Bearer ".length).trim(), token);
}

function stubFor(env: CloudflareEnv, repo: string) {
	return env.REPOS.get(env.REPOS.idFromName(repo));
}

async function handleWebhook(request: Request, env: CloudflareEnv): Promise<Response> {
	const body = await request.arrayBuffer();
	const signature = request.headers.get("x-hub-signature-256");
	if (!(await verifyWebhookSignatureWebCrypto(env.PIG_WEBHOOK_SECRET, body, signature))) {
		return json({ error: "invalid signature" }, 401);
	}
	const event = request.headers.get("x-github-event");
	const deliveryId = request.headers.get("x-github-delivery");
	if (!event || !deliveryId) {
		return json({ error: "missing GitHub webhook headers" }, 400);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return json({ error: "invalid JSON payload" }, 400);
	}
	const repo = extractRepository(payload);
	if (!repo) {
		return json({ ok: true, jobId: null, ignored: "no repository" }, 202);
	}
	return stubFor(env, repo).fetch("https://pig-do/admit", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ event, deliveryId, payload }),
	});
}

async function handleDispatch(request: Request, env: CloudflareEnv): Promise<Response> {
	const parsed = parseDispatchEnvelope({
		value: await request.json(),
		now: Date.now(),
	});
	if (!parsed.ok) return json({ error: parsed.error }, 400);
	const repo = dispatchRepository(parsed.input.params);
	if (!repo) return json({ error: "params.repo must be owner/name" }, 400);
	return stubFor(env, repo).fetch("https://pig-do/dispatch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(parsed.input),
	});
}

async function handleAdmin(request: Request, env: CloudflareEnv, url: URL): Promise<Response> {
	if (!isAdmin(request, env.PIG_ADMIN_TOKEN)) {
		return json({ error: "not found" }, env.PIG_ADMIN_TOKEN ? 401 : 404);
	}
	const repo = url.searchParams.get("repo");
	if (!repo) {
		return json({ error: "repo query parameter is required" }, 400);
	}
	const stub = stubFor(env, repo);
	const dispatchKey = url.searchParams.get("dispatchKey");
	if (url.pathname === "/api/jobs" && dispatchKey !== null) {
		if (!isValidDispatchKey(dispatchKey)) {
			return json({ error: "invalid dispatchKey" }, 400);
		}
		return stub.fetch(
			`https://pig-do/job-key?key=${encodeURIComponent(dispatchKey)}`,
		);
	}
	if (url.pathname === "/api/jobs") {
		const limit = url.searchParams.get("limit") ?? "20";
		return stub.fetch(
			`https://pig-do/jobs?repo=${encodeURIComponent(repo)}&limit=${encodeURIComponent(limit)}`,
		);
	}
	const id = url.pathname.slice("/api/jobs/".length);
	return stub.fetch(
		`https://pig-do/job?repo=${encodeURIComponent(repo)}&id=${encodeURIComponent(id)}`,
	);
}

const worker: ExportedHandler<CloudflareEnv> = {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === "GET" && url.pathname === "/healthz") {
				return json({ ok: true, host: "cloudflare" });
			}
			if (request.method === "GET" && url.pathname === "/") {
				return json({ name: "PiG", description: "Pi-durable In GitHub" });
			}
			if (url.pathname === "/api/github/webhooks") {
				if (request.method !== "POST") {
					return json({ error: "method not allowed" }, 405);
				}
				return await handleWebhook(request, env);
			}
			if (request.method === "GET" && url.pathname === "/api/capabilities") {
				if (!isAdmin(request, env.PIG_ADMIN_TOKEN)) {
					return json({ error: "not found" }, env.PIG_ADMIN_TOKEN ? 401 : 404);
				}
				return json({
					worker: { name: "PiG", version: "cloudflare" },
					capabilities: PIG_CAPABILITIES,
				});
			}
			if (url.pathname === "/api/dispatch") {
				if (request.method !== "POST") {
					return json({ error: "method not allowed" }, 405);
				}
				if (!isAdmin(request, env.PIG_ADMIN_TOKEN)) {
					return json({ error: "not found" }, env.PIG_ADMIN_TOKEN ? 401 : 404);
				}
				return await handleDispatch(request, env);
			}
			if (
				request.method === "GET" &&
				(url.pathname === "/api/jobs" || url.pathname.startsWith("/api/jobs/"))
			) {
				return await handleAdmin(request, env, url);
			}
			return json({ error: "not found" }, 404);
		} catch (error) {
			return json(
				{ error: error instanceof Error ? error.message : String(error) },
				500,
			);
		}
	},
};

export { RepoDurableObject };
export default worker;
