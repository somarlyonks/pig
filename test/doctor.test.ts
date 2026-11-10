import { test } from "node:test";
import assert from "node:assert/strict";
import type { Octokit } from "@octokit/rest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { AppConfig } from "../src/config.ts";
import { createNoModels } from "../src/durable/no-models.ts";
import { failedChecks, formatChecks, runDoctor, type DoctorOptions } from "../src/doctor.ts";

function config(): AppConfig {
	return {
		appId: 1,
		privateKey: "unused",
		webhookSecret: "secret",
		appSlug: "pig",
		port: 8787,
		databasePath: ":memory:",
		workspaceRoot: "/tmp/pig",
		model: undefined,
		thinking: undefined,
		tablePrefix: "pig_",
		jobTimeoutMs: 60_000,
		logLevel: "error",
		adminToken: undefined,
		console: null,
	};
}

function fauxModels() {
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

const GOOD_PERMISSIONS: Record<string, string> = {
	metadata: "read",
	contents: "write",
	issues: "write",
	pull_requests: "write",
};

function options(overrides: {
	appPermissions?: Record<string, string>;
	granted?: Record<string, string>;
	installations?: { id: number; account?: { login?: string } }[];
	installationId?: number | null;
	repoArchived?: boolean;
	hasConfig?: boolean;
	failApp?: boolean;
	models?: DoctorOptions["models"];
	repos?: string[];
} = {}): DoctorOptions {
	const appPermissions = overrides.appPermissions ?? GOOD_PERMISSIONS;
	const granted = overrides.granted ?? GOOD_PERMISSIONS;
	const app = {
		request: async (route: string) => {
			if (overrides.failApp) {
				throw Object.assign(new Error("Unauthorized"), { status: 401 });
			}
			if (route === "GET /app") {
				return { data: { slug: "pig", permissions: appPermissions } };
			}
			if (route === "GET /app/installations") {
				return {
					data: overrides.installations ?? [{ id: 42, account: { login: "acme" } }],
				};
			}
			if (route.startsWith("POST /app/installations/")) {
				return { data: { token: "t", permissions: granted } };
			}
			throw new Error(`unexpected route ${route}`);
		},
	} as unknown as Octokit;

	const installationClient = {
		repos: {
			get: async () => ({
				data: {
					full_name: "acme/app",
					default_branch: "main",
					archived: overrides.repoArchived ?? false,
				},
			}),
			getContent: async () => {
				if (!overrides.hasConfig) {
					throw Object.assign(new Error("Not Found"), { status: 404 });
				}
				return { data: { type: "file" } };
			},
		},
	} as unknown as Octokit;

	return {
		config: config(),
		app,
		models: overrides.models ?? fauxModels(),
		repos: overrides.repos ?? ["acme/app"],
		installation: async () =>
			overrides.installationId === undefined ? 42 : overrides.installationId,
		client: () => installationClient,
	};
}

test("reports a healthy installation without failures", async () => {
	const checks = await runDoctor(options());
	assert.deepEqual(failedChecks(checks), []);
	const rendered = formatChecks(checks);
	assert.match(rendered, /✓ app credentials: authenticated as pig/);
	assert.match(rendered, /✓ permissions for acme\/app/);
	assert.match(rendered, /default branch main/);
	assert.match(rendered, /absent, defaults apply/);
	assert.match(rendered, /✓ model: faux\/faux-1/);
});

test("fails when the installation is missing a required permission", async () => {
	const checks = await runDoctor(
		options({
			granted: { metadata: "read", contents: "write", pull_requests: "write" },
		}),
	);
	const failures = failedChecks(checks);
	assert.equal(failures.length, 1);
	assert.match(failures[0]?.detail ?? "", /issues: write/);
	assert.match(failures[0]?.detail ?? "", /progress comments/);
});

test("fails when the app is not installed on the repository", async () => {
	const checks = await runDoctor(options({ installationId: null }));
	const failures = failedChecks(checks);
	assert.equal(failures.length, 1);
	assert.match(failures[0]?.detail ?? "", /not installed/);
});

test("reports bad app credentials without crashing", async () => {
	const checks = await runDoctor(options({ failApp: true }));
	const titles = failedChecks(checks).map((check) => check.title);
	assert.ok(titles.includes("app credentials"));
	assert.ok(titles.includes("installations"));
	assert.match(formatChecks(checks), /401 Unauthorized/);
});

test("warns instead of failing when permissions are not declared", async () => {
	const checks = await runDoctor(
		options({ appPermissions: { metadata: "read", contents: "write" } }),
	);
	const declared = checks.find((check) => check.title === "app permissions declared");
	assert.equal(declared?.level, "warn");
	assert.match(declared?.detail ?? "", /issues, pull_requests/);
});

test("fails without a model and without a webhook secret", async () => {
	const withoutModel = await runDoctor(options({ models: createNoModels() }));
	assert.ok(
		failedChecks(withoutModel).some((check) => check.title === "model"),
	);

	const brokenConfig = options();
	brokenConfig.config = { ...brokenConfig.config, webhookSecret: "" };
	const withoutSecret = await runDoctor(brokenConfig);
	assert.ok(
		failedChecks(withoutSecret).some((check) => check.title === "webhook secret"),
	);
});

test("rejects a malformed repository argument", async () => {
	const checks = await runDoctor(options({ repos: ["not-a-repository"] }));
	const failures = failedChecks(checks);
	assert.equal(failures[0]?.title, "repository not-a-repository");
});
