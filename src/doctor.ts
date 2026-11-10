import type { Octokit } from "@octokit/rest";
import type { Models } from "@earendil-works/pi-ai/models";
import { splitRepository } from "./github/repo.ts";
import { resolveModel } from "./durable/models.ts";
import type { AppConfig } from "./config.ts";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
	level: CheckLevel;
	title: string;
	detail: string;
}

const REQUIRED_PERMISSIONS: { name: string; level: string; why: string }[] = [
	{ name: "metadata", level: "read", why: "mandatory" },
	{ name: "contents", level: "write", why: "branches, tags, releases" },
	{ name: "issues", level: "write", why: "progress comments and anchor issues" },
	{ name: "pull_requests", level: "write", why: "pull requests and reviews" },
];

const WRITE = new Set(["write", "admin"]);

function permissionSatisfied(granted: string | undefined, required: string): boolean {
	if (!granted) return false;
	if (required === "read") return granted === "read" || WRITE.has(granted);
	return WRITE.has(granted);
}

function formatPermissions(permissions: Record<string, string> | undefined): string {
	if (!permissions) return "none reported";
	return Object.entries(permissions)
		.map(([name, level]) => `${name}: ${level}`)
		.sort()
		.join(", ");
}

export interface DoctorOptions {
	config: AppConfig;
	app: Octokit;
	models: Models;
	repos: string[];
	installation(client: Octokit, repo: string): Promise<number | null>;
	client(installationId: number): Octokit;
}

async function checkApp(options: DoctorOptions, checks: Check[]): Promise<void> {
	try {
		const { data } = await options.app.request("GET /app");
		const app = data as { slug?: string; permissions?: Record<string, string> };
		checks.push({
			level: "ok",
			title: "app credentials",
			detail: `authenticated as ${app.slug ?? "unknown"}`,
		});
		const permissions = app.permissions ?? {};
		const configured = REQUIRED_PERMISSIONS.filter(
			(requirement) => permissions[requirement.name] !== undefined,
		).map((requirement) => requirement.name);
		const missingConfigured = REQUIRED_PERMISSIONS.filter(
			(requirement) => permissions[requirement.name] === undefined,
		);
		if (missingConfigured.length > 0) {
			checks.push({
				level: "warn",
				title: "app permissions declared",
				detail: `not declared: ${missingConfigured.map((entry) => entry.name).join(", ")} (declared: ${configured.join(", ") || "none"})`,
			});
		} else {
			checks.push({
				level: "ok",
				title: "app permissions declared",
				detail: formatPermissions(permissions),
			});
		}
	} catch (error) {
		checks.push({
			level: "fail",
			title: "app credentials",
			detail: `GET /app failed: ${describe(error)}`,
		});
	}
}

async function checkInstallations(options: DoctorOptions, checks: Check[]): Promise<void> {
	try {
		const response = await options.app.request("GET /app/installations");
		const installations = response.data as { id: number; account?: { login?: string } }[];
		checks.push({
			level: installations.length > 0 ? "ok" : "warn",
			title: "installations",
			detail:
				installations.length === 0
					? "the app is not installed anywhere yet"
					: installations
							.map((entry) => `${entry.account?.login ?? entry.id}`)
							.join(", "),
		});
	} catch (error) {
		checks.push({
			level: "fail",
			title: "installations",
			detail: `GET /app/installations failed: ${describe(error)}`,
		});
	}
}

