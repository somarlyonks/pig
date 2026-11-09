import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createGitHubClients } from "../github/app.ts";
import {
	createOrchestrationRuntime,
	type OrchestrationRuntime,
} from "../durable/orchestration-runtime.ts";
import { cloudflareConfig } from "./config.ts";
import type { CloudflareEnv } from "./env.ts";
import { createConsoleLogger } from "./logger.ts";

const RECOVERY_ALARM_MS = 60_000;

export class RepoDurableObject extends DurableObject<CloudflareEnv> {
	#runtime: OrchestrationRuntime | null = null;
	#alarmQueue: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: CloudflareEnv) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(() => this.#initialize());
	}

	async #initialize(): Promise<void> {
		const logger = createConsoleLogger("info");
		const config = cloudflareConfig(this.env);
		const clients = createGitHubClients(config, logger);
		const storage = await openDurableObjectSqliteStorage(
			this.ctx.storage,
			config.tablePrefix === "" ? {} : { prefix: config.tablePrefix },
		);
		const runtime = await createOrchestrationRuntime({
			storage,
			config,
			clients,
			logger,
			recoveryMs: RECOVERY_ALARM_MS,
			onWake: (wake) => {
				void this.#arm(wake).catch((error) => {
					console.error("Could not arm the PiG alarm", error);
				});
			},
		});
		this.#runtime = runtime;
		void runtime.closed.then((end) => {
			if (end.kind === "failed") {
				this.ctx.abort("PiG harness failed");
			}
		});
		await this.#arm(runtime.wake());
		runtime.resume();
	}

	#requireRuntime(): OrchestrationRuntime {
		if (!this.#runtime) {
			throw new Error("PiG runtime is not initialized");
		}
		return this.#runtime;
	}

	#arm(wake: Wake): Promise<void> {
		const run = async () => {
			const recovery = Date.now() + RECOVERY_ALARM_MS;
			const at =
				wake.active && wake.at !== undefined
					? Math.min(recovery, wake.at)
					: wake.active
						? recovery
						: wake.at;
			if (at === undefined) {
				await this.ctx.storage.deleteAlarm();
			} else {
				await this.ctx.storage.setAlarm(at);
			}
		};
		const next = this.#alarmQueue.then(run, run);
		this.#alarmQueue = next.catch(() => {});
		return next;
	}

	async #refreshAlarm(): Promise<void> {
		const at = await this.#requireRuntime().nextAlarm(Date.now());
		const run = async () => {
			if (at === undefined) {
				await this.ctx.storage.deleteAlarm();
			} else {
				await this.ctx.storage.setAlarm(at);
			}
		};
		const next = this.#alarmQueue.then(run, run);
		this.#alarmQueue = next.catch(() => {});
		await next;
	}

	override async alarm(): Promise<void> {
		await this.#refreshAlarm();
		this.#requireRuntime().resume();
	}

	override async fetch(request: Request): Promise<Response> {
		const runtime = this.#requireRuntime();
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/admit") {
				const input = (await request.json()) as {
					event: string;
					deliveryId: string;
					payload: unknown;
				};
				const result = await runtime.admit(input);
				return Response.json(result.body, { status: result.status });
			}
			if (request.method === "GET" && url.pathname === "/jobs") {
				const repo = url.searchParams.get("repo");
				if (!repo) return Response.json({ error: "repo is required" }, { status: 400 });
				const rawLimit = Number(url.searchParams.get("limit") ?? 20);
				const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
				return Response.json({ jobs: await runtime.listJobs(repo, limit) });
			}
			if (request.method === "GET" && url.pathname === "/job") {
				const repo = url.searchParams.get("repo");
				const id = url.searchParams.get("id");
				if (!repo || !id) {
					return Response.json({ error: "repo and id are required" }, { status: 400 });
				}
				const detail = await runtime.getJob(id, repo);
				return detail
					? Response.json(detail)
					: Response.json({ error: "job not found" }, { status: 404 });
			}
			if (request.method === "GET" && url.pathname === "/health") {
				return Response.json({ ok: true, activeJobs: await runtime.activeJobs() });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 500 },
			);
		}
	}
}
