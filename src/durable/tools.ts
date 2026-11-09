import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";

export { buildShellEnvironment } from "../shell-env.ts";
import { buildShellEnvironment } from "../shell-env.ts";

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

