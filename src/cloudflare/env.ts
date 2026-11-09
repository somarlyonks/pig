import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface CloudflareEnv {
	REPOS: DurableObjectNamespace;
	PIG_GITHUB_APP_ID: string;
	PIG_GITHUB_PRIVATE_KEY: string;
	PIG_WEBHOOK_SECRET: string;
	PIG_ADMIN_TOKEN?: string;
	PIG_APP_SLUG?: string;
	PIG_TABLE_PREFIX?: string;
	PIG_MODEL?: string;
	PIG_THINKING?: string;
	PIG_RUNNER_URL?: string;
	PIG_RUNNER_TOKEN?: string;
	ANTHROPIC_API_KEY?: string;
	OPENAI_API_KEY?: string;
	DEEPSEEK_API_KEY?: string;
	GEMINI_API_KEY?: string;
	OPENROUTER_API_KEY?: string;
}
