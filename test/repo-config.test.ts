import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRepoConfig, parseRepoConfig } from "../src/repo-config.ts";

test("returns defaults for an empty config", () => {
	const defaults = defaultRepoConfig(20);
	const result = parseRepoConfig("", defaults);
	assert.deepEqual(result.warnings, []);
	assert.equal(result.config.review.auto, true);
	assert.equal(result.config.agent.timeoutMinutes, 20);
	assert.equal(result.config.release.tagPrefix, "v");
	assert.deepEqual(result.config.permissions.allow, []);
});

test("applies nested overrides and normalizes permissions", () => {
	const defaults = defaultRepoConfig();
	const result = parseRepoConfig(
		`version: 1
agent:
  model: sonnet:high
  thinking: high
  timeout_minutes: 45
review:
  auto: false
  skip_drafts: false
  request_changes_on: any
  allow_approve: true
  max_findings: 12
work:
  branch_prefix: bot/
  allow_workflow_changes: true
release:
  tag_prefix: ""
  draft: true
permissions:
  allow: [Alice, alice, Bad_User]
`,
		defaults,
	);
	assert.equal(result.config.agent.model, "sonnet:high");
	assert.equal(result.config.agent.thinking, "high");
	assert.equal(result.config.agent.timeoutMinutes, 45);
	assert.equal(result.config.review.auto, false);
	assert.equal(result.config.review.skipDrafts, false);
	assert.equal(result.config.review.requestChangesOn, "any");
	assert.equal(result.config.review.allowApprove, true);
	assert.equal(result.config.review.maxFindings, 12);
	assert.equal(result.config.work.branchPrefix, "bot/");
	assert.equal(result.config.work.allowWorkflowChanges, true);
	assert.equal(result.config.release.tagPrefix, "");
	assert.equal(result.config.release.draft, true);
	assert.deepEqual(result.config.permissions.allow, ["alice"]);
	assert.equal(result.warnings.length, 1);
});

test("reports invalid values and keeps defaults", () => {
	const defaults = defaultRepoConfig();
	const result = parseRepoConfig(
		`review:
  request_changes_on: sometimes
  max_findings: 0
work:
  branch_prefix: ../escape/
release:
  tag_prefix: bad/prefix
permissions:
  allow: "alice"
`,
		defaults,
	);
	assert.equal(result.config.review.requestChangesOn, "blocker");
	assert.equal(result.config.review.maxFindings, 30);
	assert.equal(result.config.work.branchPrefix, "pig/");
	assert.equal(result.config.release.tagPrefix, "v");
	assert.deepEqual(result.config.permissions.allow, []);
	assert.equal(result.warnings.length, 5);
});

test("falls back on malformed YAML", () => {
	const defaults = defaultRepoConfig();
	const result = parseRepoConfig("review: [unclosed", defaults);
	assert.deepEqual(result.config, defaults);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0] ?? "", /Invalid YAML/);
});
