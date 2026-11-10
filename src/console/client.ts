import type { CapabilityDescriptor } from "../dispatch/capabilities.ts";

export interface WorkerJobState {
	id: string;
	kind: string;
	origin: string;
	status: string;
	attempts: number;
	maxAttempts: number;
	createdAt: number;
	summary: string;
	error: string | null;
}

export interface WorkerJobDetail {
	job: WorkerJobState;
	repo: string;
	events: string[];
	progressCommentId: number | null;
	reply: string | null;
}

export class WorkerRequestError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.name = "WorkerRequestError";
		this.status = status;
	}
}

export interface DispatchResponse {
	ok: boolean;
	jobId: string | null;
	duplicate?: boolean;
	ignored?: string;
	error?: string;
}

export interface WorkerClientOptions {
	fetch: typeof fetch;
	baseUrl: string;
	secret: string;
	timeoutMs?: number;
}

function trimBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

/**
 * Calls one worker's own HTTP API. The console never talks to GitHub, so every
 * read and write here is PiG's (or another worker's) authority, not the console's.
 */
export class WorkerClient {
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;
	private readonly secret: string;
	private readonly timeoutMs: number;

	constructor(options: WorkerClientOptions) {
		this.fetchImpl = options.fetch;
		this.baseUrl = trimBaseUrl(options.baseUrl);
		this.secret = options.secret;
		this.timeoutMs = options.timeoutMs ?? 20_000;
	}

	async describe(): Promise<{
		name: string;
		version: string;
		capabilities: CapabilityDescriptor[];
	}> {
		const body = await this.request("GET", "/api/capabilities");
		const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
		const worker =
			typeof record.worker === "object" && record.worker !== null
				? (record.worker as Record<string, unknown>)
				: {};
		return {
			name: typeof worker.name === "string" ? worker.name : "",
			version: typeof worker.version === "string" ? worker.version : "",
			capabilities: Array.isArray(record.capabilities)
				? (record.capabilities as CapabilityDescriptor[])
				: [],
		};
	}

	async dispatch(input: {
		capability: string;
		params: Record<string, unknown>;
		dispatchKey: string;
		actor: string;
		notAfter: number | null;
	}): Promise<DispatchResponse> {
		const body = await this.request("POST", "/api/dispatch", input);
		const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
		const jobId = record.jobId === null || record.jobId === undefined ? null : String(record.jobId);
		return {
			ok: record.ok !== false,
			jobId,
			...(record.duplicate === true ? { duplicate: true } : {}),
			...(typeof record.ignored === "string" ? { ignored: record.ignored } : {}),
			...(typeof record.error === "string" ? { error: record.error } : {}),
		};
	}

	async listJobs(repo: string, limit: number): Promise<WorkerJobState[]> {
		const query = `repo=${encodeURIComponent(repo)}&limit=${limit}`;
		const body = await this.request("GET", `/api/jobs?${query}`);
		const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
		return Array.isArray(record.jobs) ? (record.jobs as WorkerJobState[]) : [];
	}

	async jobByDispatchKey(dispatchKey: string): Promise<WorkerJobDetail | null> {
		const body = await this.request(
			"GET",
			`/api/jobs?dispatchKey=${encodeURIComponent(dispatchKey)}`,
		);
		if (typeof body !== "object" || body === null) return null;
		const record = body as Record<string, unknown>;
		return typeof record.job === "object" && record.job !== null
			? (record as unknown as WorkerJobDetail)
			: null;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.secret}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			throw new WorkerRequestError(
				error instanceof Error ? error.message : String(error),
				null,
			);
		}
		const text = await response.text();
		let parsed: unknown = null;
		if (text !== "") {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = null;
			}
		}
		if (!response.ok) {
			const message =
				typeof parsed === "object" &&
				parsed !== null &&
				typeof (parsed as Record<string, unknown>).error === "string"
					? String((parsed as Record<string, unknown>).error)
					: `worker responded ${response.status}`;
			throw new WorkerRequestError(message, response.status);
		}
		return parsed;
	}
}
