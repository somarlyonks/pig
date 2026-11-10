import type { CapabilityDescriptor } from "../dispatch/capabilities.ts";

export interface WorkerHandlerContext {
	dispatchKey: string;
	actor: string;
	receivedAt: number;
	notAfter: number | null;
}

export interface WorkerHandlerResult {
	/** An id the console can show. PiG uses its job id; another agent may use its own. */
	jobId?: string | null;
	result?: Record<string, unknown>;
}

export interface WorkerHandler {
	capability: CapabilityDescriptor;
	execute(
		params: Record<string, unknown>,
		context: WorkerHandlerContext,
	): Promise<WorkerHandlerResult>;
}

export interface IdempotencyStore {
	get(dispatchKey: string): Promise<WorkerHandlerResult | null> | WorkerHandlerResult | null;
	set(dispatchKey: string, result: WorkerHandlerResult): Promise<void> | void;
}

export function memoryIdempotencyStore(): IdempotencyStore {
	const results = new Map<string, WorkerHandlerResult>();
	return {
		get: (dispatchKey) => results.get(dispatchKey) ?? null,
		set: (dispatchKey, result) => {
			results.set(dispatchKey, result);
		},
	};
}

export interface WorkerKitOptions {
	name: string;
	version: string;
	/** The bearer token the console must present. Without one every route is 404. */
	secret: string | undefined;
	handlers: WorkerHandler[];
	store?: IdempotencyStore;
	now?: () => number;
}

export interface WorkerKit {
	name: string;
	version: string;
	capabilities: CapabilityDescriptor[];
	handle(request: Request): Promise<Response>;
}
