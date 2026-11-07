import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	AssistantEntry,
	type Conversation,
	type Harness,
	type ConversationId,
	type ModelRef,
	type Submission,
	type SettledSubmissionRecord,
	type TaskId,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentRunOptions, AgentRunResult } from "../jobs/context.ts";
import type { Logger } from "../logger.ts";
import { JobDoc } from "./docs.ts";
import { ReviewTools, WorkTools } from "./tools.ts";

export interface DurableAgentConfig {
	harness: Harness;
	jobId: string;
	taskId: TaskId;
	attempt: number;
	model: ModelRef;
	thinking: ModelThinkingLevel | null;
	maxTurns: number;
	instructions: string;
	logger: Logger;
}

interface EntryLike {
	kind: string;
	model?: readonly unknown[];
}

export function assistantText(entries: readonly EntryLike[]): string {
	for (const entry of entries) {
		if (entry.kind !== AssistantEntry.kind) continue;
		const parts: string[] = [];
		for (const raw of entry.model ?? []) {
			const message = raw as { role?: string; content?: unknown };
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				const candidate = block as { type?: string; text?: string };
				if (candidate.type === "text" && typeof candidate.text === "string") {
					parts.push(candidate.text);
				}
			}
		}
		const text = parts.join("\n").trim();
		if (text !== "") return text;
	}
	return "";
}

function failure(reason: string, detail: JsonValue | undefined, aborted: boolean): AgentRunResult {
	if (aborted || reason === "aborted") {
		return {
			status: "aborted",
			finalText: "",
			error: "The agent run was cancelled.",
			retryable: false,
		};
	}
	const retryable =
		reason === "model_error" || reason === "interrupted" || reason === "unknown";
	const suffix =
		detail === undefined
			? ""
			: `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.slice(0, 3000);
	return {
		status: "failed",
		finalText: "",
		error: `Pi could not finish this run (${reason})${suffix}`,
		retryable,
	};
}

async function conversationFor(
	config: DurableAgentConfig,
	options: AgentRunOptions,
	context: Context,
): Promise<Conversation> {
	const existing = await config.harness.snapshot(JobDoc, config.jobId, context);
	if (existing?.conversationId && existing.conversationAttempt === config.attempt) {
		const conversation = await config.harness.conversation(
			existing.conversationId as ConversationId,
			context,
		);
		if (conversation) return conversation;
	}
	const created = await config.harness.createConversation(
		{
			ownership: { kind: "task", taskId: config.taskId },
			agent: {
				model: config.model,
				...(config.thinking ? { thinkingLevel: config.thinking } : {}),
				cwd: options.cwd,
				extensions: [options.tools === "work" ? WorkTools : ReviewTools],
				instructions: config.instructions,
				maxTurns: config.maxTurns,
			},
			init: async (tx, conversationId) => {
				const doc = await tx.doc(JobDoc, config.jobId, null);
				doc.conversationId = conversationId;
				doc.conversationAttempt = config.attempt;
				doc.updatedAt = Date.now();
			},
		},
		context,
	);
	config.logger.debug("Created agent conversation", {
		conversationId: created.id,
		jobId: config.jobId,
		attempt: config.attempt,
	});
	return created;
}

export async function runDurableAgent(
	config: DurableAgentConfig,
	options: AgentRunOptions,
	context: Context,
): Promise<AgentRunResult> {
	let conversation: Conversation;
	try {
		conversation = await conversationFor(config, options, context);
	} catch (error) {
		return {
			status: "failed",
			finalText: "",
			error: `Could not prepare the Pi conversation: ${error instanceof Error ? error.message : String(error)}`,
			retryable: true,
		};
	}

	let submission: Submission;
	try {
		submission = await conversation.submit(
			{
				type: "input",
				content: options.prompt,
				requestId: `job:${config.jobId}:${config.attempt}`,
				whenBusy: "reject",
			},
			context,
		);
	} catch (error) {
		if (options.signal.aborted) {
			return failure("aborted", undefined, true);
		}
		return {
			status: "failed",
			finalText: "",
			error: `Could not submit work to Pi: ${error instanceof Error ? error.message : String(error)}`,
			retryable: true,
		};
	}

	options.onLog?.("Pi run started");
	let timedOut = false;
	const abortConversation = () => {
		void conversation.abort(BACKGROUND_CONTEXT).catch((error) => {
			config.logger.debug("Could not abort agent conversation", { error });
		});
	};
	const timer = setTimeout(() => {
		timedOut = true;
		config.logger.warn("Agent run timed out; aborting the conversation", {
			jobId: config.jobId,
			timeoutMs: options.timeoutMs,
		});
		abortConversation();
	}, options.timeoutMs);
	timer.unref();

	const waitPromise = submission.wait(context);
	const abortedSignal = new Promise<"aborted">((resolve) => {
		const onAbort = () => resolve("aborted");
		if (options.signal.aborted) {
			onAbort();
			return;
		}
		options.signal.addEventListener("abort", onAbort, { once: true });
	});

	let settled: SettledSubmissionRecord;
	try {
		const outcome = await Promise.race([waitPromise, abortedSignal]);
		if (outcome === "aborted") {
			waitPromise.catch(() => {});
			return failure("aborted", undefined, true);
		}
		settled = outcome;
	} catch (error) {
		if (options.signal.aborted) {
			return failure("aborted", undefined, true);
		}
		return {
			status: "failed",
			finalText: "",
			error: `Pi run failed: ${error instanceof Error ? error.message : String(error)}`,
			retryable: true,
		};
	} finally {
		clearTimeout(timer);
	}

	if (timedOut) {
		return {
			status: "timeout",
			finalText: "",
			error: "Pi timed out while working on this request.",
			retryable: false,
		};
	}
	if (options.signal.aborted) {
		return failure("aborted", undefined, true);
	}
	if (settled.status !== "done") {
		return failure(settled.reason, settled.detail, false);
	}

	options.onLog?.("Pi run finished");
	try {
		const page = await conversation.entries({}, 50, undefined, context);
		const answer =
			settled.answer !== undefined
				? page.items.find((entry) => entry.id === settled.answer)
				: undefined;
		return {
			status: "done",
			finalText: assistantText(answer ? [answer] : page.items),
			error: null,
			retryable: false,
		};
	} catch (error) {
		return {
			status: "done",
			finalText: "",
			error: `Could not read the agent answer: ${error instanceof Error ? error.message : String(error)}`,
			retryable: false,
		};
	}
}
