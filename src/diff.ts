export interface DiffFile {
	path: string;
	leftLines: Set<number>;
	rightLines: Set<number>;
}

export interface DiffIndex {
	files: Map<string, DiffFile>;
	additions: number;
	deletions: number;
	truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquoteGitPath(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) {
		return trimmed;
	}
	const inner = trimmed.slice(1, -1);
	return inner.replace(/\\(["\\])/g, "$1").replace(/\\([0-7]{3})/g, (_, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
}

function stripPrefix(value: string): string {
	const path = unquoteGitPath(value);
	if (path.startsWith("a/") || path.startsWith("b/")) {
		return path.slice(2);
	}
	return path;
}

function pathFromHeader(line: string, prefix: "--- " | "+++ "): string | null {
	if (!line.startsWith(prefix)) {
		return null;
	}
	const raw = line.slice(prefix.length);
	if (raw === "/dev/null") {
		return null;
	}
	return stripPrefix(raw);
}

export function parseDiff(diff: string, truncated = false): DiffIndex {
	const files = new Map<string, DiffFile>();
	let current: DiffFile | null = null;
	let pendingOldPath: string | null = null;
	let fallbackPath: string | null = null;

	let inHunk = false;
	let leftRemaining = 0;
	let rightRemaining = 0;
	let leftLine = 0;
	let rightLine = 0;

	let additions = 0;
	let deletions = 0;

	const ensureFile = (path: string): DiffFile => {
		let file = files.get(path);
		if (!file) {
			file = { path, leftLines: new Set(), rightLines: new Set() };
			files.set(path, file);
		}
		return file;
	};

	const finishCurrent = () => {
		if (!current) {
			return;
		}
		if (current.path !== fallbackPath) {
			const existing = files.get(fallbackPath ?? "");
			if (existing && existing !== current) {
				for (const line of existing.leftLines) current.leftLines.add(line);
				for (const line of existing.rightLines) current.rightLines.add(line);
			}
		}
		current = null;
		inHunk = false;
		fallbackPath = null;
		pendingOldPath = null;
	};

	for (const rawLine of diff.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

		if (line.startsWith("diff --git ")) {
			finishCurrent();
			const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
			if (match?.[1] && match[1] === match[2]) {
				fallbackPath = unquoteGitPath(match[1]);
			} else if (match?.[2]) {
				fallbackPath = unquoteGitPath(match[2]);
			} else {
				fallbackPath = null;
			}
			continue;
		}

		if (line.startsWith("--- ")) {
			const path = pathFromHeader(line, "--- ");
			pendingOldPath = path;
			if (!line.includes("/dev/null")) {
				inHunk = false;
			}
			continue;
		}

		if (line.startsWith("+++ ")) {
			const newPath = pathFromHeader(line, "+++ ");
			const resolved = newPath ?? pendingOldPath ?? fallbackPath;
			if (resolved) {
				current = ensureFile(resolved);
				if (fallbackPath && fallbackPath !== resolved) {
					files.delete(fallbackPath);
					current.path = resolved;
				}
			}
			pendingOldPath = null;
			inHunk = false;
			continue;
		}

		const hunk = HUNK_HEADER.exec(line);
		if (hunk) {
			const oldStart = Number(hunk[1] ?? 0);
			const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
			const newStart = Number(hunk[3] ?? 0);
			const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
			leftLine = oldStart;
			rightLine = newStart;
			leftRemaining = oldCount;
			rightRemaining = newCount;
			inHunk = leftRemaining > 0 || rightRemaining > 0;
			if (!current && fallbackPath) {
				current = ensureFile(fallbackPath);
			}
			continue;
		}

		if (!inHunk || !current) {
			if (line.startsWith("\\ No newline")) {
				continue;
			}
			continue;
		}

		if (line.startsWith("+")) {
			if (rightLine > 0) current.rightLines.add(rightLine);
			rightLine += 1;
			rightRemaining -= 1;
			additions += 1;
		} else if (line.startsWith("-")) {
			if (leftLine > 0) current.leftLines.add(leftLine);
			leftLine += 1;
			leftRemaining -= 1;
			deletions += 1;
		} else if (line.startsWith(" ") || line === "") {
			if (leftLine > 0) current.leftLines.add(leftLine);
			if (rightLine > 0) current.rightLines.add(rightLine);
			leftLine += 1;
			rightLine += 1;
			leftRemaining -= 1;
			rightRemaining -= 1;
		} else if (line.startsWith("\\ No newline")) {
			// Marker only, no line accounting.
		} else {
			inHunk = false;
		}

		if (leftRemaining <= 0 && rightRemaining <= 0) {
			inHunk = false;
			leftRemaining = 0;
			rightRemaining = 0;
		}
	}

	finishCurrent();
	return { files, additions, deletions, truncated };
}

export type ReviewSide = "LEFT" | "RIGHT";

export function isValidReviewLocation(
	index: DiffIndex,
	path: string,
	line: number,
	side: ReviewSide,
): boolean {
	if (!Number.isInteger(line) || line <= 0) {
		return false;
	}
	const file = index.files.get(path);
	if (!file) {
		return false;
	}
	return side === "LEFT" ? file.leftLines.has(line) : file.rightLines.has(line);
}

export function isSafeRepositoryPath(path: string): boolean {
	if (!path || path.startsWith("/") || path.includes("\0") || path.includes("\\")) {
		return false;
	}
	return !path.split("/").some((segment) => segment === ".." || segment === "" || segment === ".");
}

export function truncateDiff(
	diff: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	if (Buffer.byteLength(diff, "utf8") <= maxBytes) {
		return { text: diff, truncated: false };
	}
	const buffer = Buffer.from(diff, "utf8");
	const cut = buffer.subarray(0, maxBytes);
	const lastNewline = cut.lastIndexOf(0x0a);
	const text = (lastNewline > 0 ? cut.subarray(0, lastNewline) : cut).toString("utf8");
	return { text, truncated: true };
}

export function summarizeDiff(index: DiffIndex): string {
	const files = index.files.size;
	const suffix = index.truncated ? " (diff truncated in prompt)" : "";
	return `${files} file${files === 1 ? "" : "s"}, +${index.additions}/-${index.deletions}${suffix}`;
}
