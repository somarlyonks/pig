import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export class ModelResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelResolutionError";
	}
}

export interface ModelRequest {
	spec: string | null;
	thinking: string | null;
}

export interface ResolvedModel {
	ref: ModelRef;
	model: Model<Api>;
	thinking: ModelThinkingLevel | null;
}

export function isThinkingLevel(value: string): value is ModelThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function createModelRuntime(): MutableModels {
	return createModels();
}

function splitProvider(
	models: Models,
	spec: string,
): { provider: string | null; modelId: string } {
	const slash = spec.indexOf("/");
	if (slash > 0) {
		const provider = spec.slice(0, slash);
		if (models.getProvider(provider)) {
			return { provider, modelId: spec.slice(slash + 1) };
		}
	}
	return { provider: null, modelId: spec };
}

function parseRequest(
	modelSpec: string | null | undefined,
	thinkingSpec: string | null | undefined,
): ModelRequest {
	let spec = modelSpec?.trim() || null;
	let thinking = thinkingSpec?.trim() || null;

	if (spec) {
		const lastColon = spec.lastIndexOf(":");
		if (lastColon > 0) {
			const suffix = spec.slice(lastColon + 1);
			if (isThinkingLevel(suffix)) {
				thinking = thinking ?? suffix;
				spec = spec.slice(0, lastColon);
			}
		}
	}

	if (thinking !== null && !isThinkingLevel(thinking)) {
		throw new ModelResolutionError(
			`Invalid thinking level "${thinking}". Use ${THINKING_LEVELS.join(", ")}.`,
		);
	}

	return { spec, thinking };
}

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function findModel(
	models: Models,
	request: ModelRequest,
	available: readonly Model<Api>[],
): Model<Api> | null {
	if (request.spec === null) {
		return null;
	}
	const { provider, modelId } = splitProvider(models, request.spec);
	const matches = (model: Model<Api>): boolean =>
		provider === null || model.provider === provider;
	const exact = available.find(
		(model) => matches(model) && model.id.toLowerCase() === modelId.toLowerCase(),
	);
	if (exact) return exact;
	const fuzzy = available.find(
		(model) =>
			matches(model) &&
			(model.id.toLowerCase().includes(modelId.toLowerCase()) ||
				model.name.toLowerCase().includes(modelId.toLowerCase())),
	);
	if (fuzzy) return fuzzy;
	const all = models.getModels();
	return (
		all.find(
			(model) => matches(model) && model.id.toLowerCase() === modelId.toLowerCase(),
		) ??
		all.find(
			(model) =>
				matches(model) &&
				(model.id.toLowerCase().includes(modelId.toLowerCase()) ||
					model.name.toLowerCase().includes(modelId.toLowerCase())),
		) ??
		null
	);
}

function availableSummary(available: readonly Model<Api>[]): string {
	if (available.length === 0) {
		return "No model providers have credentials configured. Set a provider API key (for example ANTHROPIC_API_KEY or OPENAI_API_KEY).";
	}
	const labels = available.slice(0, 12).map(modelLabel).join(", ");
	return `Available models: ${labels}${available.length > 12 ? ", …" : ""}.`;
}

export async function resolveModel(
	models: Models,
	modelSpec: string | null | undefined,
	thinkingSpec: string | null | undefined,
): Promise<ResolvedModel> {
	const request = parseRequest(modelSpec, thinkingSpec);
	const available = (await models.getAvailable()) as readonly Model<Api>[];

	if (request.spec === null) {
		const fallback = available[0];
		if (!fallback) {
			throw new ModelResolutionError(availableSummary(available));
		}
		return {
			ref: { provider: fallback.provider, modelId: fallback.id },
			model: fallback,
			thinking: request.thinking as ModelThinkingLevel | null,
		};
	}

	const model = findModel(models, request, available);
	if (!model) {
		throw new ModelResolutionError(
			`Could not find model "${request.spec}". ${availableSummary(available)}`,
		);
	}
	return {
		ref: { provider: model.provider, modelId: model.id },
		model,
		thinking: request.thinking as ModelThinkingLevel | null,
	};
}

