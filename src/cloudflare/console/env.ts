import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ConsoleConfig } from "../../console/runtime.ts";

export interface ConsoleEnv {
	CONSOLE: DurableObjectNamespace;
	PIG_CONSOLE_TOKEN?: string;
	PIG_CONSOLE_TABLE_PREFIX?: string;
	PIG_CONSOLE_ENROLLMENT_TTL_MINUTES?: string;
	PIG_CONSOLE_OBSERVATION_SECONDS?: string;
	PIG_CONSOLE_DISPATCH_DEADLINE_MINUTES?: string;
	PIG_CONSOLE_MODEL?: string;
	PIG_CONSOLE_THINKING?: string;
	ANTHROPIC_API_KEY?: string;
	OPENAI_API_KEY?: string;
	DEEPSEEK_API_KEY?: string;
	GEMINI_API_KEY?: string;
	OPENROUTER_API_KEY?: string;
}

function positiveMinutes(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 60_000) : fallback;
}

export function consoleConfig(env: ConsoleEnv): ConsoleConfig {
	const tablePrefix = env.PIG_CONSOLE_TABLE_PREFIX?.trim() ?? "console_";
	if (tablePrefix !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablePrefix)) {
		throw new Error("PIG_CONSOLE_TABLE_PREFIX must be a SQLite identifier prefix");
	}
	return {
		adminToken: env.PIG_CONSOLE_TOKEN?.trim() || undefined,
		tablePrefix,
		enrollmentTtlMs: positiveMinutes(env.PIG_CONSOLE_ENROLLMENT_TTL_MINUTES, 60 * 60_000),
		observationTtlMs: positiveMinutes(env.PIG_CONSOLE_OBSERVATION_SECONDS, 15_000),
		dispatchDeadlineMs: positiveMinutes(env.PIG_CONSOLE_DISPATCH_DEADLINE_MINUTES, 24 * 60 * 60_000),
		workerTimeoutMs: 20_000,
		logLevel: "info",
		model: env.PIG_CONSOLE_MODEL?.trim() || null,
		thinking: env.PIG_CONSOLE_THINKING?.trim() || null,
	};
}
