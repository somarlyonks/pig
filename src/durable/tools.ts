import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";

const SAFE_SHELL_KEYS = [
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
];

export function buildShellEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of SAFE_SHELL_KEYS) {
		const value = source[key];
		if (typeof value === "string" && value !== "") {
			environment[key] = value;
		}
	}
	environment.CI = "1";
	environment.NO_COLOR = "1";
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GCM_INTERACTIVE = "never";
	return environment;
}

const shellEnvironment = buildShellEnvironment();

const bash = createBashTool({
	prepare: (execution) => {
		execution.inheritEnv = false;
		execution.env = { ...shellEnvironment };
	},
});

export const WorkTools = defineExtension({
	name: "pig.work-tools",
	tools: [createReadTool(), createWriteTool(), createEditTool(), bash],
});

export function normalizeToolPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isAllowedReviewWritePath(path: string): boolean {
	const normalized = normalizeToolPath(path);
	if (normalized === "" || normalized.startsWith("/") || normalized.includes("\0")) {
		return false;
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => segment === ".." || segment === "" || segment === ".")) {
		return false;
	}
	return normalized === ".pig/review.json";
}

export const reviewWriteGuard = hook(ToolTask, {
	beforeTool: (call) => {
		if (call.name !== "write") {
			return undefined;
		}
		const path = call.arguments["path"];
		if (typeof path !== "string" || !isAllowedReviewWritePath(path)) {
			return {
				block: "Review jobs may only write .pig/review.json.",
			};
		}
		return undefined;
	},
});

export const ReviewTools = defineExtension({
	name: "pig.review-tools",
	tools: [createReadTool(), createWriteTool()],
	hooks: [reviewWriteGuard],
});

