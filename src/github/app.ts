import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";

export interface GitHubClients {
	app: Octokit;
	installation(installationId: number): Octokit;
}

function octokitLogger(logger: Logger | undefined) {
	if (!logger) return undefined;
	return {
		debug: (message: string) => logger.debug(message),
		info: (message: string) => logger.debug(message),
		warn: (message: string) => logger.debug(message),
		error: (message: string) => logger.warn(message),
	};
}

export function createGitHubClients(
	config: Pick<AppConfig, "appId" | "privateKey">,
	logger?: Logger,
): GitHubClients {
	const log = octokitLogger(logger);
	const app = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: config.appId,
			privateKey: config.privateKey,
		},
		...(log ? { log } : {}),
	});

	const installationCache = new Map<number, Octokit>();

	return {
		app,
		installation(installationId: number): Octokit {
			const cached = installationCache.get(installationId);
			if (cached) {
				return cached;
			}
			const octokit = new Octokit({
				authStrategy: createAppAuth,
				auth: {
					appId: config.appId,
					privateKey: config.privateKey,
					installationId,
				},
				...(log ? { log } : {}),
			});
			installationCache.set(installationId, octokit);
			return octokit;
		},
	};
}

export interface ClassifiedGitHubError {
	status: number | null;
	retryable: boolean;
	message: string;
}

export function classifyGitHubError(error: unknown): ClassifiedGitHubError {
	if (typeof error !== "object" || error === null) {
		return { status: null, retryable: true, message: String(error) };
	}

	const candidate = error as {
		status?: unknown;
		message?: unknown;
		response?: { headers?: Record<string, string | undefined> };
	};
	const status = typeof candidate.status === "number" ? candidate.status : null;
	const message = typeof candidate.message === "string" ? candidate.message : String(error);
	const remaining = candidate.response?.headers?.["x-ratelimit-remaining"];
	const retryAfter = candidate.response?.headers?.["retry-after"];

	if (status === 429 || (status === 403 && (remaining === "0" || retryAfter !== undefined))) {
		return { status, retryable: true, message };
	}
	if (status !== null && status >= 500) {
		return { status, retryable: true, message };
	}
	if (status === null) {
		return { status, retryable: true, message };
	}
	return { status, retryable: false, message };
}
