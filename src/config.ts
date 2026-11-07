import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isLogLevel, type LogLevel } from "./logger.ts";

export interface AppConfig {
	appId: number;
	privateKey: string;
	webhookSecret: string;
	appSlug: string;
	port: number;
	databasePath: string;
	workspaceRoot: string;
	model: string | undefined;
	thinking: string | undefined;
	tablePrefix: string;
	jobTimeoutMs: number;
	logLevel: LogLevel;
	adminToken: string | undefined;
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable ${name}`);
	}
	return value;
}

function readPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") {
		return fallback;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function loadPrivateKey(env: NodeJS.ProcessEnv): string {
	const inline = env.PIG_GITHUB_PRIVATE_KEY?.trim();
	if (inline) {
		return inline.replace(/\\n/g, "\n");
	}
	const path = env.PIG_GITHUB_PRIVATE_KEY_PATH?.trim();
	if (!path) {
		throw new Error("Set PIG_GITHUB_PRIVATE_KEY or PIG_GITHUB_PRIVATE_KEY_PATH");
	}
	return readFileSync(resolve(path), "utf8");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const appId = Number(requireValue(env, "PIG_GITHUB_APP_ID"));
	if (!Number.isInteger(appId) || appId <= 0) {
		throw new Error("PIG_GITHUB_APP_ID must be a positive integer");
	}

	const databasePath = resolve(env.PIG_DATABASE_PATH?.trim() || "./data/pig.sqlite");
	const workspaceRoot = resolve(
		env.PIG_WORKSPACE_ROOT?.trim() || "./data/workspaces",
	);

	const jobTimeoutMinutes = readPositiveInteger(env, "PIG_JOB_TIMEOUT_MINUTES", 30);
	const tablePrefix = env.PIG_TABLE_PREFIX === undefined ? "pig_" : env.PIG_TABLE_PREFIX.trim();
	if (tablePrefix !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablePrefix)) {
		throw new Error("PIG_TABLE_PREFIX must be a SQLite identifier prefix");
	}
	if (tablePrefix.startsWith("sqlite_")) {
		throw new Error("PIG_TABLE_PREFIX cannot start with sqlite_");
	}

	const logLevelRaw = env.PIG_LOG_LEVEL?.trim() || "info";
	if (!isLogLevel(logLevelRaw)) {
		throw new Error("PIG_LOG_LEVEL must be one of debug, info, warn, error");
	}

	const port = readPositiveInteger(env, "PIG_PORT", 8787);
	if (port > 65535) {
		throw new Error("PIG_PORT must be a valid TCP port");
	}

	return {
		appId,
		privateKey: loadPrivateKey(env),
		webhookSecret: requireValue(env, "PIG_WEBHOOK_SECRET"),
		appSlug: env.PIG_APP_SLUG?.trim() || "pig",
		port,
		databasePath,
		workspaceRoot,
		model: env.PIG_MODEL?.trim() || undefined,
		thinking: env.PIG_THINKING?.trim() || undefined,
		tablePrefix,
		jobTimeoutMs: jobTimeoutMinutes * 60 * 1000,
		logLevel: logLevelRaw,
		adminToken: env.PIG_ADMIN_TOKEN?.trim() || undefined,
	};
}
