import { parse as parseYaml } from "yaml";

export type RequestChangesPolicy = "blocker" | "any" | "never";

export interface RepoConfig {
	version: 1;
	agent: {
		model: string | null;
		thinking: string | null;
		timeoutMinutes: number;
	};
	review: {
		auto: boolean;
		skipDrafts: boolean;
		requestChangesOn: RequestChangesPolicy;
		allowApprove: boolean;
		maxFindings: number;
	};
	work: {
		branchPrefix: string;
		allowWorkflowChanges: boolean;
	};
	release: {
		tagPrefix: string;
		draft: boolean;
	};
	permissions: {
		allow: string[];
	};
}

export interface RepoConfigResult {
	config: RepoConfig;
	warnings: string[];
}

export function defaultRepoConfig(defaultTimeoutMinutes = 30): RepoConfig {
	return {
		version: 1,
		agent: {
			model: null,
			thinking: null,
			timeoutMinutes: defaultTimeoutMinutes,
		},
		review: {
			auto: true,
			skipDrafts: true,
			requestChangesOn: "blocker",
			allowApprove: false,
			maxFindings: 30,
		},
		work: {
			branchPrefix: "pig/",
			allowWorkflowChanges: false,
		},
		release: {
			tagPrefix: "v",
			draft: false,
		},
		permissions: {
			allow: [],
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readString(
	section: Record<string, unknown>,
	key: string,
	warnings: string[],
	prefix: string,
): string | null | undefined {
	const value = section[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		warnings.push(`${prefix}.${key} must be a string`);
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function readBoolean(
	section: Record<string, unknown>,
	key: string,
	warnings: string[],
	prefix: string,
): boolean | undefined {
	const value = section[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		warnings.push(`${prefix}.${key} must be true or false`);
		return undefined;
	}
	return value;
}

function readInteger(
	section: Record<string, unknown>,
	key: string,
	warnings: string[],
	prefix: string,
	min: number,
	max: number,
): number | undefined {
	const value = section[key];
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		warnings.push(`${prefix}.${key} must be an integer between ${min} and ${max}`);
		return undefined;
	}
	return value as number;
}

function isValidBranchPrefix(prefix: string): boolean {
	if (prefix.length > 40 || !prefix.endsWith("/") || prefix.startsWith("/") || prefix.includes("..")) {
		return false;
	}
	if (prefix.includes("@{") || prefix.includes("//") || prefix.includes(" ")) {
		return false;
	}
	return /^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(prefix);
}

export function parseRepoConfig(text: string, defaults: RepoConfig): RepoConfigResult {
	const warnings: string[] = [];
	if (text.trim() === "") {
		return { config: defaults, warnings };
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (error) {
		return {
			config: defaults,
			warnings: [`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	const root = asRecord(parsed);
	if (!root) {
		return { config: defaults, warnings: ["Configuration must be a YAML mapping"] };
	}

	const config: RepoConfig = {
		version: 1,
		agent: { ...defaults.agent },
		review: { ...defaults.review },
		work: { ...defaults.work },
		release: { ...defaults.release },
		permissions: { allow: [...defaults.permissions.allow] },
	};

	const version = root.version;
	if (version !== undefined && version !== 1) {
		warnings.push("version must be 1");
	}

	const agent = asRecord(root.agent);
	if (agent) {
		const model = readString(agent, "model", warnings, "agent");
		if (model !== undefined) config.agent.model = model;
		const thinking = readString(agent, "thinking", warnings, "agent");
		if (thinking !== undefined) config.agent.thinking = thinking;
		const timeout = readInteger(agent, "timeout_minutes", warnings, "agent", 1, 1440);
		if (timeout !== undefined) config.agent.timeoutMinutes = timeout;
	}

	const review = asRecord(root.review);
	if (review) {
		const auto = readBoolean(review, "auto", warnings, "review");
		if (auto !== undefined) config.review.auto = auto;
		const skipDrafts = readBoolean(review, "skip_drafts", warnings, "review");
		if (skipDrafts !== undefined) config.review.skipDrafts = skipDrafts;
		const requestChangesOn = readString(review, "request_changes_on", warnings, "review");
		if (requestChangesOn !== undefined) {
			if (
				requestChangesOn === "blocker" ||
				requestChangesOn === "any" ||
				requestChangesOn === "never"
			) {
				config.review.requestChangesOn = requestChangesOn;
			} else {
				warnings.push("review.request_changes_on must be blocker, any, or never");
			}
		}
		const allowApprove = readBoolean(review, "allow_approve", warnings, "review");
		if (allowApprove !== undefined) config.review.allowApprove = allowApprove;
		const maxFindings = readInteger(review, "max_findings", warnings, "review", 1, 50);
		if (maxFindings !== undefined) config.review.maxFindings = maxFindings;
	}

	const work = asRecord(root.work);
	if (work) {
		const branchPrefix = readString(work, "branch_prefix", warnings, "work");
		if (branchPrefix !== undefined) {
			if (branchPrefix && isValidBranchPrefix(branchPrefix)) {
				config.work.branchPrefix = branchPrefix;
			} else {
				warnings.push(
					"work.branch_prefix must be a safe branch prefix ending in / (letters, digits, . _ - /)",
				);
			}
		}
		const allowWorkflowChanges = readBoolean(work, "allow_workflow_changes", warnings, "work");
		if (allowWorkflowChanges !== undefined) config.work.allowWorkflowChanges = allowWorkflowChanges;
	}

	const release = asRecord(root.release);
	if (release) {
		const tagPrefix = readString(release, "tag_prefix", warnings, "release");
		if (tagPrefix !== undefined) {
			if (tagPrefix === null || /^[A-Za-z0-9._-]{0,20}$/.test(tagPrefix)) {
				config.release.tagPrefix = tagPrefix ?? "";
			} else {
				warnings.push("release.tag_prefix must use letters, digits, dots, underscores, or dashes");
			}
		}
		const draft = readBoolean(release, "draft", warnings, "release");
		if (draft !== undefined) config.release.draft = draft;
	}

	const permissions = asRecord(root.permissions);
	if (permissions) {
		const allow = permissions.allow;
		if (allow !== undefined) {
			if (!Array.isArray(allow) || allow.some((entry) => typeof entry !== "string")) {
				warnings.push("permissions.allow must be a list of GitHub usernames");
			} else {
				const names = allow
					.map((entry) => (entry as string).trim())
					.filter((entry) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(entry))
					.map((entry) => entry.toLowerCase());
				if (names.length !== allow.length) {
					warnings.push("permissions.allow contains invalid GitHub usernames");
				}
				config.permissions.allow = [...new Set(names)];
			}
		}
	}

	return { config, warnings };
}
