import { resolve } from "node:path";
import { startRunnerServer } from "./server.ts";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

async function main(): Promise<void> {
	const port = Number(process.env.PIG_RUNNER_PORT ?? 8790);
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error("PIG_RUNNER_PORT must be a positive integer");
	}
	const runner = await startRunnerServer({
		port,
		token: required("PIG_RUNNER_TOKEN"),
		workspaceRoot: resolve(
			process.env.PIG_RUNNER_WORKSPACE_ROOT?.trim() || "./data/runner",
		),
	});
	console.log(`PiG runner listening on :${runner.port}`);
	const shutdown = async () => {
		await runner.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
