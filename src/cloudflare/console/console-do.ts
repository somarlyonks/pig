import { DurableObject } from "cloudflare:workers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { handleConsoleRequest, consoleServiceFromRuntime } from "../../console/http.ts";
import { createConsoleRuntime, type ConsoleRuntime } from "../../console/runtime.ts";
import { createConsoleLogger } from "../logger.ts";
import { consoleConfig, type ConsoleEnv } from "./env.ts";

/**
 * One console workspace owns one `pi-durable` storage. It is a separate
 * deployment from PiG: the console's state is cross-repository while a worker's
 * storage is per repository, so the two never share a database.
 */
export class ConsoleDurableObject extends DurableObject<ConsoleEnv> {
	#runtime: ConsoleRuntime | null = null;

	constructor(ctx: DurableObjectState, env: ConsoleEnv) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(() => this.#initialize());
	}

	async #initialize(): Promise<void> {
		const config = consoleConfig(this.env);
		const storage = await openDurableObjectSqliteStorage(
			this.ctx.storage,
			config.tablePrefix === "" ? {} : { prefix: config.tablePrefix },
		);
		this.#runtime = await createConsoleRuntime({
			storage,
			config,
			logger: createConsoleLogger("info"),
			fetch: (input, init) => fetch(input, init),
		});
		void this.#runtime.closed.then((end) => {
			if (end.kind === "failed") {
				this.ctx.abort("console harness failed");
			}
		});
	}

	#requireRuntime(): ConsoleRuntime {
		if (!this.#runtime) {
			throw new Error("console runtime is not initialized");
		}
		return this.#runtime;
	}

	override async fetch(request: Request): Promise<Response> {
		const config = consoleConfig(this.env);
		return handleConsoleRequest(request, {
			service: consoleServiceFromRuntime(this.#requireRuntime()),
			adminToken: config.adminToken,
			now: () => Date.now(),
		});
	}

	override async alarm(): Promise<void> {
		// Phase 3 adds outbound sessions here. Nothing is scheduled yet.
		this.#requireRuntime().resume();
	}
}