async function checkRepository(
	options: DoctorOptions,
	repo: string,
	checks: Check[],
): Promise<void> {
	try {
		splitRepository(repo);
	} catch (error) {
		checks.push({ level: "fail", title: `repository ${repo}`, detail: describe(error) });
		return;
	}
	let installationId: number | null;
	try {
		installationId = await options.installation(options.app, repo);
	} catch (error) {
		checks.push({
			level: "fail",
			title: `repository ${repo}`,
			detail: `installation lookup failed: ${describe(error)}`,
		});
		return;
	}
	if (installationId === null) {
		checks.push({
			level: "fail",
			title: `repository ${repo}`,
			detail: "PiG is not installed on this repository",
		});
		return;
	}

	let token: { permissions?: Record<string, string> };
	try {
		const response = await options.app.request(
			"POST /app/installations/{installation_id}/access_tokens",
			{
				installation_id: installationId,
			},
		);
		token = response.data as { permissions?: Record<string, string> };
	} catch (error) {
		checks.push({
			level: "fail",
			title: `repository ${repo}`,
			detail: `could not create an installation token: ${describe(error)}`,
		});
		return;
	}

	const granted = token.permissions ?? {};
	const missing = REQUIRED_PERMISSIONS.filter(
		(requirement) => !permissionSatisfied(granted[requirement.name], requirement.level),
	);
	if (missing.length === 0) {
		checks.push({
			level: "ok",
			title: `permissions for ${repo}`,
			detail: formatPermissions(granted),
		});
	} else {
		checks.push({
			level: "fail",
			title: `permissions for ${repo}`,
			detail: `missing ${missing
				.map((entry) => `${entry.name}: ${entry.level} (${entry.why})`)
				.join("; ")} — granted: ${formatPermissions(granted)}`,
		});
	}

	try {
		const { owner, name } = splitRepository(repo);
		const client = options.client(installationId);
		const { data } = await client.repos.get({ owner, repo: name });
		checks.push({
			level: "ok",
			title: `repository ${repo}`,
			detail: `default branch ${data.default_branch}${data.archived ? " (archived!)" : ""}`,
		});
		if (data.archived) {
			checks.push({
				level: "warn",
				title: `repository ${repo} archived`,
				detail: "PiG rejects archived repositories",
			});
		}
		const configFile = await client.repos
			.getContent({ owner, repo: name, path: ".pig.yml" })
			.catch(() => null);
		checks.push({
			level: "ok",
			title: `.pig.yml for ${repo}`,
			detail: configFile ? "present on the default branch" : "absent, defaults apply",
		});
	} catch (error) {
		checks.push({
			level: "fail",
			title: `repository ${repo}`,
			detail: `cannot read the repository: ${describe(error)}`,
		});
	}
}

async function checkModel(options: DoctorOptions, checks: Check[]): Promise<void> {
	try {
		const resolved = await resolveModel(options.models, options.config.model ?? null, options.config.thinking ?? null);
		checks.push({
			level: "ok",
			title: "model",
			detail: `${resolved.model.provider}/${resolved.model.id}${resolved.thinking ? ` (${resolved.thinking})` : ""}`,
		});
	} catch (error) {
		checks.push({
			level: "fail",
			title: "model",
			detail: `${describe(error)} — set a provider key or PIG_MODEL`,
		});
	}
}

function checkWebhook(options: DoctorOptions, checks: Check[]): void {
	if (!options.config.webhookSecret) {
		checks.push({ level: "fail", title: "webhook secret", detail: "PIG_WEBHOOK_SECRET is not set" });
		return;
	}
	checks.push({
		level: "ok",
		title: "webhook secret",
		detail: "configured; point the app's webhook at https://<your-host>/api/github/webhooks",
	});
}

function describe(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const status = (error as { status?: unknown }).status;
		const message = (error as { message?: unknown }).message;
		if (typeof status === "number") {
			return `${status} ${typeof message === "string" ? message : ""}`.trim();
		}
		if (typeof message === "string") return message;
	}
	return String(error);
}

export async function runDoctor(options: DoctorOptions): Promise<Check[]> {
	const checks: Check[] = [
		{
			level: "ok",
			title: "config",
			detail: `app id ${options.config.appId}, slug ${options.config.appSlug}, prefix ${options.config.tablePrefix || "(none)"}`,
		},
	];
	await checkApp(options, checks);
	await checkInstallations(options, checks);
	for (const repo of options.repos) {
		await checkRepository(options, repo, checks);
	}
	await checkModel(options, checks);
	checkWebhook(options, checks);
	return checks;
}

export function formatChecks(checks: readonly Check[]): string {
	const symbol: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗" };
	return checks
		.map((check) => `${symbol[check.level]} ${check.title}: ${check.detail}`)
		.join("\n");
}

export function failedChecks(checks: readonly Check[]): Check[] {
	return checks.filter((check) => check.level === "fail");
}
