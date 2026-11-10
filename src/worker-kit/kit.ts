import { parseDispatchEnvelope } from "../dispatch/input.ts";
import type { CapabilityDescriptor } from "../dispatch/capabilities.ts";
import {
	memoryIdempotencyStore,
	type WorkerKit,
	type WorkerKitOptions,
	type WorkerHandler,
} from "./types.ts";
import { validateParameters } from "./validate.ts";

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function bearer(request: Request): string | null {
	const authorization = request.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) return null;
	const token = authorization.slice("Bearer ".length).trim();
	return token === "" ? null : token;
}

function tokenEquals(provided: string, expected: string): boolean {
	if (provided.length !== expected.length) return false;
	let difference = 0;
	for (let index = 0; index < provided.length; index += 1) {
		difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
	}
	return difference === 0;
}

/**
 * The worker side of the console protocol, independent of PiG. Any durable agent
 * can publish capabilities and accept commands with this: the console never
 * learns a new worker kind from code, only from the declaration.
 */
export function createWorkerKit(options: WorkerKitOptions): WorkerKit {
	const store = options.store ?? memoryIdempotencyStore();
	const now = options.now ?? (() => Date.now());
	const handlers = new Map<string, WorkerHandler>(
		options.handlers.map((handler) => [handler.capability.name, handler]),
	);
	const capabilities: CapabilityDescriptor[] = options.handlers.map(
		(handler) => handler.capability,
	);

	async function dispatch(request: Request): Promise<Response> {
		const parsed = parseDispatchEnvelope({ value: await request.json(), now: now() });
		if (!parsed.ok) {
			return json({ error: parsed.error }, 400);
		}
		const handler = handlers.get(parsed.input.capability);
		if (!handler) {
			return json({ error: `unknown capability: ${parsed.input.capability}` }, 400);
		}
		const invalid = validateParameters(handler.capability, parsed.input.params);
		if (invalid !== null) {
			return json({ error: invalid }, 400);
		}

		const previous = await store.get(parsed.input.dispatchKey);
		if (previous) {
			return json({
				ok: true,
				jobId: previous.jobId ?? null,
				duplicate: true,
			});
		}
		if (parsed.input.notAfter !== null && now() > parsed.input.notAfter) {
			return json({ error: "dispatch expired", dispatchKey: parsed.input.dispatchKey }, 410);
		}

		let result;
		try {
			result = await handler.execute(parsed.input.params, {
				dispatchKey: parsed.input.dispatchKey,
				actor: parsed.input.actor,
				receivedAt: parsed.input.receivedAt,
				notAfter: parsed.input.notAfter,
			});
		} catch (error) {
			return json(
				{ error: error instanceof Error ? error.message : String(error) },
				500,
			);
		}
		await store.set(parsed.input.dispatchKey, result);
		return json({ ok: true, jobId: result.jobId ?? null, ...(result.result ?? {}) }, 202);
	}

	return {
		name: options.name,
		version: options.version,
		capabilities,
		async handle(request: Request): Promise<Response> {
			const url = new URL(request.url);
			if (!options.secret) return json({ error: "not found" }, 404);
			if (url.pathname === "/api/capabilities" && request.method === "GET") {
				if (!tokenEquals(bearer(request) ?? "", options.secret)) {
					return json({ error: "not found" }, 401);
				}
				return json({
					worker: { name: options.name, version: options.version },
					capabilities,
				});
			}
			if (url.pathname === "/api/dispatch") {
				if (request.method !== "POST") {
					return json({ error: "method not allowed" }, 405);
				}
				if (!tokenEquals(bearer(request) ?? "", options.secret)) {
					return json({ error: "not found" }, 401);
				}
				try {
					return await dispatch(request);
				} catch (error) {
					return json(
						{ error: error instanceof Error ? error.message : String(error) },
						500,
					);
				}
			}
			return json({ error: "not found" }, 404);
		},
	};
}
