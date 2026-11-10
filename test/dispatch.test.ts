import { test } from "node:test";
import assert from "node:assert/strict";
import { PIG_CAPABILITIES } from "../src/dispatch/capabilities.ts";
import { parseDispatchEnvelope } from "../src/dispatch/input.ts";
import {
	dispatchIdempotencyKey,
	dispatchRepository,
	isValidDispatchKey,
	planDispatch,
	type DispatchPlanInput,
} from "../src/dispatch/plan.ts";

function input(overrides: Partial<DispatchPlanInput> = {}): DispatchPlanInput {
	return {
		capability: "pig.work",
		params: { repo: "acme/app", instructions: "Add a test" },
		dispatchKey: "console-1",
		actor: "alice",
		receivedAt: 1_000,
		notAfter: null,
		...overrides,
	};
}

function admitted(plan: ReturnType<typeof planDispatch>) {
	assert.equal(plan.kind, "admit");
	if (plan.kind !== "admit") throw new Error("expected an admission");
	return plan.admission;
}

test("describes capabilities with unique names", () => {
	const names = PIG_CAPABILITIES.map((capability) => capability.name);
	assert.equal(new Set(names).size, names.length);
	for (const capability of PIG_CAPABILITIES) {
		assert.ok(capability.parameters.some((parameter) => parameter.name === "repo"));
	}
	assert.equal(
		PIG_CAPABILITIES.find((capability) => capability.name === "pig.release")?.dangerous,
		true,
	);
});

test("validates dispatch keys", () => {
	assert.equal(isValidDispatchKey("console:1"), true);
	assert.equal(isValidDispatchKey("a".repeat(200)), true);
	assert.equal(isValidDispatchKey(""), false);
	assert.equal(isValidDispatchKey("a".repeat(201)), false);
	assert.equal(isValidDispatchKey("-leading-dash"), false);
	assert.equal(isValidDispatchKey("with space"), false);
	assert.equal(isValidDispatchKey(undefined), false);
	assert.equal(dispatchIdempotencyKey("console:1"), "dispatch:console:1");
});

test("reads the repository from params", () => {
	assert.equal(dispatchRepository({ repo: "acme/app" }), "acme/app");
	assert.equal(dispatchRepository({ repo: "acme" }), null);
	assert.equal(dispatchRepository({}), null);
});

test("a work command without an anchor asks PiG to create one", () => {
	const admission = admitted(
		planDispatch(
			input({ params: { repo: "acme/app", instructions: "Add a test" } }),
			42,
		),
	);
	assert.equal(admission.repo, "acme/app");
	assert.equal(admission.installationId, 42);
	assert.equal(admission.jobKind, "work");
	assert.equal(admission.chained, true);
	assert.equal(admission.idempotencyKey, "dispatch:console-1");
	const request = admission.request;
	assert.equal(request.kind, "work");
	assert.equal(request.origin, "console");
	assert.equal(request.actor, "alice");
	if (request.kind !== "work") return;
	assert.equal(request.target, "new");
	assert.equal(request.source.type, "generated");
	assert.equal(request.source.title, "Add a test");
});

test("a generated anchor keeps an explicit title", () => {
	const admission = admitted(
		planDispatch(
			input({
				params: {
					repo: "acme/app",
					instructions: "Long instructions",
					title: "Fix the parser",
				},
			}),
			42,
		),
	);
	assert.equal(
		admission.request.kind === "work" ? admission.request.source.title : null,
		"Fix the parser",
	);
});

test("a pull request anchor defaults to the head target and allows patch", () => {
	const base = { repo: "acme/app", anchor: 12, anchorType: "pull_request", instructions: "x" };
	const head = admitted(planDispatch(input({ params: base }), 42));
	assert.equal(head.request.kind === "work" ? head.request.target : null, "head");
	const patch = admitted(
		planDispatch(input({ params: { ...base, target: "patch" } }), 42),
	);
	assert.equal(patch.request.kind === "work" ? patch.request.target : null, "patch");
});

