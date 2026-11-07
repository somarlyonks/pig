import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewSide } from "../diff.ts";

export interface WorkResult {
	title: string | null;
	body: string | null;
	commitMessage: string | null;
	summary: string | null;
}

export type ReviewSeverity = "blocker" | "issue" | "nit";
export type ReviewVerdict = "approve" | "comment" | "request_changes";

export interface ReviewFinding {
	path: string;
	line: number;
	side: ReviewSide;
	severity: ReviewSeverity;
	body: string;
}

export interface ReviewResult {
	summary: string;
	verdict: ReviewVerdict;
	findings: ReviewFinding[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readText(path: string, maxBytes = 128 * 1024): string | null {
	try {
		const text = readFileSync(path, "utf8");
		return Buffer.byteLength(text, "utf8") > maxBytes ? text.slice(0, maxBytes) : text;
	} catch {
		return null;
	}
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
	let candidate = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(candidate);
	if (fenced?.[1]) {
		candidate = fenced[1].trim();
	}
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) {
		return null;
	}
	try {
		return asRecord(JSON.parse(candidate.slice(start, end + 1)));
	} catch {
		return null;
	}
}

function readArtifact(repoDir: string, relativePath: string): Record<string, unknown> | null {
	const text = readText(join(repoDir, relativePath));
	return text === null ? null : extractJsonObject(text);
}

function optionalString(record: Record<string, unknown>, key: string, maxLength: number): string | null {
	const value = record[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed.slice(0, maxLength);
}

export function parseWorkRecord(record: Record<string, unknown> | null): WorkResult | null {
	if (!record) return null;
	const result: WorkResult = {
		title: optionalString(record, "title", 200),
		body: optionalString(record, "body", 40_000),
		commitMessage: optionalString(record, "commit_message", 200),
		summary: optionalString(record, "summary", 4000),
	};
	if (!result.title && !result.body && !result.commitMessage && !result.summary) {
		return null;
	}
	return result;
}

export function parseWorkResult(repoDir: string): WorkResult | null {
	return parseWorkRecord(readArtifact(repoDir, ".pig/result.json"));
}

function isReviewSide(value: unknown): value is ReviewSide {
	return value === "LEFT" || value === "RIGHT";
}

function isSeverity(value: unknown): value is ReviewSeverity {
	return value === "blocker" || value === "issue" || value === "nit";
}

function isVerdict(value: unknown): value is ReviewVerdict {
	return value === "approve" || value === "comment" || value === "request_changes";
}

export function parseReviewRecord(record: Record<string, unknown> | null): ReviewResult | null {
	if (!record) return null;

	const summary = optionalString(record, "summary", 10_000) ?? "";
	const verdict = isVerdict(record.verdict) ? record.verdict : "comment";
	const findings: ReviewFinding[] = [];

	if (Array.isArray(record.findings)) {
		for (const raw of record.findings.slice(0, 80)) {
			const finding = asRecord(raw);
			if (!finding) continue;
			if (typeof finding.path !== "string" || !finding.path.trim()) continue;
			if (!Number.isInteger(finding.line) || (finding.line as number) <= 0) continue;
			const body = optionalString(finding, "body", 5000);
			if (!body) continue;
			findings.push({
				path: finding.path.trim(),
				line: finding.line as number,
				side: isReviewSide(finding.side) ? finding.side : "RIGHT",
				severity: isSeverity(finding.severity) ? finding.severity : "issue",
				body,
			});
		}
	}

	if (!summary && findings.length === 0) {
		return null;
	}
	return { summary, verdict, findings };
}

export function parseReviewResult(repoDir: string): ReviewResult | null {
	return parseReviewRecord(readArtifact(repoDir, ".pig/review.json"));
}
