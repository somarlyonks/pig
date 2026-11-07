import { test } from "node:test";
import assert from "node:assert/strict";
import { findMention, parseMentionCommand } from "../src/webhooks/commands.ts";

test("finds an app mention at the start or after whitespace", () => {
	assert.deepEqual(findMention("@pig review", "pig"), { index: 0, length: 4 });
	assert.deepEqual(findMention("please @pig review this", "pig"), { index: 6, length: 5 });
	assert.deepEqual(findMention("/pig review", "pig"), { index: 0, length: 4 });
	assert.equal(findMention("mail me at a@pig.dev", "pig"), null);
	assert.equal(findMention("@piggy review", "pig"), null);
	assert.deepEqual(findMention("@PIG review", "pig"), { index: 0, length: 4 });
});

test("parses help, status, and cancel commands", () => {
	assert.deepEqual(parseMentionCommand("@pig", "pig"), { kind: "help" });
	assert.deepEqual(parseMentionCommand("@pig help", "pig"), { kind: "help" });
	assert.deepEqual(parseMentionCommand("@pig status", "pig"), { kind: "status" });
	assert.deepEqual(parseMentionCommand("@pig cancel", "pig"), { kind: "cancel" });
	assert.deepEqual(parseMentionCommand("@pig stop", "pig"), { kind: "cancel" });
});

test("parses review focus and plain work requests", () => {
	assert.deepEqual(parseMentionCommand("@pig review", "pig"), {
		kind: "review",
		focus: null,
	});
	assert.deepEqual(parseMentionCommand("@pig review security and migrations", "pig"), {
		kind: "review",
		focus: "security and migrations",
	});
	assert.deepEqual(parseMentionCommand("@pig fix the failing tests", "pig"), {
		kind: "work",
		instructions: "the failing tests",
	});
	assert.deepEqual(parseMentionCommand("@pig add unit tests for the parser", "pig"), {
		kind: "work",
		instructions: "add unit tests for the parser",
	});
	assert.deepEqual(parseMentionCommand("@pig implement retries", "pig"), {
		kind: "work",
		instructions: "retries",
	});
});

test("parses release targets and flags", () => {
	assert.deepEqual(parseMentionCommand("@pig release", "pig"), {
		kind: "release",
		bump: "auto",
		version: null,
		draft: null,
		prerelease: null,
	});
	assert.deepEqual(parseMentionCommand("@pig release minor", "pig"), {
		kind: "release",
		bump: "minor",
		version: null,
		draft: null,
		prerelease: null,
	});
	assert.deepEqual(parseMentionCommand("@pig release v1.4.0 --draft", "pig"), {
		kind: "release",
		bump: "auto",
		version: "1.4.0",
		draft: true,
		prerelease: null,
	});
	assert.deepEqual(parseMentionCommand("@pig release 2.0.0-rc.1 --prerelease", "pig"), {
		kind: "release",
		bump: "auto",
		version: "2.0.0-rc.1",
		draft: null,
		prerelease: true,
	});
	assert.equal(parseMentionCommand("@pig release banana", "pig")?.kind, "invalid");
	assert.equal(parseMentionCommand("@pig release major minor", "pig")?.kind, "invalid");
	assert.equal(parseMentionCommand("@pig release --force", "pig")?.kind, "invalid");
});

test("returns null when the app is not mentioned", () => {
	assert.equal(parseMentionCommand("looks good to me", "pig"), null);
});
