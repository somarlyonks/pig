import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildReleaseNotes,
	bumpVersion,
	classifyPullRequest,
	compareSemVer,
	formatSemVer,
	inferBump,
	isSkippedReleasePullRequest,
	parseSemVer,
	parseTagVersion,
} from "../src/semver.ts";

test("parses and formats semantic versions", () => {
	assert.deepEqual(parseSemVer("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: null });
	assert.deepEqual(parseSemVer("v2.0.0-rc.1"), {
		major: 2,
		minor: 0,
		patch: 0,
		prerelease: "rc.1",
	});
	assert.equal(parseSemVer("1.2"), null);
	assert.equal(parseSemVer("01.2.3"), null);
	assert.equal(formatSemVer({ major: 1, minor: 2, patch: 3, prerelease: "beta.2" }), "1.2.3-beta.2");
	assert.deepEqual(parseTagVersion("release-1.2.3", "release-"), {
		major: 1,
		minor: 2,
		patch: 3,
		prerelease: null,
	});
	assert.equal(parseTagVersion("v1.2.3", "release-"), null);
	assert.equal(parseTagVersion("v1.2.3", ""), null);
	assert.deepEqual(parseTagVersion("1.2.3", ""), parseSemVer("1.2.3"));
});

test("orders versions including prereleases", () => {
	const stable = parseSemVer("1.0.0")!;
	const rc = parseSemVer("1.0.0-rc.2")!;
	const beta = parseSemVer("1.0.1-beta.1")!;
	assert.equal(compareSemVer(stable, rc), 1);
	assert.equal(compareSemVer(rc, stable), -1);
	assert.equal(compareSemVer(beta, stable), 1);
	assert.equal(compareSemVer(parseSemVer("1.0.0-rc.1")!, rc), -1);
	assert.equal(compareSemVer(parseSemVer("1.0.0-rc.10")!, parseSemVer("1.0.0-rc.2")!), 1);
});

test("bumps versions, including promotion from a prerelease", () => {
	const base = parseSemVer("1.2.3")!;
	assert.equal(formatSemVer(bumpVersion(base, "major")), "2.0.0");
	assert.equal(formatSemVer(bumpVersion(base, "minor")), "1.3.0");
	assert.equal(formatSemVer(bumpVersion(base, "patch")), "1.2.4");
	assert.equal(
		formatSemVer(bumpVersion(parseSemVer("2.0.0-rc.1")!, "patch")),
		"2.0.0",
	);
});

test("classifies pull requests from titles and labels", () => {
	assert.equal(classifyPullRequest("feat!: drop legacy API", []), "breaking");
	assert.equal(classifyPullRequest("fix: handle empty input", []), "fix");
	assert.equal(classifyPullRequest("docs: clarify setup", []), "documentation");
	assert.equal(classifyPullRequest("perf: cache lookups", []), "performance");
	assert.equal(classifyPullRequest("chore: bump deps", []), "maintenance");
	assert.equal(classifyPullRequest("Update the parser", ["enhancement"]), "feature");
	assert.equal(classifyPullRequest("Update the parser", ["breaking change"]), "breaking");
	assert.equal(classifyPullRequest("Update the parser", []), "other");
	assert.equal(inferBump([{ number: 1, title: "fix: x", author: null, labels: [] }]), "patch");
	assert.equal(inferBump([{ number: 1, title: "feat: x", author: null, labels: [] }]), "minor");
	assert.equal(
		inferBump([
			{ number: 1, title: "feat: x", author: null, labels: [] },
			{ number: 2, title: "breaking: y", author: null, labels: ["breaking"] },
		]),
		"major",
	);
});

test("builds grouped release notes and skips internal pull requests", () => {
	const notes = buildReleaseNotes({
		repository: "acme/app",
		tag: "v1.3.0",
		previousTag: "v1.2.0",
		pulls: [
			{ number: 10, title: "feat(api): add batch endpoint", author: "alice", labels: [] },
			{ number: 11, title: "fix: avoid duplicate writes", author: "bob", labels: [] },
			{ number: 12, title: "chore: bump dev dependency", author: "carol", labels: [] },
			{ number: 13, title: "internal cleanup", author: "dave", labels: ["skip-changelog"] },
			{ number: 14, title: "docs: update quickstart", author: "erin", labels: [] },
		],
	});

	assert.match(notes, /### Features\n\n- feat\(api\): add batch endpoint \(#10\) — @alice/);
	assert.match(notes, /### Fixes/);
	assert.match(notes, /### Maintenance/);
	assert.doesNotMatch(notes, /internal cleanup/);
	assert.match(notes, /https:\/\/github.com\/acme\/app\/compare\/v1.2.0...v1.3.0/);
	assert.equal(isSkippedReleasePullRequest({ number: 1, title: "x", author: null, labels: ["no-changelog"] }), true);
});
