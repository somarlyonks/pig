import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isSafeRepositoryPath,
	isValidReviewLocation,
	parseDiff,
	truncateDiff,
} from "../src/diff.ts";

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 line1
-old line2
+new line2
+extra line3
 line4
@@ -10,2 +11,2 @@
 ctx10
-old11
+new11
diff --git a/deleted.txt b/deleted.txt
deleted file mode 100644
--- a/deleted.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;

test("parses changed files and valid line numbers", () => {
	const index = parseDiff(SAMPLE_DIFF);
	assert.equal(index.files.size, 3);
	assert.equal(index.additions, 5);
	assert.equal(index.deletions, 4);

	assert.equal(isValidReviewLocation(index, "src/a.ts", 1, "RIGHT"), true);
	assert.equal(isValidReviewLocation(index, "src/a.ts", 3, "RIGHT"), true);
	assert.equal(isValidReviewLocation(index, "src/a.ts", 4, "RIGHT"), true);
	assert.equal(isValidReviewLocation(index, "src/a.ts", 2, "LEFT"), true);
	assert.equal(isValidReviewLocation(index, "src/a.ts", 4, "LEFT"), false);
	assert.equal(isValidReviewLocation(index, "src/a.ts", 11, "LEFT"), true);
	assert.equal(isValidReviewLocation(index, "src/a.ts", 11, "RIGHT"), true);
	assert.equal(isValidReviewLocation(index, "src/a.ts", 13, "RIGHT"), false);

	assert.equal(isValidReviewLocation(index, "deleted.txt", 2, "LEFT"), true);
	assert.equal(isValidReviewLocation(index, "deleted.txt", 2, "RIGHT"), false);
	assert.equal(isValidReviewLocation(index, "new.txt", 2, "RIGHT"), true);
	assert.equal(isValidReviewLocation(index, "new.txt", 3, "RIGHT"), false);
	assert.equal(isValidReviewLocation(index, "missing.ts", 1, "RIGHT"), false);
});

test("supports single-line hunk headers", () => {
	const index = parseDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`);
	assert.equal(isValidReviewLocation(index, "a.txt", 1, "RIGHT"), true);
	assert.equal(isValidReviewLocation(index, "a.txt", 1, "LEFT"), true);
});

test("rejects unsafe repository paths", () => {
	assert.equal(isSafeRepositoryPath("src/a.ts"), true);
	assert.equal(isSafeRepositoryPath("a/b/../c"), false);
	assert.equal(isSafeRepositoryPath("/etc/passwd"), false);
	assert.equal(isSafeRepositoryPath("a//b"), false);
	assert.equal(isSafeRepositoryPath("a/./b"), false);
	assert.equal(isSafeRepositoryPath("a\\b"), false);
	assert.equal(isSafeRepositoryPath(""), false);
});

test("truncates a diff at a line boundary", () => {
	const diff = "line-one\nline-two\nline-three\n";
	const result = truncateDiff(diff, 15);
	assert.equal(result.truncated, true);
	assert.equal(result.text, "line-one");
	const unchanged = truncateDiff("short\n", 100);
	assert.equal(unchanged.truncated, false);
	assert.equal(unchanged.text, "short\n");
});
