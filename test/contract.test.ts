import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	extractJsonObject,
	parseReviewContent,
	parseReviewRecord,
	parseWorkContent,
} from "../src/agent/contract.ts";

function temporaryRepo(): string {
	return mkdtempSync(join(tmpdir(), "pig-contract-"));
}

function writeArtifact(repo: string, name: string, content: string): void {
	mkdirSync(join(repo, ".pig"), { recursive: true });
	writeFileSync(join(repo, ".pig", name), content, "utf8");
}

test("reads a valid work result", () => {
	const repo = temporaryRepo();
	try {
		writeArtifact(
			repo,
			"result.json",
			JSON.stringify({
				title: "Add tests",
				body: "## Changes\n\nAdds tests.",
				commit_message: "test: add parser coverage",
				summary: "Added parser tests.",
			}),
		);
		const result = parseWorkContent(readFileSync(join(repo, ".pig", "result.json"), "utf8"));
		assert.equal(result?.title, "Add tests");
		assert.equal(result?.body, "## Changes\n\nAdds tests.");
		assert.equal(result?.commitMessage, "test: add parser coverage");
		assert.equal(result?.summary, "Added parser tests.");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("accepts fenced JSON in the final message", () => {
	const record = extractJsonObject('Done.\n```json\n{"title":"x","summary":"y"}\n```');
	assert.equal(record?.title, "x");
	assert.equal(extractJsonObject("no json here"), null);
});

test("normalizes review findings and rejects invalid values", () => {
	const result = parseReviewRecord({
		summary: "Looks mostly good.",
		verdict: "request_changes",
		findings: [
			{ path: "src/a.ts", line: 4, side: "RIGHT", severity: "blocker", body: "Crash." },
			{ path: "src/a.ts", line: 0, severity: "nit", body: "Bad line." },
			{ path: "src/a.ts", line: 2, side: "UP", severity: "minor", body: "Odd side." },
			{ path: "src/a.ts", line: 3, body: "   " },
			{ path: "src/b.ts", line: 1, side: "LEFT", severity: "nit", body: "Nit." },
		],
	});
	assert.equal(result?.verdict, "request_changes");
	assert.equal(result?.findings.length, 3);
	assert.deepEqual(result?.findings[0], {
		path: "src/a.ts",
		line: 4,
		side: "RIGHT",
		severity: "blocker",
		body: "Crash.",
	});
	assert.equal(result?.findings[1]?.side, "RIGHT");
	assert.equal(result?.findings[1]?.severity, "issue");
	assert.equal(result?.findings[2]?.side, "LEFT");
});

test("returns null for an empty or missing review artifact", () => {
	const repo = temporaryRepo();
	try {
		writeArtifact(repo, "review.json", "{}");
		assert.equal(parseReviewContent(readFileSync(join(repo, ".pig", "review.json"), "utf8")), null);
		writeArtifact(
			repo,
			"review.json",
			JSON.stringify({ summary: "Clean.", verdict: "approve", findings: [] }),
		);
		const result = parseReviewContent(readFileSync(join(repo, ".pig", "review.json"), "utf8"));
		assert.equal(result?.summary, "Clean.");
		assert.equal(result?.verdict, "approve");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
