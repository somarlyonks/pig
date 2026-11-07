export interface SemVer {
	major: number;
	minor: number;
	patch: number;
	prerelease: string | null;
}

export type BumpKind = "major" | "minor" | "patch";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

function matchSemVer(input: string): SemVer | null {
	const match = SEMVER_PATTERN.exec(input);
	if (!match?.[1] || !match[2] || !match[3]) {
		return null;
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ?? null,
	};
}

export function parseSemVer(input: string): SemVer | null {
	return matchSemVer(input.trim().replace(/^v/, ""));
}

export function formatSemVer(version: SemVer): string {
	const core = `${version.major}.${version.minor}.${version.patch}`;
	return version.prerelease ? `${core}-${version.prerelease}` : core;
}

export function parseTagVersion(tag: string, prefix: string): SemVer | null {
	if (!tag.startsWith(prefix)) {
		return null;
	}
	return matchSemVer(tag.slice(prefix.length));
}

function comparePrerelease(left: string | null, right: string | null): number {
	if (left === null && right === null) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	const leftParts = left.split(".");
	const rightParts = right.split(".");
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const a = leftParts[index];
		const b = rightParts[index];
		if (a === undefined) return -1;
		if (b === undefined) return 1;
		if (a === b) continue;
		const aNumeric = /^\d+$/.test(a);
		const bNumeric = /^\d+$/.test(b);
		if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
		if (aNumeric) return -1;
		if (bNumeric) return 1;
		return a < b ? -1 : 1;
	}
	return 0;
}

export function compareSemVer(left: SemVer, right: SemVer): number {
	for (const key of ["major", "minor", "patch"] as const) {
		if (left[key] !== right[key]) {
			return left[key] < right[key] ? -1 : 1;
		}
	}
	return comparePrerelease(left.prerelease, right.prerelease);
}

export function bumpVersion(version: SemVer, kind: BumpKind): SemVer {
	switch (kind) {
		case "major":
			return { major: version.major + 1, minor: 0, patch: 0, prerelease: null };
		case "minor":
			return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: null };
		case "patch":
			if (version.prerelease) {
				return { ...version, prerelease: null };
			}
			return { ...version, patch: version.patch + 1, prerelease: null };
	}
}

export type ChangeGroup =
	| "breaking"
	| "feature"
	| "fix"
	| "performance"
	| "documentation"
	| "maintenance"
	| "other";

const BREAKING_LABELS = new Set(["breaking", "breaking-change", "breaking change", "major", "semver:major"]);
const FEATURE_LABELS = new Set(["feature", "enhancement", "feat", "minor", "semver:minor"]);
const FIX_LABELS = new Set(["bug", "fix", "bugfix", "hotfix", "patch", "semver:patch"]);
const PERFORMANCE_LABELS = new Set(["performance", "perf"]);
const DOCUMENTATION_LABELS = new Set(["documentation", "docs"]);
const MAINTENANCE_LABELS = new Set([
	"chore",
	"refactor",
	"build",
	"ci",
	"test",
	"tests",
	"dependencies",
	"deps",
	"release",
]);
const SKIP_LABELS = new Set(["skip-changelog", "no-changelog", "release-skip"]);

function conventionalPrefix(title: string): string | null {
	const match = /^([A-Za-z]+)(?:\([^)]*\))?(!)?:/.exec(title.trim());
	return match?.[1]?.toLowerCase() ?? null;
}

export function classifyPullRequest(title: string, labels: string[]): ChangeGroup {
	const normalizedLabels = labels.map((label) => label.trim().toLowerCase());
	if (normalizedLabels.some((label) => BREAKING_LABELS.has(label))) {
		return "breaking";
	}
	if (/^[A-Za-z]+(?:\([^)]*\))?!:/.test(title.trim())) {
		return "breaking";
	}
	if (normalizedLabels.some((label) => FEATURE_LABELS.has(label))) {
		return "feature";
	}
	const prefix = conventionalPrefix(title);
	if (prefix === "feat" || prefix === "feature") return "feature";
	if (normalizedLabels.some((label) => PERFORMANCE_LABELS.has(label))) return "performance";
	if (prefix === "perf") return "performance";
	if (normalizedLabels.some((label) => FIX_LABELS.has(label))) return "fix";
	if (prefix === "fix" || prefix === "bugfix" || prefix === "hotfix") return "fix";
	if (normalizedLabels.some((label) => DOCUMENTATION_LABELS.has(label))) return "documentation";
	if (prefix === "docs" || prefix === "doc") return "documentation";
	if (normalizedLabels.some((label) => MAINTENANCE_LABELS.has(label))) return "maintenance";
	if (prefix === "chore" || prefix === "refactor" || prefix === "build" || prefix === "ci" || prefix === "test" || prefix === "tests") {
		return "maintenance";
	}
	return "other";
}

export interface ReleasePullRequest {
	number: number;
	title: string;
	author: string | null;
	labels: string[];
}

export function isSkippedReleasePullRequest(pull: ReleasePullRequest): boolean {
	const labels = pull.labels.map((label) => label.toLowerCase());
	if (labels.some((label) => SKIP_LABELS.has(label))) {
		return true;
	}
	return /^chore\(release\)/i.test(pull.title.trim());
}

export function inferBump(pulls: ReleasePullRequest[]): BumpKind {
	const groups = pulls
		.filter((pull) => !isSkippedReleasePullRequest(pull))
		.map((pull) => classifyPullRequest(pull.title, pull.labels));
	if (groups.includes("breaking")) return "major";
	if (groups.includes("feature")) return "minor";
	return "patch";
}

const GROUP_TITLES: Record<ChangeGroup, string> = {
	breaking: "Breaking Changes",
	feature: "Features",
	fix: "Fixes",
	performance: "Performance",
	documentation: "Documentation",
	maintenance: "Maintenance",
	other: "Other Changes",
};

const GROUP_ORDER: ChangeGroup[] = [
	"breaking",
	"feature",
	"fix",
	"performance",
	"documentation",
	"maintenance",
	"other",
];

function formatPullRequestLine(pull: ReleasePullRequest): string {
	const title = pull.title.replace(/\s+/g, " ").trim().slice(0, 200) || `#${pull.number}`;
	const author = pull.author ? ` — @${pull.author}` : "";
	return `- ${title} (#${pull.number})${author}`;
}

export interface ReleaseNotesInput {
	repository: string;
	tag: string;
	previousTag: string | null;
	pulls: ReleasePullRequest[];
}

export function buildReleaseNotes(input: ReleaseNotesInput): string {
	const included = input.pulls
		.filter((pull) => !isSkippedReleasePullRequest(pull))
		.slice(0, 200);
	const grouped = new Map<ChangeGroup, ReleasePullRequest[]>();
	for (const pull of included) {
		const group = classifyPullRequest(pull.title, pull.labels);
		const bucket = grouped.get(group) ?? [];
		bucket.push(pull);
		grouped.set(group, bucket);
	}

	const sections = GROUP_ORDER.flatMap((group) => {
		const pulls = grouped.get(group);
		if (!pulls || pulls.length === 0) return [];
		return [`### ${GROUP_TITLES[group]}`, "", ...pulls.map(formatPullRequestLine), ""];
	});

	if (sections.length === 0) {
		sections.push("No merged pull requests were found for this release.", "");
	}

	if (input.previousTag) {
		sections.push(
			`**Full Changelog**: https://github.com/${input.repository}/compare/${encodeURIComponent(input.previousTag)}...${encodeURIComponent(input.tag)}`,
			"",
		);
	}

	return sections.join("\n").trimEnd() + "\n";
}
