import { loadConfig } from "./config.ts";
import { createModelRuntime } from "./durable/models.ts";
import { resolveInstallationId } from "./dispatch/admit.ts";
import { createGitHubClients } from "./github/app.ts";
import { createLogger } from "./logger.ts";
import { failedChecks, formatChecks, runDoctor } from "./doctor.ts";

async function main(): Promise<void> {
	const repos = process.argv
		.slice(2)
		.map((argument) => argument.trim())
		.filter((argument) => argument.includes("/"));

	let config;
	try {
		config = loadConfig();
	} catch (error) {
		process.stderr.write(
			`✗ config: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	}

	const logger = createLogger("error");
	const clients = createGitHubClients(config, logger);
	const checks = await runDoctor({
		config,
		app: clients.app,
		models: createModelRuntime(),
		repos,
		installation: resolveInstallationId,
		client: (installationId) => clients.installation(installationId),
	});
	process.stdout.write(`${formatChecks(checks)}\n`);
	if (repos.length === 0) {
		process.stdout.write(
			"\nPass a repository to check installation permissions: npm run doctor -- owner/name\n",
		);
	}
	const failures = failedChecks(checks);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
	process.stderr.write(
		`✗ doctor crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
	process.exit(1);
});