test("an issue anchor only supports the new target", () => {
	const issue = { repo: "acme/app", anchor: 7, anchorType: "issue", instructions: "x" };
	const plan = admitted(planDispatch(input({ params: issue }), 42));
	assert.equal(plan.request.kind === "work" ? plan.request.target : null, "new");

	const rejected = planDispatch(
		input({ params: { ...issue, target: "patch" } }),
		42,
	);
	assert.equal(rejected.kind, "reject");
});

test("a generated anchor rejects head and patch targets", () => {
	for (const target of ["head", "patch"]) {
		const plan = planDispatch(
			input({ params: { repo: "acme/app", instructions: "x", target } }),
			42,
		);
		assert.equal(plan.kind, "reject");
	}
});

test("a pull request anchor needs its type", () => {
	const plan = planDispatch(
		input({ params: { repo: "acme/app", anchor: 3, instructions: "x" } }),
		42,
	);
	assert.equal(plan.kind, "reject");
	if (plan.kind === "reject") assert.match(plan.error, /anchorType/);
});

test("work commands require instructions", () => {
	const plan = planDispatch(input({ params: { repo: "acme/app" } }), 42);
	assert.equal(plan.kind, "reject");
	const blank = planDispatch(
		input({ params: { repo: "acme/app", instructions: "   " } }),
		42,
	);
	assert.equal(blank.kind, "reject");
});

test("rejects unknown capabilities and non-GitHub actors", () => {
	assert.equal(planDispatch(input({ capability: "pig.nope" }), 42).kind, "reject");
	assert.equal(planDispatch(input({ actor: "not a login" }), 42).kind, "reject");
});

test("plans reviews, releases, and control commands", () => {
	const review = admitted(
		planDispatch(
			input({ capability: "pig.review", params: { repo: "acme/app", pullRequest: 5 } }),
			42,
		),
	);
	assert.equal(review.jobKind, "review");
	assert.equal(review.request.kind, "review");
	assert.equal(review.request.kind === "review" ? review.request.source.number : null, 5);
	assert.equal(review.request.kind === "review" ? review.request.auto : null, false);

	const release = admitted(
		planDispatch(input({ capability: "pig.release", params: { repo: "acme/app" } }), 42),
	);
	assert.equal(release.jobKind, "release");
	assert.equal(
		release.request.kind === "release" ? release.request.bump : null,
		"auto",
	);
	assert.equal(release.request.source.type, "repository");

	const status = admitted(
		planDispatch(input({ capability: "pig.status", params: { repo: "acme/app" } }), 42),
	);
	assert.equal(status.jobKind, "control");
	assert.equal(status.chained, false);
	assert.equal(status.maxAttempts, 1);
	assert.equal(status.request.kind === "control" ? status.request.action : null, "status");

	const cancel = admitted(
		planDispatch(input({ capability: "pig.cancel", params: { repo: "acme/app" } }), 42),
	);
	assert.equal(cancel.request.kind === "control" ? cancel.request.action : null, "cancel");
});

test("parses a dispatch envelope", () => {
	const parsed = parseDispatchEnvelope({
		now: 5_000,
		value: {
			capability: "pig.status",
			params: { repo: "acme/app" },
			dispatchKey: "console:9",
			actor: "alice",
			notAfter: 9_000,
			receivedAt: 1,
		},
	});
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.input.receivedAt, 5_000);
	assert.equal(parsed.input.notAfter, 9_000);
});

test("rejects malformed dispatch envelopes", () => {
	const cases: unknown[] = [
		null,
		[],
		{},
		{ capability: "", dispatchKey: "k", actor: "alice" },
		{ capability: "pig.status", dispatchKey: "bad key", actor: "alice" },
		{ capability: "pig.status", dispatchKey: "k" },
	];
	for (const value of cases) {
		assert.equal(parseDispatchEnvelope({ now: 1, value }).ok, false);
	}
	const defaults = parseDispatchEnvelope({
		now: 1,
		value: { capability: "pig.status", dispatchKey: "k", actor: "alice" },
	});
	assert.equal(defaults.ok, true);
	if (!defaults.ok) return;
	assert.deepEqual(defaults.input.params, {});
	assert.equal(defaults.input.notAfter, null);
});
