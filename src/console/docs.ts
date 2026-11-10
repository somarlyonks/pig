import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

export type ConsoleTransport = "inbound" | "outbound";

/** Every worker the console knows about, so the registry survives a restart. */
export interface RegistryDocValue {
	[key: string]: JsonValue;
	workerIds: string[];
}

export const RegistryDoc = defineDoc<RegistryDocValue>({
	kind: "console.registry",
	version: 1,
	scope: "session",
	initial: () => ({ workerIds: [] }),
	checkpointWhen: () => false,
});

export interface WorkerDocValue {
	[key: string]: JsonValue;
	workerId: string;
	kind: string;
	version: string;
	transport: ConsoleTransport;
	baseUrl: string;
	repos: string[];
	capabilities: JsonValue[];
	sessionState: "unknown" | "active" | "stopped";
	sessionSeenAt: number;
	createdAt: number;
	updatedAt: number;
}

export const WorkerDoc = defineDocFamily<WorkerDocValue, null>({
	kind: "console.worker",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({
		workerId: "",
		kind: "",
		version: "",
		transport: "inbound",
		baseUrl: "",
		repos: [],
		capabilities: [],
		sessionState: "unknown",
		sessionSeenAt: 0,
		createdAt: 0,
		updatedAt: 0,
	}),
	checkpointWhen: () => false,
});

/** The credential the console uses to call a worker's own API. */
export interface WorkerCredentialDocValue {
	[key: string]: JsonValue;
	secret: string;
}

export const WorkerCredentialDoc = defineDocFamily<WorkerCredentialDocValue, null>({
	kind: "console.credential",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ secret: "" }),
	checkpointWhen: () => false,
});

export interface EnrollmentDocValue {
	[key: string]: JsonValue;
	label: string;
	createdAt: number;
	expiresAt: number;
	usedAt: number | null;
	workerId: string | null;
}

export const EnrollmentDoc = defineDocFamily<EnrollmentDocValue, null>({
	kind: "console.enrollment",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({
		label: "",
		createdAt: 0,
		expiresAt: 0,
		usedAt: null,
		workerId: null,
	}),
	checkpointWhen: () => false,
});

export type DispatchState = "submitted" | "accepted" | "rejected";

/** Monotonic console-local sequence, so a poller can resume from a cursor. */
export interface CounterDocValue {
	[key: string]: JsonValue;
	seq: number;
}

export const CounterDoc = defineDoc<CounterDocValue>({
	kind: "console.counter",
	version: 1,
	scope: "session",
	initial: () => ({ seq: 0 }),
	checkpointWhen: () => false,
});

/** Hash of the token a worker uses to poll the console. Never stored in clear. */
export interface SessionTokenDocValue {
	[key: string]: JsonValue;
	hash: string;
	issuedAt: number;
}

export const SessionTokenDoc = defineDocFamily<SessionTokenDocValue, null>({
	kind: "console.session-token",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ hash: "", issuedAt: 0 }),
	checkpointWhen: () => false,
});

export interface DispatchDocValue {
	[key: string]: JsonValue;
	seq: number;
	dispatchKey: string;
	proposalId: string;
	workerId: string;
	repo: string;
	capability: string;
	params: JsonValue;
	actor: string;
	state: DispatchState;
	jobId: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export const DispatchDoc = defineDocFamily<DispatchDocValue, null>({
	kind: "console.dispatch",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({
		seq: 0,
		dispatchKey: "",
		proposalId: "",
		workerId: "",
		repo: "",
		capability: "",
		params: {},
		actor: "",
		state: "submitted",
		jobId: null,
		error: null,
		createdAt: 0,
		updatedAt: 0,
	}),
	checkpointWhen: () => false,
});

/** Recent dispatch keys, newest last, so the board can list them without scanning. */
export interface DispatchIndexDocValue {
	[key: string]: JsonValue;
	keys: string[];
}

export const DispatchIndexDoc = defineDoc<DispatchIndexDocValue>({
	kind: "console.dispatch-index",
	version: 1,
	scope: "session",
	initial: () => ({ keys: [] }),
	checkpointWhen: () => false,
});

export interface ObservationDocValue {
	[key: string]: JsonValue;
	workerId: string;
	repo: string;
	observedAt: number;
	ok: boolean;
	error: string | null;
	jobs: JsonValue[];
}

export const ObservationDoc = defineDocFamily<ObservationDocValue, null>({
	kind: "console.observation",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({
		workerId: "",
		repo: "",
		observedAt: 0,
		ok: false,
		error: null,
		jobs: [],
	}),
	checkpointWhen: () => false,
});
