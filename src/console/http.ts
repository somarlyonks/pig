import type { ConsoleState, ConsoleRuntime, StateDispatch, WorkerView } from "./runtime.ts";
import { WorkerRequestError } from "./client.ts";

export interface ConsoleService {
	state(options?: { refresh?: boolean }): Promise<ConsoleState>;
	createEnrollment(input: {
		label: string;
		ttlMs?: number;
	}): Promise<{ token: string; expiresAt: number }>;
	registerWorker(input: {
		enrollmentToken: string;
		workerId: string;
		kind: string;
		transport: "inbound" | "outbound";
		baseUrl: string;
		repos: string[];
		secret: string;
	}): Promise<WorkerView>;
	listWorkers(): Promise<WorkerView[]>;
	submit(input: {
		workerId: string;
		capability: string;
		params: Record<string, unknown>;
		actor: string;
		proposalId?: string;
		confirm?: boolean;
	}): Promise<{ status: number; body: Record<string, unknown> }>;
	lookup(dispatchKey: string): Promise<StateDispatch | null>;
}

export interface ConsoleRequestOptions {
	service: ConsoleService;
	adminToken: string | undefined;
	now: () => number;
}

export function consoleServiceFromRuntime(runtime: ConsoleRuntime): ConsoleService {
	return {
		state: (options) => runtime.state(options),
		createEnrollment: (input) => runtime.createEnrollment(input),
		registerWorker: (input) => runtime.registerWorker(input),
		listWorkers: () => runtime.listWorkers(),
		submit: (input) => runtime.submit(input),
		lookup: (key) => runtime.lookup(key),
	};
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readString(record: Record<string, unknown>, name: string): string | null {
	const value = record[name];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readStringList(record: Record<string, unknown>, name: string): string[] {
	const value = record[name];
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
		: [];
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	try {
		return asRecord(await request.json());
	} catch {
		return null;
	}
}

function errorResponse(error: unknown): Response {
	if (error instanceof WorkerRequestError) {
		return json({ error: error.message }, error.status ?? 502);
	}
	return json({ error: error instanceof Error ? error.message : String(error) }, 500);
}

export async function handleConsoleRequest(
	request: Request,
	options: ConsoleRequestOptions,
): Promise<Response> {
	const url = new URL(request.url);
	const { service, adminToken } = options;

	try {
		if (request.method === "GET" && url.pathname === "/api/state") {
			if (!isAdmin(request, adminToken)) {
				return json({ error: "not found" }, adminToken ? 401 : 404);
			}
			const refresh = url.searchParams.get("refresh") === "1";
			return json(await service.state({ refresh }));
		}

		if (request.method === "GET" && url.pathname === "/api/workers") {
			if (!isAdmin(request, adminToken)) {
				return json({ error: "not found" }, adminToken ? 401 : 404);
			}
			return json({ workers: await service.listWorkers() });
		}

		if (request.method === "POST" && url.pathname === "/api/enrollments") {
			if (!isAdmin(request, adminToken)) {
				return json({ error: "not found" }, adminToken ? 401 : 404);
			}
			const body = (await readJson(request)) ?? {};
			const label = readString(body, "label") ?? "worker";
			const minutes = typeof body.ttlMinutes === "number" ? body.ttlMinutes : null;
			const enrollment = await service.createEnrollment({
				label,
				...(minutes !== null && Number.isFinite(minutes) && minutes > 0
					? { ttlMs: Math.round(minutes * 60_000) }
					: {}),
			});
			return json(
				{
					ok: true,
					token: enrollment.token,
					expiresAt: enrollment.expiresAt,
					expiresInMinutes: Math.round((enrollment.expiresAt - options.now()) / 60_000),
				},
				201,
			);
		}

		if (request.method === "POST" && url.pathname === "/api/workers") {
			const body = await readJson(request);
			if (!body) return json({ error: "body must be a JSON object" }, 400);
			const enrollmentToken = readString(body, "enrollmentToken");
			const workerId = readString(body, "workerId");
			const kind = readString(body, "kind");
			const baseUrl = readString(body, "baseUrl");
			const secret = readString(body, "secret");
			const transport = body.transport === "outbound" ? "outbound" : "inbound";
			if (!enrollmentToken || !workerId || !baseUrl || !secret) {
				return json(
					{ error: "enrollmentToken, workerId, baseUrl, and secret are required" },
					400,
				);
			}
			const worker = await service.registerWorker({
				enrollmentToken,
				workerId,
				kind: kind ?? "worker",
				transport,
				baseUrl,
				repos: readStringList(body, "repos"),
				secret,
			});
			return json({ ok: true, worker }, 201);
		}

		if (request.method === "POST" && url.pathname === "/api/commands") {
			if (!isAdmin(request, adminToken)) {
				return json({ error: "not found" }, adminToken ? 401 : 404);
			}
			const body = await readJson(request);
			if (!body) return json({ error: "body must be a JSON object" }, 400);
			const workerId = readString(body, "workerId");
			const capability = readString(body, "capability");
			const actor = readString(body, "actor");
			const params = asRecord(body.params) ?? {};
			if (!workerId || !capability || !actor) {
				return json({ error: "workerId, capability, and actor are required" }, 400);
			}
			const result = await service.submit({
				workerId,
				capability,
				params,
				actor,
				...(readString(body, "proposalId")
					? { proposalId: readString(body, "proposalId") as string }
					: {}),
				...(body.confirm === true ? { confirm: true } : {}),
			});
			return json(result.body, result.status);
		}

		if (request.method === "GET" && url.pathname.startsWith("/api/dispatches/")) {
			if (!isAdmin(request, adminToken)) {
				return json({ error: "not found" }, adminToken ? 401 : 404);
			}
			const dispatchKey = decodeURIComponent(url.pathname.slice("/api/dispatches/".length));
			if (dispatchKey === "") return json({ error: "dispatch key is required" }, 400);
			const dispatch = await service.lookup(dispatchKey);
			return dispatch ? json({ dispatch }) : json({ error: "dispatch not found" }, 404);
		}

		return json({ error: "not found" }, 404);
	} catch (error) {
		return errorResponse(error);
	}
}
