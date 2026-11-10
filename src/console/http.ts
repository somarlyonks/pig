import type {
	ConsoleProposal,
	ConsoleState,
	ConsoleRuntime,
	SessionCommand,
	StateDispatch,
	WorkerView,
} from "./runtime.ts";
import { AssistantUnavailableError } from "./assistant.ts";
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
	}): Promise<{ worker: WorkerView; sessionToken: string }>;
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
	assist(input: {
		message: string;
		actor: string;
	}): Promise<{ reply: string; proposals: (ConsoleProposal & { rationale: string })[] }>;
	pollSession(input: {
		workerId: string;
		token: string;
		cursor: number;
		waitMs: number;
	}): Promise<{ commands: SessionCommand[]; cursor: number; pollAfterMs: number }>;
	ackSession(input: {
		workerId: string;
		token: string;
		results: { dispatchKey: string; jobId: string | null; error: string | null }[];
	}): Promise<{ updated: number }>;
	reportSession(input: {
		workerId: string;
		token: string;
		reports: { repo: string; jobs: never[] }[];
	}): Promise<{ recorded: number }>;
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
		assist: (input) => runtime.assist(input),
		pollSession: (input) => runtime.pollSession(input),
		ackSession: (input) => runtime.ackSession(input),
		reportSession: (input) => runtime.reportSession(input),
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

function bearer(request: Request): string | null {
	const authorization = request.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) return null;
	const token = authorization.slice("Bearer ".length).trim();
	return token === "" ? null : token;
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
			const registered = await service.registerWorker({
				enrollmentToken,
				workerId,
				kind: kind ?? "worker",
				transport,
				baseUrl,
				repos: readStringList(body, "repos"),
				secret,
				...(Array.isArray(body.capabilities)
					? { capabilities: body.capabilities as never[] }
					: {}),
				...(readString(body, "version") ? { version: readString(body, "version") as string } : {}),
			});
			return json(
				{
					ok: true,
					worker: registered.worker,
					sessionToken: registered.sessionToken,
				},
				201,
			);
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

		if (request.method === "POST" && url.pathname === "/api/assistant") {
			if (!isAdmin(request, adminToken)) {
				return json({ error: "not found" }, adminToken ? 401 : 404);
			}
			const body = await readJson(request);
			const message = body ? readString(body, "message") : null;
			const actor = body ? readString(body, "actor") : null;
			if (!message || !actor) {
				return json({ error: "message and actor are required" }, 400);
			}
			try {
				return json(await service.assist({ message, actor }));
			} catch (error) {
				if (error instanceof AssistantUnavailableError) {
					return json({ error: error.message }, 503);
				}
				throw error;
			}
		}

		if (request.method === "GET" && url.pathname === "/api/session/commands") {
			const workerId = url.searchParams.get("workerId") ?? "";
			const token = bearer(request);
			const cursor = Number(url.searchParams.get("cursor") ?? "0");
			const waitMs = Number(url.searchParams.get("waitMs") ?? "0");
			if (!workerId || !token) {
				return json({ error: "workerId and a session token are required" }, 401);
			}
			return json(
				await service.pollSession({
					workerId,
					token,
					cursor: Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0,
					waitMs: Number.isFinite(waitMs) && waitMs > 0 ? Math.floor(waitMs) : 0,
				}),
			);
		}

		if (request.method === "POST" && url.pathname === "/api/session/ack") {
			const body = await readJson(request);
			const workerId = body ? readString(body, "workerId") : null;
			const token = bearer(request);
			if (!body || !workerId || !token) {
				return json({ error: "workerId and a session token are required" }, 401);
			}
			const results = Array.isArray(body.results) ? body.results : [];
			const parsed = results.flatMap((entry) => {
				const record = asRecord(entry);
				const dispatchKey = record ? readString(record, "dispatchKey") : null;
				if (!record || !dispatchKey) return [];
				const jobId = record.jobId === null || record.jobId === undefined ? null : String(record.jobId);
				const error = typeof record.error === "string" ? record.error : null;
				return [{ dispatchKey, jobId, error }];
			});
			return json(await service.ackSession({ workerId, token, results: parsed }));
		}

		if (request.method === "POST" && url.pathname === "/api/session/report") {
			const body = await readJson(request);
			const workerId = body ? readString(body, "workerId") : null;
			const token = bearer(request);
			if (!body || !workerId || !token) {
				return json({ error: "workerId and a session token are required" }, 401);
			}
			const reports = Array.isArray(body.reports) ? body.reports : [];
			const parsed = reports.flatMap((entry) => {
				const record = asRecord(entry);
				const repo = record ? readString(record, "repo") : null;
				if (!record || !repo) return [];
				return [{ repo, jobs: (Array.isArray(record.jobs) ? record.jobs : []) as never[] }];
			});
			return json(await service.reportSession({ workerId, token, reports: parsed }));
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
