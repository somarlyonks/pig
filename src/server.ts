import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "./config.ts";
import type { PigApp } from "./durable/app.ts";
import type { Logger } from "./logger.ts";
import { verifyWebhookSignature } from "./webhooks/verify.ts";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface HttpServerOptions {
	config: AppConfig;
	logger: Logger;
	version: string;
	app: PigApp;
}

export interface RunningServer {
	server: Server;
	close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
	});
	response.end(text);
}

async function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > limit) {
			request.resume();
			return null;
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function tokenEquals(provided: string, expected: string): boolean {
	const left = Buffer.from(provided);
	const right = Buffer.from(expected);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

function isAdmin(request: IncomingMessage, token: string | undefined): boolean {
	if (!token) return false;
	const authorization = headerValue(request, "authorization");
	if (!authorization?.startsWith("Bearer ")) return false;
	return tokenEquals(authorization.slice("Bearer ".length).trim(), token);
}

export function startHttpServer(options: HttpServerOptions): Promise<RunningServer> {
	const startedAt = Date.now();
	const logger = options.logger;

	const server = createServer((request, response) => {
		const requestStarted = Date.now();
		response.on("finish", () => {
			logger.debug("HTTP request", {
				method: request.method,
				path: new URL(request.url ?? "/", "http://localhost").pathname,
				status: response.statusCode,
				ms: Date.now() - requestStarted,
			});
		});

		void handleRequest(request, response).catch((error) => {
			logger.error("HTTP request failed", { method: request.method, url: request.url, error });
			if (!response.headersSent) {
				sendJson(response, 500, { error: "internal server error" });
			} else {
				response.destroy();
			}
		});
	});

	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");

		if (request.method === "GET" && url.pathname === "/healthz") {
			const activeJobs = await options.app.activeJobs();
			sendJson(response, 200, {
				ok: true,
				uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
				activeJobs,
			});
			return;
		}

		if (request.method === "GET" && url.pathname === "/") {
			sendJson(response, 200, {
				name: "PiG",
				version: options.version,
				description: "Pi-durable In GitHub",
			});
			return;
		}

		if (
			request.method === "GET" &&
			(url.pathname === "/api/jobs" || url.pathname.startsWith("/api/jobs/"))
		) {
			if (!isAdmin(request, options.config.adminToken)) {
				sendJson(response, options.config.adminToken ? 401 : 404, { error: "not found" });
				return;
			}
			if (url.pathname === "/api/jobs") {
				const repo = url.searchParams.get("repo");
				if (!repo) {
					sendJson(response, 400, { error: "repo query parameter is required" });
					return;
				}
				const rawLimit = Number(url.searchParams.get("limit") ?? 20);
				const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
				const jobs = await options.app.listJobs(repo, limit);
				sendJson(response, 200, { jobs });
				return;
			}
			const jobId = url.pathname.slice("/api/jobs/".length);
			const detail = await options.app.getJob(jobId);
			if (!detail) {
				sendJson(response, 404, { error: "job not found" });
				return;
			}
			sendJson(response, 200, detail);
			return;
		}

		if (url.pathname === "/api/github/webhooks") {
			if (request.method !== "POST") {
				sendJson(response, 405, { error: "method not allowed" });
				return;
			}
			const rawBody = await readRawBody(request, MAX_BODY_BYTES);
			if (!rawBody) {
				sendJson(response, 413, { error: "payload too large" });
				return;
			}
			const signature = headerValue(request, "x-hub-signature-256");
			if (!verifyWebhookSignature(options.config.webhookSecret, rawBody, signature)) {
				logger.warn("Rejected webhook with an invalid signature", {
					delivery: headerValue(request, "x-github-delivery"),
				});
				sendJson(response, 401, { error: "invalid signature" });
				return;
			}
			const event = headerValue(request, "x-github-event");
			const deliveryId = headerValue(request, "x-github-delivery");
			if (!event || !deliveryId) {
				sendJson(response, 400, { error: "missing GitHub webhook headers" });
				return;
			}
			let payload: unknown;
			try {
				payload = JSON.parse(rawBody.toString("utf8"));
			} catch {
				sendJson(response, 400, { error: "invalid JSON payload" });
				return;
			}
			const result = await options.app.admit({ event, deliveryId, payload });
			sendJson(response, result.status, result.body);
			return;
		}

		sendJson(response, 404, { error: "not found" });
	}

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.config.port, "0.0.0.0", () => {
			server.off("error", reject);
			logger.info("HTTP server listening", {
				port: options.config.port,
				webhookPath: "/api/github/webhooks",
			});
			resolve({
				server,
				close: () =>
					new Promise<void>((closeResolve) => {
						server.close(() => closeResolve());
						server.closeIdleConnections();
					}),
			});
		});
	});
}
