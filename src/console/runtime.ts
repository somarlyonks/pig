import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
	Harness,
	createRegistry,
	type SessionEnd,
	type Storage,
	type Wake,
} from "@earendil-works/pi-durable";
import type { CapabilityDescriptor } from "../dispatch/capabilities.ts";
import type { Logger } from "../logger.ts";
import { createNoModels } from "../durable/no-models.ts";
import { WorkerClient, WorkerRequestError, type WorkerJobState } from "./client.ts";
import {
	DispatchDoc,
	DispatchIndexDoc,
	EnrollmentDoc,
	ObservationDoc,
	RegistryDoc,
	WorkerCredentialDoc,
	WorkerDoc,
	type ConsoleTransport,
	type DispatchDocValue,
	type WorkerDocValue,
} from "./docs.ts";

export interface ConsoleConfig {
	adminToken: string | undefined;
	tablePrefix: string;
	enrollmentTtlMs: number;
	observationTtlMs: number;
	dispatchDeadlineMs: number;
	workerTimeoutMs: number;
	logLevel: string;
}

const MAX_RECENT_DISPATCHES = 50;
const MAX_OBSERVED_JOBS = 20;

export interface WorkerView {
	workerId: string;
	kind: string;
	version: string;
	transport: ConsoleTransport;
	baseUrl: string;
	repos: string[];
	capabilities: CapabilityDescriptor[];
	registeredAt: number;
	observations: { repo: string; observedAt: number; ok: boolean; error: string | null }[];
}

export interface StateJob {
	workerId: string;
	repo: string;
	observedAt: number;
	job: WorkerJobState;
}

