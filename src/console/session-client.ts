import type { Logger } from "../logger.ts";
import type { WebhookResult } from "../durable/admission.ts";

export interface SessionCommand {
	seq: number;
	dispatchKey: string;
	capability: string;
	params: Record<string, unknown>;
	actor: string;
	notAfter: number | null;
}

export interface SessionOptions {
	consoleBaseUrl: string;
	workerId: string;
	token: string;
	repos: string[];
	fetch: typeof fetch;
	dispatch: (input: {
		capability: string;
		params: Record<string, unknown>;
		dispatchKey: string;
		actor: string;
		receivedAt: number;
		notAfter: number | null;
	}) => Promise<WebhookResult>;
	listJobs: (repo: string, limit: number) => Promise<unknown[]>;
	logger: Logger;
	signal: AbortSignal;
	sleep?: (ms: number) => Promise<void>;
	reportEveryMs?: number;
	waitMs?: number;
	now?: () => number;
}

const MAX_BACKOFF_MS = 30_000;

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const value = (await response.json()) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Runs an outbound session against a console. The worker defines the cursor, so
 * a console that loses its state cannot replay a command into a second job; the
 * console's records are delivery attempts and the worker's admission deduplicates
 * by dispatch key.
 */
export async function runConsoleSession(options: SessionOptions): Promise<void> {
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = options.now ?? (() => Date.now());
	const baseUrl = options.consoleBaseUrl.replace(/\/+$/, "");
	let cursor = 0;
	let backoff = 1_000;
	let lastReport = 0;

	const headers = {
		authorization: `Bearer ${options.token}`,
		"content-type": "application/json",
	};

	async function report(): Promise<void> {
		if (options.repos.length === 0) return;
		const reports = [];
		for (const repo of options.repos) {
			try {
				reports.push({ repo, jobs: await options.listJobs(repo, 20) });
			} catch (error) {
				options.logger.debug("Could not read jobs for the console report", { repo, error });
			}
		}
		if (reports.length === 0) return;
		const response = await options.fetch(`${baseUrl}/api/session/report`, {
			method: "POST",
			headers,
			body: JSON.stringify({ workerId: options.workerId, reports }),
			signal: options.signal,
		});
		if (!response.ok) {
			throw new Error(`console report failed: ${response.status}`);
		}
		lastReport = now();
	}

	async function ack(
		results: { dispatchKey: string; jobId: string | null; error: string | null }[],
	): Promise<void> {
		const response = await options.fetch(`${baseUrl}/api/session/ack`, {
			method: "POST",
			headers,
			body: JSON.stringify({ workerId: options.workerId, results }),
			signal: options.signal,
		});
		if (!response.ok) {
			throw new Error(`console ack failed: ${response.status}`);
		}
	}

	async function announce(state: "active" | "stopped"): Promise<void> {
		try {
			await options.fetch(`${baseUrl}/api/session/state`, {
				method: "POST",
				headers,
				body: JSON.stringify({ workerId: options.workerId, state }),
			});
		} catch (error) {
			options.logger.debug("Could not announce the session state", { state, error });
		}
	}

	await announce("active");
	while (!options.signal.aborted) {
		try {
			if (now() - lastReport >= (options.reportEveryMs ?? 30_000)) {
				await report();
			}
			const query = new URLSearchParams({
				workerId: options.workerId,
				cursor: String(cursor),
				waitMs: String(options.waitMs ?? 20_000),
			});
			const response = await options.fetch(`${baseUrl}/api/session/commands?${query}`, {
				headers,
				signal: options.signal,
			});
			if (response.status === 401 || response.status === 403) {
				options.logger.warn("Console session paused; register this worker again", {
					workerId: options.workerId,
					status: response.status,
				});
				await announce("stopped");
				return;
			}
			if (!response.ok) {
				throw new Error(`console poll failed: ${response.status}`);
			}
			const body = await readJson(response);
			const commands = Array.isArray(body?.commands)
				? (body.commands as SessionCommand[])
				: [];
			const nextCursor = typeof body?.cursor === "number" ? body.cursor : cursor;
			const pollAfterMs =
				typeof body?.pollAfterMs === "number" ? body.pollAfterMs : 2_000;

			if (commands.length > 0) {
				const results = [];
				for (const command of commands) {
					try {
						const outcome = await options.dispatch({
							capability: command.capability,
							params: command.params,
							dispatchKey: command.dispatchKey,
							actor: command.actor,
							receivedAt: now(),
							notAfter: command.notAfter,
						});
						const accepted =
							outcome.status === 202 || outcome.status === 200;
						const jobId =
							typeof outcome.body.jobId === "string" ? outcome.body.jobId : null;
						results.push({
							dispatchKey: command.dispatchKey,
							jobId,
							error: accepted
								? null
								: typeof outcome.body.error === "string"
									? outcome.body.error
									: `worker rejected the command with ${outcome.status}`,
						});
					} catch (error) {
						results.push({
							dispatchKey: command.dispatchKey,
							jobId: null,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				await ack(results);
			}

			cursor = nextCursor;
			backoff = 1_000;
			if (commands.length === 0 && pollAfterMs > 0) {
				await sleep(pollAfterMs);
			}
		} catch (error) {
			if (options.signal.aborted) {
				await announce("stopped");
				return;
			}
			options.logger.warn("Console session error; retrying", {
				workerId: options.workerId,
				error: error instanceof Error ? error.message : String(error),
				retryInMs: backoff,
			});
			await sleep(backoff);
			backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
		}
	}
}
