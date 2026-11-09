import type { Models } from "@earendil-works/pi-ai/models";

const empty = () => [];
const emptyAsync = async () => [];
const unavailable = (): never => {
	throw new Error("This host does not run model calls.");
};

export function createNoModels(): Models {
	return {
		getProviders: empty,
		getProvider: () => undefined,
		getModels: empty,
		getModel: () => undefined,
		getModelsOfType: empty,
		getModelOfType: () => undefined,
		getAllModels: empty,
		refresh: async () => ({ aborted: false, errors: new Map() }),
		checkAuth: async () => undefined,
		getAvailable: emptyAsync,
		getAvailableOfType: emptyAsync,
		getAllAvailable: emptyAsync,
		getAuth: async () => undefined,
		login: async () => unavailable(),
		logout: async () => {},
		stream: unavailable,
		complete: async () => unavailable(),
		streamSimple: unavailable,
		completeSimple: async () => unavailable(),
		streamDeferred: unavailable,
		fetchDeferred: async () => unavailable(),
		cancelDeferred: async () => {},
		generateImages: async () => unavailable(),
		classify: async () => unavailable(),
	} as unknown as Models;
}
