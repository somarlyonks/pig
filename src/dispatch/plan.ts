import type {
	JobKind,
	JobRequest,
	JobSource,
	ReleaseBump,
	ReviewSource,
	TriggerContext,
	WorkSource,
	WorkTarget,
} from "../jobs/types.ts";
import type { AdmissionPlan } from "../webhooks/plan.ts";

export const MAX_DISPATCH_KEY_LENGTH = 200;
const MAX_INSTRUCTIONS_LENGTH = 20_000;

const DISPATCH_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ACTOR_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const EMPTY_TRIGGER: TriggerContext = {
	commentId: null,
	commentBody: null,
	commentAuthor: null,
	reviewComment: null,
};

export interface DispatchPlanInput {
	capability: string;
	params: Record<string, unknown>;
	dispatchKey: string;
	actor: string;
	receivedAt: number;
	notAfter: number | null;
}

export type DispatchPlan =
	| { kind: "admit"; admission: AdmissionPlan }
	| { kind: "reject"; status: number; error: string };

export function isValidDispatchKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_DISPATCH_KEY_LENGTH &&
		DISPATCH_KEY_PATTERN.test(value)
	);
}

export function dispatchIdempotencyKey(dispatchKey: string): string {
	return `dispatch:${dispatchKey}`;
}

export function dispatchRepository(params: Record<string, unknown>): string | null {
	const repo = readString(params, "repo");
	if (!repo || !REPOSITORY_PATTERN.test(repo)) return null;
	return repo;
}

function reject(status: number, error: string): DispatchPlan {
	return { kind: "reject", status, error };
}

function readString(params: Record<string, unknown>, name: string): string | null {
	const value = params[name];
	return typeof value === "string" ? value : null;
}

function readNumber(params: Record<string, unknown>, name: string): number | null {
	const value = params[name];
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readBoolean(params: Record<string, unknown>, name: string): boolean | null {
	const value = params[name];
	return typeof value === "boolean" ? value : null;
}

function readChoice<T extends string>(
	params: Record<string, unknown>,
	name: string,
	values: readonly T[],
): T | null | "invalid" {
	const value = params[name];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !values.includes(value as T)) return "invalid";
	return value as T;
}

function firstLine(text: string): string {
	const line = text.split("\n", 1)[0]?.trim() ?? "";
	return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function workSource(
	params: Record<string, unknown>,
	instructions: string,
): { source: WorkSource; target: WorkTarget } | { error: string } {
	const anchor = readNumber(params, "anchor");
	const target = readChoice(params, "target", ["new", "head", "patch"] as const);
	if (target === "invalid") {
		return { error: "params.target must be new, head, or patch" };
	}
	const title = readString(params, "title")?.trim() || null;

	if (anchor === null) {
		if (target !== null && target !== "new") {
			return { error: "a generated anchor only supports the new target" };
		}
		return {
			source: { type: "generated", number: null, title: title ?? firstLine(instructions) },
			target: "new",
		};
	}
	if (anchor <= 0) {
		return { error: "params.anchor must be a positive number" };
	}
	const anchorType = readChoice(params, "anchorType", ["issue", "pull_request"] as const);
	if (anchorType === null) {
		return { error: "params.anchorType is required when params.anchor is set" };
	}
	if (anchorType === "invalid") {
		return { error: "params.anchorType must be issue or pull_request" };
	}
	const resolved = target ?? (anchorType === "pull_request" ? "head" : "new");
	if (anchorType === "issue" && resolved !== "new") {
		return { error: "an issue anchor only supports the new target" };
	}
	return { source: { type: anchorType, number: anchor, title }, target: resolved };
}

export function planDispatch(
	input: DispatchPlanInput,
	installationId: number,
): DispatchPlan {
	if (!ACTOR_PATTERN.test(input.actor)) {
		return reject(400, "actor must be a GitHub login");
	}
	const repo = dispatchRepository(input.params);
	if (!repo) {
		return reject(400, "params.repo must be owner/name");
	}

	const base = {
		origin: "console" as const,
		actor: input.actor,
		trigger: EMPTY_TRIGGER,
		receivedAt: input.receivedAt,
	};
	const key = dispatchIdempotencyKey(input.dispatchKey);

	const admitRequest = (
		jobKind: JobKind,
		request: JobRequest,
		options: { maxAttempts: number; chained: boolean },
	): DispatchPlan => ({
		kind: "admit",
		admission: {
			installationId,
			repo,
			jobKind,
			request,
			idempotencyKey: key,
			maxAttempts: options.maxAttempts,
			chained: options.chained,
		},
	});

	switch (input.capability) {
		case "pig.status":
			return admitRequest(
				"control",
				{
					kind: "control",
					action: "status",
					message: null,
					source: repositorySource(),
					...base,
				},
				{ maxAttempts: 1, chained: false },
			);
		case "pig.cancel":
			return admitRequest(
				"control",
				{
					kind: "control",
					action: "cancel",
					message: null,
					source: repositorySource(),
					...base,
				},
				{ maxAttempts: 1, chained: false },
			);
		case "pig.release": {
			const bump = readChoice(input.params, "bump", [
				"auto",
				"major",
				"minor",
				"patch",
			] as const);
			if (bump === "invalid") {
				return reject(400, "params.bump must be auto, major, minor, or patch");
			}
			return admitRequest(
				"release",
				{
					kind: "release",
					bump: (bump ?? "auto") as ReleaseBump,
					version: readString(input.params, "version"),
					draft: readBoolean(input.params, "draft"),
					prerelease: readBoolean(input.params, "prerelease"),
					source: repositorySource(),
					...base,
				},
				{ maxAttempts: 2, chained: true },
			);
		}
		case "pig.review": {
			const number = readNumber(input.params, "pullRequest");
			if (number === null || number <= 0) {
				return reject(400, "params.pullRequest must be a positive number");
			}
			const source: ReviewSource = { type: "pull_request", number, title: null };
			return admitRequest(
				"review",
				{
					kind: "review",
					auto: false,
					headSha: null,
					focus: readString(input.params, "focus"),
					source,
					...base,
				},
				{ maxAttempts: 2, chained: true },
			);
		}
		case "pig.work": {
			const instructions = readString(input.params, "instructions")?.trim() ?? "";
			if (instructions === "") {
				return reject(400, "params.instructions is required");
			}
			if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
				return reject(400, "params.instructions is too long");
			}
			const resolved = workSource(input.params, instructions);
			if ("error" in resolved) {
				return reject(400, resolved.error);
			}
			return admitRequest(
				"work",
				{
					kind: "work",
					instructions,
					source: resolved.source,
					target: resolved.target,
					...base,
				},
				{ maxAttempts: 2, chained: true },
			);
		}
		default:
			return reject(400, `unknown capability: ${input.capability}`);
	}
}

function repositorySource(): JobSource {
	return { type: "repository", number: null, title: null };
}
