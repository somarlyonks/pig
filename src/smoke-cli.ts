import type { Octokit } from "@octokit/rest";
import { loadConfig } from "./config.ts";
import { openPigApp } from "./durable/app.ts";
import { resolveInstallationId } from "./dispatch/admit.ts";
import { createGitHubClients } from "./github/app.ts";
import { fetchRepository, splitRepository } from "./github/repo.ts";
import { createLogger } from "./logger.ts";
import { startHttpServer } from "./server.ts";
import { runSmoke } from "./smoke.ts";

interface Args {
	repo: string | null;
	anchor: number | null;
	actor: string | null;
	mode: "status" | "work";
	instructions: string;
}

function parseArgs(argv: string[]): Args {
	const positional: string[] = [];
	let actor: string | null = null;
	let mode: "status" | "work" = "status";
	let instructions = "Add a file proving PiG can open a pull request.";
	for (const argument of argv) {
		if (argument === "--work") {
			mode = "work";
			continue;
		}
		if (argument.startsWith("--actor=")) {
			actor = argument.slice("--actor=".length);
			continue;
		}
		if (argument.startsWith("--instructions=")) {
			instructions = argument.slice("--instructions=".length);
			continue;
		}
		positional.push(argument);
	}
	const repo = positional[0]?.includes("/") ? positional[0] : null;
	const anchorRaw = positional[1];
	const anchor = anchorRaw && /^\d+$/.test(anchorRaw) ? Number(anchorRaw) : null;
	return { repo, anchor, actor, mode, instructions };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (!args.repo || args.anchor === null) {
		process.stderr.write(
			"Usage: npm run smoke -- owner/name <issue-or-pr-number> [--work] [--actor=login] [--instructions=text]\n",
		);
		process.exit(2);
	}
	const config = loadConfig();
	const logger = createLogger(config.logLevel);
	const clients = createGitHubClients(config, logger);

	const installationId = await resolveInstallationId(clients.app, args.repo);
	if (installationId === null) {
		process.stderr.write(`✗ PiG is not installed on ${args.repo}\n`);
		process.exit(1);
	}
	const octokit = clients.installation(installationId);
	const repoInfo = await fetchRepository(octokit, args.repo);

	const actor = args.actor ?? (await installationAccount(clients.app, installationId));
	if (!actor) {
		process.stderr.write("✗ pass --actor=<github-login> with write access\n");
		process.exit(1);
	}

	const anchor = await readAnchor(octokit, args.repo, args.anchor);
	process.stdout.write(
		`PiG smoke run\n  repo: ${args.repo} (default ${repoInfo.defaultBranch})\n  anchor: #${anchor.number} ${anchor.title ?? ""}\n  actor: ${actor}\n  command: ${args.mode === "status" ? "@pig status" : "@pig fix …"}\n\n`,
	);

	const app = await openPigApp(config, logger);
	const running = await startHttpServer({
		config,
		logger,
		version: "smoke",
		app,
	});
	const address = running.server.address();
	const port = typeof address === "object" && address !== null ? address.port : config.port;
	try {
		const report = await runSmoke({
			repo: args.repo,
			installationId,
			anchor,
			actor,
			mode: args.mode,
			instructions: args.instructions,
			baseUrl: `http://127.0.0.1:${port}`,
			webhookSecret: config.webhookSecret,
			getJob: (id) => app.getJob(id),
		});
		process.stdout.write(`✓ job ${report.jobId}: ${report.status}\n`);
		if (report.summary) process.stdout.write(`  ${report.summary}\n`);
		if (report.error) process.stdout.write(`  error: ${report.error}\n`);
		const prUrl = report.result.prUrl;
		if (typeof prUrl === "string") {
			process.stdout.write(`  pull request: ${prUrl}\n`);
		}
		process.stdout.write(
			`  anchor: https://github.com/${args.repo}/${anchor.isPullRequest ? "pull" : "issues"}/${anchor.number}\n`,
		);
		if (report.status !== "succeeded") process.exitCode = 1;
	} finally {
		await running.close();
		await app.shutdown();
	}
}

async function installationAccount(app: Octokit, installationId: number): Promise<string | null> {
	try {
		const response = await app.request("GET /app/installations/{installation_id}", {
			installation_id: installationId,
		});
		const data = response.data as { account?: { login?: string } };
		return data.account?.login ?? null;
	} catch {
		return null;
	}
}

async function readAnchor(
	octokit: Octokit,
	repo: string,
	number: number,
): Promise<{ number: number; title: string | null; isPullRequest: boolean }> {
	const { owner, name } = splitRepository(repo);
	try {
		const { data } = await octokit.issues.get({ owner, repo: name, issue_number: number });
		return {
			number: data.number,
			title: data.title,
			isPullRequest: data.pull_request !== undefined,
		};
	} catch (error) {
		throw new Error(
			`cannot read #${number} in ${repo}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

main().catch((error) => {
	process.stderr.write(`✗ smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
