import {
	defineExtension,
	defineTool,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context, JsonValue } from "@earendil-works/chord";
import { AgentWorkspaceDoc } from "./agent-workspace-doc.ts";
import type { RemoteRunnerClient } from "./remote-runner.ts";

type Json = { [key: string]: JsonValue };

const pathSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path relative to the repository checkout." },
	},
	required: ["path"],
	additionalProperties: false,
} as const;

const readSchema = pathSchema;

const writeSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path relative to the repository checkout." },
		content: { type: "string", description: "Full file content." },
	},
	required: ["path", "content"],
	additionalProperties: false,
} as const;

const editSchema = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path relative to the repository checkout." },
		edits: {
			type: "array",
			items: {
				type: "object",
				properties: {
					oldText: { type: "string" },
					newText: { type: "string" },
				},
				required: ["oldText", "newText"],
				additionalProperties: false,
			},
		},
	},
	required: ["path", "edits"],
	additionalProperties: false,
} as const;

const listSchema = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description: "Directory relative to the repository checkout; defaults to the root.",
		},
	},
	additionalProperties: false,
} as const;

const bashSchema = {
	type: "object",
	properties: {
		command: { type: "string", description: "Shell command to run in the checkout." },
		timeout: { type: "number", description: "Timeout in seconds." },
	},
	required: ["command"],
	additionalProperties: false,
} as const;

function textResult(text: string, details?: Json) {
	return {
		output: [{ type: "text" as const, text }],
		...(details ? { details } : {}),
	};
}

function errorResult(text: string) {
	return { output: [{ type: "text" as const, text }], isError: true };
}

async function workspaceIdFor(
	api: ToolExecutionApi,
	context: Context,
): Promise<string> {
	const doc = await api.snapshot(AgentWorkspaceDoc, api.conversationId, context);
	if (!doc?.workspaceId) {
		throw new Error("This conversation has no remote workspace.");
	}
	return doc.workspaceId;
}

function isReviewResultPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
	return normalized === ".pig/review.json";
}

function createReadTool(client: RemoteRunnerClient) {
	return defineTool({
		name: "read",
		description: "Read a text file from the repository checkout.",
		parameters: readSchema,
		execute: async (args, api, context) => {
			const { path } = args as { path: string };
			const content = await client.read(await workspaceIdFor(api, context), path);
			return content.content === null
				? errorResult(`File not found: ${path}`)
				: textResult(content.content, { path });
		},
	});
}

function createListTool(client: RemoteRunnerClient) {
	return defineTool({
		name: "list",
		description: "List a directory in the repository checkout.",
		parameters: listSchema,
		execute: async (args, api, context) => {
			const { path } = args as { path?: string };
			const result = await client.list(
				await workspaceIdFor(api, context),
				path ?? ".",
			);
			const text = result.entries
				.map((entry) =>
					entry.kind === "directory" ? `${entry.name}/` : entry.name,
				)
				.join("\n");
			return textResult(text || "(empty)", { path: path ?? "." });
		},
	});
}

function createWriteTool(client: RemoteRunnerClient, reviewOnly: boolean) {
	return defineTool({
		name: "write",
		description: reviewOnly
			? "Write the review result to .pig/review.json."
			: "Create or overwrite a file in the repository checkout.",
		parameters: writeSchema,
		execute: async (args, api, context) => {
			const { path, content } = args as { path: string; content: string };
			if (reviewOnly && !isReviewResultPath(path)) {
				return errorResult("Review jobs may only write .pig/review.json.");
			}
			await client.write(await workspaceIdFor(api, context), path, content);
			return textResult(`Wrote ${path}`, { path });
		},
	});
}

function createEditTool(client: RemoteRunnerClient) {
	return defineTool({
		name: "edit",
		description: "Replace exact text in a file in the repository checkout.",
		parameters: editSchema,
		execute: async (args, api, context) => {
			const { path, edits } = args as {
				path: string;
				edits: { oldText: string; newText: string }[];
			};
			await client.edit(await workspaceIdFor(api, context), path, edits);
			return textResult(`Edited ${path}`, { path, edits: edits.length });
		},
	});
}

function createBashTool(client: RemoteRunnerClient) {
	return defineTool({
		name: "bash",
		description: "Run a shell command in the repository checkout.",
		parameters: bashSchema,
		execute: async (args, api, context) => {
			const { command, timeout } = args as { command: string; timeout?: number };
			const result = await client.bash(
				await workspaceIdFor(api, context),
				command,
				timeout,
			);
			const text = result.exitCode === 0
				? result.output
				: `${result.output}\n[exit code ${result.exitCode}]`;
			return {
				output: [{ type: "text" as const, text }],
				...(result.exitCode === 0 ? {} : { isError: true }),
				details: {
					exitCode: result.exitCode,
					truncated: result.truncated,
				},
			};
		},
	});
}

export function createRemoteWorkTools(client: RemoteRunnerClient): Extension {
	return defineExtension({
		name: "pig.remote-work-tools",
		tools: [
			createReadTool(client),
			createListTool(client),
			createWriteTool(client, false),
			createEditTool(client),
			createBashTool(client),
		],
	});
}

export function createRemoteReviewTools(client: RemoteRunnerClient): Extension {
	return defineExtension({
		name: "pig.remote-review-tools",
		tools: [
			createReadTool(client),
			createListTool(client),
			createWriteTool(client, true),
		],
	});
}