export interface StateDispatch {
	dispatchKey: string;
	proposalId: string;
	workerId: string;
	repo: string;
	capability: string;
	params: JsonValue;
	actor: string;
	state: string;
	jobId: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ConsoleState {
	now: number;
	workers: WorkerView[];
	jobs: StateJob[];
	dispatches: StateDispatch[];
}

export interface ConsoleProposal {
	dispatchKey: string;
	proposalId: string;
	workerId: string;
	repo: string;
	capability: string;
	params: Record<string, unknown>;
	actor: string;
	dangerous: boolean;
}

export type SubmitResult =
	| { status: "confirmation_required"; proposal: ConsoleProposal }
	| { status: "accepted"; dispatch: StateDispatch }
	| { status: "rejected"; error: string }
	| { status: "unconfirmed"; error: string; dispatch: StateDispatch };

export interface ConsoleRuntimeOptions {
	storage: Storage;
	config: ConsoleConfig;
	logger: Logger;
	fetch: typeof fetch;
	now?: () => number;
	onWake?: (wake: Wake) => void;
}

export interface ConsoleRuntime {
	harness: Harness;
	wake(): Wake;
	resume(): void;
	closed: Promise<SessionEnd>;
	createEnrollment(input: {
		label: string;
		ttlMs?: number;
	}): Promise<{ token: string; expiresAt: number }>;
	registerWorker(input: {
		enrollmentToken: string;
		workerId: string;
		kind: string;
		transport: ConsoleTransport;
		baseUrl: string;
		repos: string[];
		secret: string;
	}): Promise<WorkerView>;
	listWorkers(): Promise<WorkerView[]>;
	propose(input: {
		workerId: string;
		capability: string;
		params: Record<string, unknown>;
		actor: string;
		proposalId?: string;
	}): Promise<{ ok: true; proposal: ConsoleProposal } | { ok: false; status: number; error: string }>;
	submit(input: {
		workerId: string;
		capability: string;
		params: Record<string, unknown>;
		actor: string;
		proposalId?: string;
		confirm?: boolean;
	}): Promise<{ status: number; body: Record<string, unknown> }>;
	lookup(dispatchKey: string): Promise<StateDispatch | null>;
	state(options?: { refresh?: boolean }): Promise<ConsoleState>;
	shutdown(): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function workerKey(workerId: string, repo: string): string {
	return `${workerId}:${repo}`;
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function newToken(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function capabilitiesFrom(value: readonly JsonValue[]): CapabilityDescriptor[] {
	return value.filter(
		(entry): entry is JsonValue & CapabilityDescriptor =>
			asRecord(entry) !== null && typeof (entry as unknown as CapabilityDescriptor).name === "string",
	) as unknown as CapabilityDescriptor[];
}

function toWorkerView(doc: WorkerDocValue, observations: { repo: string; observedAt: number; ok: boolean; error: string | null }[]): WorkerView {
	return {
		workerId: doc.workerId,
		kind: doc.kind,
		version: doc.version,
		transport: doc.transport,
		baseUrl: doc.baseUrl,
		repos: doc.repos,
		capabilities: capabilitiesFrom(doc.capabilities),
		registeredAt: doc.createdAt,
		observations,
	};
}

function toDispatchView(doc: DispatchDocValue): StateDispatch {
	return {
		dispatchKey: doc.dispatchKey,
		proposalId: doc.proposalId,
		workerId: doc.workerId,
		repo: doc.repo,
		capability: doc.capability,
		params: doc.params,
		actor: doc.actor,
		state: doc.state,
		jobId: doc.jobId,
		error: doc.error,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
	};
}

function findCapability(
	capabilities: CapabilityDescriptor[],
	name: string,
): CapabilityDescriptor | null {
	return capabilities.find((capability) => capability.name === name) ?? null;
}

function repoAllowed(worker: WorkerDocValue, repo: string): boolean {
	return worker.repos.includes("*") || worker.repos.includes(repo);
}

export function proposalIdFor(input: string | undefined, now: number): string {
	const trimmed = input?.trim();
	if (trimmed && /^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed;
	return `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function createConsoleRuntime(
	options: ConsoleRuntimeOptions,
): Promise<ConsoleRuntime> {
	const { config, logger } = options;
	const now = options.now ?? (() => Date.now());
	const registry = createRegistry();
	const harness = await Harness.open(
		options.storage,
		{
			models: createNoModels(),
			registry,
			settings: { extensions: [] },
			now,
			...(options.onWake ? { onWake: options.onWake } : {}),
			onReport: (report) => logger.error("Pi-durable report", { kind: report.kind, error: report.error }),
		},
		BACKGROUND_CONTEXT,
	);
	await harness.root(BACKGROUND_CONTEXT);
	harness.resume();

	async function readWorker(workerId: string): Promise<WorkerDocValue | null> {
		const doc = await harness.snapshot(WorkerDoc, workerId, BACKGROUND_CONTEXT);
		return doc ? ({ ...doc } as WorkerDocValue) : null;
	}

	async function clientFor(workerId: string): Promise<{ worker: WorkerDocValue; client: WorkerClient }> {
		const worker = await readWorker(workerId);
		if (!worker) throw new WorkerRequestError(`unknown worker: ${workerId}`, 404);
		const credential = await harness.snapshot(
			WorkerCredentialDoc,
			workerId,
			BACKGROUND_CONTEXT,
		);
		if (!credential?.secret) {
			throw new WorkerRequestError(`worker ${workerId} has no credential`, 500);
		}
		return {
			worker,
			client: new WorkerClient({
				fetch: options.fetch,
				baseUrl: worker.baseUrl,
				secret: credential.secret,
				timeoutMs: config.workerTimeoutMs,
			}),
		};
	}

	async function observationsFor(workerId: string): Promise<
		{ repo: string; observedAt: number; ok: boolean; error: string | null; jobs: JsonValue[] }[]
	> {
		const worker = await readWorker(workerId);
		if (!worker) return [];
		const entries = await Promise.all(
			worker.repos.map(async (repo) => {
				const doc = await harness.snapshot(
					ObservationDoc,
					workerKey(workerId, repo),
					BACKGROUND_CONTEXT,
				);
				return doc
					? {
							repo,
							observedAt: doc.observedAt,
							ok: doc.ok,
							error: doc.error,
							jobs: doc.jobs,
						}
					: { repo, observedAt: 0, ok: false, error: null, jobs: [] };
			}),
		);
		return entries;
	}

	async function recordDispatch(
		doc: {
			dispatchKey: string;
			proposalId: string;
			workerId: string;
			repo: string;
			capability: string;
			params: Record<string, unknown>;
			actor: string;
			state: DispatchDocValue["state"];
			jobId: string | null;
			error: string | null;
			createdAt: number;
		},
	): Promise<void> {
		await harness.commit(async (tx) => {
			const value = await tx.doc(DispatchDoc, doc.dispatchKey, null);
			Object.assign(value, {
				dispatchKey: doc.dispatchKey,
				proposalId: doc.proposalId,
				workerId: doc.workerId,
				repo: doc.repo,
				capability: doc.capability,
				params: doc.params as JsonValue,
				actor: doc.actor,
				state: doc.state,
				jobId: doc.jobId,
				error: doc.error,
				createdAt: doc.createdAt,
				updatedAt: now(),
			} satisfies DispatchDocValue);
			const index = await tx.doc(DispatchIndexDoc);
			if (!index.keys.includes(doc.dispatchKey)) {
				index.keys = [...index.keys, doc.dispatchKey].slice(-MAX_RECENT_DISPATCHES);
			}
			return undefined;
		}, BACKGROUND_CONTEXT);
	}

	const runtime: ConsoleRuntime = {
		harness,
		wake: () => harness.wake(),
		resume: () => harness.resume(),
		closed: harness.closed,

		async createEnrollment(input) {
			const token = newToken("enr");
			const key = await hashToken(token);
			const createdAt = now();
			const expiresAt = createdAt + (input.ttlMs ?? config.enrollmentTtlMs);
			await harness.commit(async (tx) => {
				const doc = await tx.doc(EnrollmentDoc, key, null);
				doc.label = input.label;
				doc.createdAt = createdAt;
				doc.expiresAt = expiresAt;
				doc.usedAt = null;
				doc.workerId = null;
				return undefined;
			}, BACKGROUND_CONTEXT);
			return { token, expiresAt };
		},

		async registerWorker(input) {
			const enrollmentKey = await hashToken(input.enrollmentToken.trim());
			const enrollment = await harness.snapshot(
				EnrollmentDoc,
				enrollmentKey,
				BACKGROUND_CONTEXT,
			);
			if (!enrollment) {
				throw new WorkerRequestError("unknown enrollment token", 401);
			}
			if (enrollment.usedAt !== null) {
				throw new WorkerRequestError("enrollment token was already used", 409);
			}
			if (now() > enrollment.expiresAt) {
				throw new WorkerRequestError("enrollment token expired", 409);
			}
			if (input.repos.length === 0) {
				throw new WorkerRequestError("a worker must declare at least one repository", 400);
			}
			if (input.transport !== "inbound") {
				throw new WorkerRequestError(
					"outbound workers are not supported yet; register an inbound worker",
					400,
				);
			}

			const probe = new WorkerClient({
				fetch: options.fetch,
				baseUrl: input.baseUrl,
				secret: input.secret,
				timeoutMs: config.workerTimeoutMs,
			});
			let described: { name: string; version: string; capabilities: CapabilityDescriptor[] };
			try {
				described = await probe.describe();
			} catch (error) {
				throw new WorkerRequestError(
					`worker did not answer /api/capabilities: ${error instanceof Error ? error.message : String(error)}`,
					400,
				);
			}
			if (described.capabilities.length === 0) {
				throw new WorkerRequestError("worker declared no capabilities", 400);
			}

			await harness.commit(async (tx) => {
				const doc = await tx.doc(WorkerDoc, input.workerId, null);
				doc.workerId = input.workerId;
				doc.kind = input.kind;
				doc.version = described.version || "unknown";
				doc.transport = input.transport;
				doc.baseUrl = input.baseUrl.replace(/\/+$/, "");
				doc.repos = [...new Set(input.repos)];
				doc.capabilities = described.capabilities as unknown as JsonValue[];
				doc.createdAt = doc.createdAt || now();
				doc.updatedAt = now();

				const credential = await tx.doc(WorkerCredentialDoc, input.workerId, null);
				credential.secret = input.secret;

				const registryDoc = await tx.doc(RegistryDoc);
				if (!registryDoc.workerIds.includes(input.workerId)) {
					registryDoc.workerIds = [...registryDoc.workerIds, input.workerId];
				}

				const used = await tx.doc(EnrollmentDoc, enrollmentKey, null);
				used.usedAt = now();
				used.workerId = input.workerId;
				return undefined;
			}, BACKGROUND_CONTEXT);

			const worker = await readWorker(input.workerId);
			if (!worker) throw new WorkerRequestError("worker vanished after registration", 500);
			logger.info("Registered console worker", {
				workerId: input.workerId,
				kind: input.kind,
				capabilities: described.capabilities.length,
			});
			return toWorkerView(worker, []);
		},

		async listWorkers() {
			const registryDoc = await harness.snapshot(RegistryDoc, BACKGROUND_CONTEXT);
			const ids = registryDoc?.workerIds ?? [];
			const workers: WorkerView[] = [];
			for (const workerId of ids) {
				const worker = await readWorker(workerId);
				if (!worker) continue;
				const observations = await observationsFor(workerId);
				workers.push(
					toWorkerView(
						worker,
						observations.map(({ repo, observedAt, ok, error }) => ({
							repo,
							observedAt,
							ok,
							error,
						})),
					),
				);
			}
			return workers;
		},

		async propose(input) {
			const worker = await readWorker(input.workerId);
			if (!worker) {
				return { ok: false, status: 404, error: `unknown worker: ${input.workerId}` };
			}
			const capability = findCapability(capabilitiesFrom(worker.capabilities), input.capability);
			if (!capability) {
				return {
					ok: false,
					status: 400,
					error: `worker ${input.workerId} does not declare ${input.capability}`,
				};
			}
			const repo = typeof input.params.repo === "string" ? input.params.repo : "";
			if (!repo) {
				return { ok: false, status: 400, error: "params.repo is required" };
			}
			if (!repoAllowed(worker, repo)) {
				return {
					ok: false,
					status: 403,
					error: `worker ${input.workerId} is not registered for ${repo}`,
				};
			}
			const proposalId = proposalIdFor(input.proposalId, now());
			return {
				ok: true,
				proposal: {
					dispatchKey: `console:${proposalId}`,
					proposalId,
					workerId: input.workerId,
					repo,
					capability: input.capability,
					params: input.params,
					actor: input.actor,
					dangerous: capability.dangerous,
				},
			};
		},

		async submit(input) {
			const proposed = await runtime.propose(input);
			if (!proposed.ok) {
				return { status: proposed.status, body: { error: proposed.error } };
			}
			const proposal = proposed.proposal;
			const existing = await runtime.lookup(proposal.dispatchKey);
			if (existing?.state === "accepted") {
				return {
					status: 200,
					body: { ok: true, duplicate: true, dispatch: existing },
				};
			}
			if (proposal.dangerous && input.confirm !== true) {
				return {
					status: 409,
					body: {
						requiresConfirmation: true,
						proposal,
					},
				};
			}

			const createdAt = now();
			const notAfter = createdAt + config.dispatchDeadlineMs;
			await recordDispatch({
				dispatchKey: proposal.dispatchKey,
				proposalId: proposal.proposalId,
				workerId: proposal.workerId,
				repo: proposal.repo,
				capability: proposal.capability,
				params: proposal.params,
				actor: proposal.actor,
				state: "submitted",
				jobId: null,
				error: null,
				createdAt,
			});

			try {
				const { client } = await clientFor(proposal.workerId);
				const response = await client.dispatch({
					capability: proposal.capability,
					params: proposal.params,
					dispatchKey: proposal.dispatchKey,
					actor: proposal.actor,
					notAfter,
				});
				const accepted = response.ok && response.jobId !== null;
				await recordDispatch({
					dispatchKey: proposal.dispatchKey,
					proposalId: proposal.proposalId,
					workerId: proposal.workerId,
					repo: proposal.repo,
					capability: proposal.capability,
					params: proposal.params,
					actor: proposal.actor,
					state: accepted ? "accepted" : "rejected",
					jobId: response.jobId,
					error: accepted ? null : (response.error ?? response.ignored ?? "worker did not accept the command"),
					createdAt,
				});
				if (!accepted) {
					return {
						status: 400,
						body: {
							error: response.error ?? response.ignored ?? "worker did not accept the command",
							dispatch: await runtime.lookup(proposal.dispatchKey),
						},
					};
				}
				return {
					status: 202,
					body: { ok: true, dispatch: await runtime.lookup(proposal.dispatchKey) },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const permanent =
					error instanceof WorkerRequestError && error.status !== null && error.status < 500;
				await recordDispatch({
					dispatchKey: proposal.dispatchKey,
					proposalId: proposal.proposalId,
					workerId: proposal.workerId,
					repo: proposal.repo,
					capability: proposal.capability,
					params: proposal.params,
					actor: proposal.actor,
					state: permanent ? "rejected" : "submitted",
					jobId: null,
					error: message,
					createdAt,
				});
				return {
					status: 502,
					body: {
						error: `dispatch outcome unknown: ${message}`,
						dispatchKey: proposal.dispatchKey,
						dispatch: await runtime.lookup(proposal.dispatchKey),
					},
				};
			}
		},

		async lookup(dispatchKey) {
			const doc = await harness.snapshot(DispatchDoc, dispatchKey, BACKGROUND_CONTEXT);
			if (!doc) return null;
			if (doc.state === "accepted") return toDispatchView(doc);
			try {
				const { client } = await clientFor(doc.workerId);
				const detail = await client.jobByDispatchKey(dispatchKey);
				if (detail) {
					await recordDispatch({
						dispatchKey: doc.dispatchKey,
						proposalId: doc.proposalId,
						workerId: doc.workerId,
						repo: doc.repo,
						capability: doc.capability,
						params: doc.params as Record<string, unknown>,
						actor: doc.actor,
						state: "accepted",
						jobId: detail.job.id,
						error: null,
						createdAt: doc.createdAt,
					});
					const updated = await harness.snapshot(
						DispatchDoc,
						dispatchKey,
						BACKGROUND_CONTEXT,
					);
					return updated ? toDispatchView(updated) : null;
				}
			} catch {
				return toDispatchView(doc);
			}
			return toDispatchView(doc);
		},

		async state(stateOptions = {}) {
			const initial = await runtime.listWorkers();
			const jobs: StateJob[] = [];
			for (const worker of initial) {
				const observations = await observationsFor(worker.workerId);
				for (const observation of observations) {
					const stale = stateOptions.refresh === true &&
						now() - observation.observedAt > config.observationTtlMs;
					const current = stale
						? await refreshObservation(worker.workerId, observation.repo)
						: observation;
					for (const job of current.jobs) {
						const parsed = job as unknown as WorkerJobState;
						if (typeof parsed?.id !== "string") continue;
						jobs.push({
							workerId: worker.workerId,
							repo: observation.repo,
							observedAt: current.observedAt,
							job: parsed,
						});
					}
				}
			}
			jobs.sort((a, b) => b.job.createdAt - a.job.createdAt);
			const workers = stateOptions.refresh === true ? await runtime.listWorkers() : initial;

			const index = await harness.snapshot(DispatchIndexDoc, BACKGROUND_CONTEXT);
			const dispatches: StateDispatch[] = [];
			for (const key of [...(index?.keys ?? [])].reverse()) {
				const doc = await harness.snapshot(DispatchDoc, key, BACKGROUND_CONTEXT);
				if (doc) dispatches.push(toDispatchView(doc));
			}
			return { now: now(), workers, jobs, dispatches };
		},

		shutdown: () => harness.close(BACKGROUND_CONTEXT),
	};

	async function refreshObservation(
		workerId: string,
		repo: string,
	): Promise<{ repo: string; observedAt: number; ok: boolean; error: string | null; jobs: JsonValue[] }> {
		const observedAt = now();
		let ok = true;
		let error: string | null = null;
		let jobs: JsonValue[] = [];
		try {
			const { client } = await clientFor(workerId);
			jobs = (await client.listJobs(repo, MAX_OBSERVED_JOBS)) as unknown as JsonValue[];
		} catch (caught) {
			ok = false;
			error = caught instanceof Error ? caught.message : String(caught);
		}
		await harness.commit(async (tx) => {
			const doc = await tx.doc(ObservationDoc, workerKey(workerId, repo), null);
			doc.workerId = workerId;
			doc.repo = repo;
			doc.observedAt = observedAt;
			doc.ok = ok;
			doc.error = error;
			doc.jobs = jobs;
			return undefined;
		}, BACKGROUND_CONTEXT);
		return { repo, observedAt, ok, error, jobs };
	}

	return runtime;
}
