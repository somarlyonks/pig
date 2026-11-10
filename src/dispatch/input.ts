import { isValidDispatchKey, type DispatchPlanInput } from "./plan.ts";

export interface DispatchEnvelopeInput {
	value: unknown;
	now: number;
}

export type DispatchEnvelopeResult =
	| { ok: true; input: DispatchPlanInput }
	| { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function parseDispatchEnvelope(
	options: DispatchEnvelopeInput,
): DispatchEnvelopeResult {
	const record = asRecord(options.value);
	if (!record) {
		return { ok: false, error: "body must be a JSON object" };
	}
	const capability = record.capability;
	if (typeof capability !== "string" || capability === "") {
		return { ok: false, error: "capability is required" };
	}
	const params = asRecord(record.params) ?? {};
	const dispatchKey = record.dispatchKey;
	if (!isValidDispatchKey(dispatchKey)) {
		return { ok: false, error: "dispatchKey is required and must be stable" };
	}
	const actor = record.actor;
	if (typeof actor !== "string" || actor === "") {
		return { ok: false, error: "actor is required" };
	}
	const rawNotAfter = record.notAfter;
	const notAfter =
		typeof rawNotAfter === "number" && Number.isFinite(rawNotAfter) ? rawNotAfter : null;
	return {
		ok: true,
		input: {
			capability,
			params,
			dispatchKey,
			actor,
			receivedAt: options.now,
			notAfter,
		},
	};
}
