import type { CapabilityDescriptor, CapabilityParameter } from "../dispatch/capabilities.ts";

function matchesType(parameter: CapabilityParameter, value: unknown): boolean {
	switch (parameter.type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
	}
}

/**
 * The console and the worker both check parameters, from the descriptor the
 * worker published. The worker is always the authority; this only rejects
 * obvious mistakes before a command becomes a job.
 */
export function validateParameters(
	capability: CapabilityDescriptor,
	params: Record<string, unknown>,
): string | null {
	for (const parameter of capability.parameters) {
		const value = params[parameter.name];
		if (value === undefined || value === null) {
			if (parameter.required) {
				return `${parameter.name} is required`;
			}
			continue;
		}
		if (!matchesType(parameter, value)) {
			return `${parameter.name} must be a ${parameter.type}`;
		}
		if (parameter.values && !parameter.values.includes(String(value))) {
			return `${parameter.name} must be one of ${parameter.values.join(", ")}`;
		}
	}
	return null;
}
