import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { runConsoleSession } from "./console/session-client.ts";
import { openPigApp } from "./durable/app.ts";
import { createLogger } from "./logger.ts";
import { startHttpServer, type RunningServer } from "./server.ts";

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

	const app = await openPigApp(config, logger);
	let runningServer: RunningServer | null = null;
	let shuttingDown = false;
	const sessionController = new AbortController();

	const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		sessionController.abort();
		logger.info("Shutting down", { signal, exitCode });
		try {
			if (runningServer) {
				await runningServer.close();
			}
			const closed = app.shutdown();
			const timeout = new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 25_000);
				timer.unref();
			});
			await Promise.race([closed, timeout]);
		} catch (error) {
			logger.error("Shutdown error", { error });
		} finally {
			logger.info("Shutdown complete");
			process.exit(exitCode);
		}
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("unhandledRejection", (reason) => {
		logger.error("Unhandled promise rejection", { error: reason });
	});
	process.on("uncaughtException", (error) => {
		logger.error("Uncaught exception", { error });
		void shutdown("uncaughtException", 1);
	});

	void app.closed.then((end) => {
		if (end.kind === "failed") {
			logger.error("Pi-durable session failed; shutting down", { error: end.error });
			void shutdown("harness failure", 1);
		}
	});

	try {
		runningServer = await startHttpServer({ config, logger, version, app });
	} catch (error) {
		logger.error("Could not start HTTP server", { error });
		await app.shutdown().catch(() => undefined);
		process.exit(1);
	}

	if (config.console) {
		const session = config.console;
		void runConsoleSession({
			consoleBaseUrl: session.baseUrl,
			workerId: session.workerId,
			token: session.token,
			repos: session.repos,
			fetch,
			dispatch: (input) => app.dispatch(input),
			listJobs: (repo, limit) => app.listJobs(repo, limit),
			logger,
			signal: sessionController.signal,
		}).catch((error) => {
			logger.error("Console session stopped", { error });
		});
		logger.info("Console session started", {
			workerId: session.workerId,
			repos: session.repos.length,
		});
	}

	logger.info("PiG started", {
		version,
		appSlug: config.appSlug,
		model: config.model ?? "auto",
		storage: config.databasePath,
	});
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
});
