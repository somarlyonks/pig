import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { createGitHubClients } from "./github/app.ts";
import { RepoConfigLoader } from "./github/repo-config.ts";
import { runPiAgent, type AgentRunner } from "./agent/runner.ts";
import { JobStore } from "./jobs/store.ts";
import { JobWorker } from "./jobs/worker.ts";
import { createLogger } from "./logger.ts";
import { startHttpServer, type RunningServer } from "./server.ts";
import { handleWebhook } from "./webhooks/handler.ts";

function readVersion(): string {
	try {
		const metadata = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version?: unknown };
		return typeof metadata.version === "string" ? metadata.version : "unknown";
	} catch {
		return "unknown";
	}
}

async function main(): Promise<void> {
	const config = loadConfig();
	const logger = createLogger(config.logLevel);
	const version = readVersion();

	const store = new JobStore(config.databasePath);
	const clients = createGitHubClients(config, logger);
	const configLoader = new RepoConfigLoader(30, logger);
	const agentRunner: AgentRunner = (options) => runPiAgent(config.piBin, options);
	const worker = new JobWorker({
		config,
		store,
		clients,
		configLoader,
		agentRunner,
		logger,
	});

	const handle = (input: Parameters<typeof handleWebhook>[1]) =>
		handleWebhook(
			{
				store,
				logger,
				appSlug: config.appSlug,
			},
			input,
		);

	let runningServer: RunningServer | null = null;
	let shuttingDown = false;

	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down", { signal });
		try {
			if (runningServer) {
				await runningServer.close();
			}
			await worker.stop();
		} catch (error) {
			logger.error("Shutdown error", { error });
		} finally {
			store.close();
			logger.info("Shutdown complete");
			process.exit(0);
		}
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("unhandledRejection", (reason) => {
		logger.error("Unhandled promise rejection", { error: reason });
	});
	process.on("uncaughtException", (error) => {
		logger.error("Uncaught exception", { error });
		void shutdown("uncaughtException");
	});

	worker.start();
	try {
		runningServer = await startHttpServer({
			config,
			store,
			logger,
			version,
			handleWebhook: handle,
		});
	} catch (error) {
		logger.error("Could not start HTTP server", { error });
		await worker.stop();
		store.close();
		process.exit(1);
	}

	logger.info("PiG started", {
		version,
		appSlug: config.appSlug,
		concurrency: config.maxConcurrency,
		piBin: config.piBin,
	});
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
});
