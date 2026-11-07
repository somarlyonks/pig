import type { ReleaseBump } from "../jobs/types.ts";
import { parseSemVer } from "../semver.ts";

export type ParsedCommand =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "cancel" }
	| { kind: "review"; focus: string | null }
	| ({ kind: "release" } & ReleaseCommand)
	| { kind: "work"; instructions: string }
	| { kind: "invalid"; message: string };

export interface ReleaseCommand {
	bump: ReleaseBump;
	version: string | null;
	draft: boolean | null;
	prerelease: boolean | null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findMention(body: string, appSlug: string): { index: number; length: number } | null {
	const pattern = new RegExp(`(?:^|\\s)(?:@|/)${escapeRegExp(appSlug)}\\b`, "i");
	const match = pattern.exec(body);
	if (!match) return null;
	return { index: match.index, length: match[0].length };
}

export function parseMentionCommand(body: string, appSlug: string): ParsedCommand | null {
	const mention = findMention(body, appSlug);
	if (!mention) return null;
	const rest = body.slice(mention.index + mention.length).trim();
	if (rest === "") {
		return { kind: "help" };
	}

	const firstWord = rest.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	switch (firstWord) {
		case "help":
			return { kind: "help" };
		case "status":
			return { kind: "status" };
		case "cancel":
		case "stop":
			return { kind: "cancel" };
		case "review": {
			const focus = rest.slice(firstWord.length).trim();
			return { kind: "review", focus: focus || null };
		}
		case "release":
			return parseReleaseCommand(rest.slice(firstWord.length).trim());
		case "fix":
		case "implement":
		case "code": {
			const instructions = rest.slice(firstWord.length).trim();
			if (!instructions) {
				return {
					kind: "invalid",
					message: "Tell me what to change after `@pig fix`, for example `@pig fix the failing tests`.",
				};
			}
			return { kind: "work", instructions };
		}
		default:
			return { kind: "work", instructions: rest };
	}
}

export function parseReleaseCommand(rest: string): ParsedCommand {
	const tokens = rest.split(/\s+/).filter((token) => token.length > 0);
	let bump: ReleaseBump = "auto";
	let version: string | null = null;
	let draft: boolean | null = null;
	let prerelease: boolean | null = null;
	let sawTarget = false;

	for (const token of tokens) {
		if (token === "--draft") {
			draft = true;
			continue;
		}
		if (token === "--prerelease") {
			prerelease = true;
			continue;
		}
		if (token.startsWith("--")) {
			return { kind: "invalid", message: `Unknown release flag ${token}.` };
		}
		if (sawTarget) {
			return {
				kind: "invalid",
				message: "Use one release target: auto, major, minor, patch, or an exact version.",
			};
		}
		sawTarget = true;
		const lower = token.toLowerCase();
		if (lower === "auto" || lower === "major" || lower === "minor" || lower === "patch") {
			bump = lower;
			continue;
		}
		const parsed = parseSemVer(token);
		if (parsed) {
			version = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`;
			bump = "auto";
			continue;
		}
		return {
			kind: "invalid",
			message: `Unrecognized release target \`${token}\`. Use auto, major, minor, patch, or an exact version.`,
		};
	}

	return { kind: "release", bump, version, draft, prerelease };
}
