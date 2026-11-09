import type { AppConfig } from "../config.ts";
import type { CloudflareEnv } from "./env.ts";

function required(env: CloudflareEnv, name: keyof CloudflareEnv): string {
	const value = env[name];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Missing Cloudflare secret ${String(name)}`);
	}
	return value.trim();
}

export function cloudflareConfig(env: CloudflareEnv): AppConfig {
	const appId = Number(required(env, "PIG_GITHUB_APP_ID"));
	if (!Number.isInteger(appId) || appId <= 0) {
		throw new Error("PIG_GITHUB_APP_ID must be a positive integer");
	}
	const tablePrefix = env.PIG_TABLE_PREFIX?.trim() ?? "pig_";
	if (tablePrefix !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablePrefix)) {
		throw new Error("PIG_TABLE_PREFIX must be a SQLite identifier prefix");
	}
	return {
		appId,
		privateKey: required(env, "PIG_GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n"),
		webhookSecret: required(env, "PIG_WEBHOOK_SECRET"),
		appSlug: env.PIG_APP_SLUG?.trim() || "pig",
		port: 0,
		databasePath: ":do:",
		workspaceRoot: "/tmp/pig",
		model: undefined,
		thinking: undefined,
		tablePrefix,
		jobTimeoutMs: 30 * 60_000,
		logLevel: "info",
		adminToken: env.PIG_ADMIN_TOKEN?.trim() || undefined,
	};
}
