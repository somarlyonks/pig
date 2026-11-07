import { spawn } from "node:child_process";

export interface AgentRunOptions {
	cwd: string;
	prompt: string;
	tools: string[];
	model: string | null;
	thinking: string | null;
	timeoutMs: number;
	signal: AbortSignal;
	onLog?: (message: string) => void;
}

export interface AgentRunResult {
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	finalText: string;
	stderr: string;
}

export type AgentRunner = (options: AgentRunOptions) => Promise<AgentRunResult>;

export class AgentStartError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentStartError";
	}
}

const ALLOWED_ENV_KEYS = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"SYSTEMROOT",
	"COMSPEC",
	"PATHEXT",
	"CI",
	"NO_COLOR",
]);

const ALLOWED_ENV_PREFIXES = [
	"PI_",
	"ANTHROPIC_",
	"OPENAI_",
	"ANT_LING_",
	"DEEPSEEK_",
	"NVIDIA_",
	"GEMINI_",
	"COPILOT_",
	"MISTRAL_",
	"GROQ_",
	"CEREBRAS_",
	"XAI_",
	"OPENROUTER_",
	"AI_GATEWAY_",
	"ZAI_",
	"OPENCODE_",
	"RADIUS_",
	"TYPESAFE_",
	"HF_",
	"FIREWORKS_",
	"TOGETHER_",
	"BASETEN_",
	"KIMI_",
	"META_",
	"MINIMAX_",
	"MOONSHOT_",
	"QWEN_",
	"XIAOMI_",
	"CLOUDFLARE_",
	"AZURE_OPENAI_",
];

const ALLOWED_PROVIDER_KEYS = new Set([
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GCLOUD_PROJECT",
]);

export function buildAgentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined || key.startsWith("PIG_") || key.startsWith("GITHUB_") || key.startsWith("GH_")) {
			continue;
		}
		if (
			ALLOWED_ENV_KEYS.has(key) ||
			ALLOWED_PROVIDER_KEYS.has(key) ||
			ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
		) {
			environment[key] = value;
		}
	}
	environment.CI = "1";
	environment.NO_COLOR = "1";
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GCM_INTERACTIVE = "never";
	return environment;
}

function extractAssistantText(message: unknown): string | null {
	if (typeof message !== "object" || message === null) {
		return null;
	}
	const record = message as { role?: unknown; content?: unknown };
	if (record.role !== "assistant") {
		return null;
	}
	if (typeof record.content === "string") {
		return record.content.trim() || null;
	}
	if (!Array.isArray(record.content)) {
		return null;
	}
	const parts: string[] = [];
	for (const block of record.content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") {
			parts.push(candidate.text);
		}
	}
	const text = parts.join("\n").trim();
	return text || null;
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		// The process group is already gone.
	}
}

function terminateProcessGroup(child: ReturnType<typeof spawn>): void {
	if (!child.pid) {
		return;
	}
	const kill = (signal: NodeJS.Signals) => {
		try {
			process.kill(-child.pid!, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// The process already exited.
			}
		}
	};
	kill("SIGTERM");
	const timer = setTimeout(() => kill("SIGKILL"), 5000);
	timer.unref();
}

export function runPiAgent(
	bin: string,
	options: AgentRunOptions,
): Promise<AgentRunResult> {
	const args = [
		"--print",
		"--mode",
		"json",
		"--no-session",
		"--no-extensions",
		"--no-mcp",
		"--tools",
		options.tools.join(","),
	];
	if (options.model) args.push("--model", options.model);
	if (options.thinking) args.push("--thinking", options.thinking);
	args.push("--", options.prompt);

	return new Promise<AgentRunResult>((resolvePromise, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(bin, args, {
				cwd: options.cwd,
				env: buildAgentEnvironment(),
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			reject(
				new AgentStartError(
					`Could not start Pi (${bin}): ${error instanceof Error ? error.message : String(error)}`,
				),
			);
			return;
		}

		let timedOut = false;
		let aborted = false;
		let settled = false;
		let stdoutBuffer = "";
		let stderr = "";
		let finalText = "";

		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			options.signal.removeEventListener("abort", onAbort);
			resolvePromise({
				exitCode,
				timedOut,
				aborted,
				finalText,
				stderr: stderr.slice(-16_000),
			});
		};

		const handleLine = (line: string) => {
			if (line.trim() === "") return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				options.onLog?.(`Unparseable Pi output line (${line.length} bytes)`);
				return;
			}
			if (typeof event !== "object" || event === null) return;
			const record = event as {
				type?: unknown;
				message?: unknown;
				assistantMessageEvent?: { type?: unknown; toolCall?: { toolName?: unknown } };
			};
			if (record.type === "message_end") {
				const text = extractAssistantText(record.message);
				if (text) finalText = text;
			}
			if (record.type === "message_update" && record.assistantMessageEvent?.type === "toolcall_end") {
				const toolName = record.assistantMessageEvent.toolCall?.toolName;
				if (typeof toolName === "string") {
					options.onLog?.(`Tool: ${toolName}`);
				}
			}
		};

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			terminateProcessGroup(child);
		}, options.timeoutMs);

		const onAbort = () => {
			if (aborted) return;
			aborted = true;
			terminateProcessGroup(child);
		};

		if (options.signal.aborted) {
			onAbort();
		} else {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			let newline = stdoutBuffer.indexOf("\n");
			while (newline >= 0) {
				const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				handleLine(line);
				newline = stdoutBuffer.indexOf("\n");
			}
		});

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-32_000);
		});

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			options.signal.removeEventListener("abort", onAbort);
			reject(new AgentStartError(`Pi process error: ${error.message}`));
		});

		child.on("close", (code) => {
			if (stdoutBuffer.trim() !== "") {
				handleLine(stdoutBuffer);
				stdoutBuffer = "";
			}
			killProcessGroup(child, "SIGKILL");
			finish(code);
		});
	});
}
