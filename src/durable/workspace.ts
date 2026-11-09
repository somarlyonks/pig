import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import type { AppConfig } from "../config.ts";
import type { JobTaskInput } from "./task-types.ts";

export interface CheckoutRequest {
	ref: string;
	localBranch?: string | null;
	detached?: boolean;
	depth?: number;
}

export interface Checkout {
	repoDir: string;
	baseSha: string;
}

export interface CommitOptions {
	message: string;
	name: string;
	email: string;
}

export interface PushOptions {
	branch: string;
	force: boolean;
}

export interface JobWorkspace {
	readonly mode: "local" | "remote";
	readonly id: string;
	readonly repoPath: string | null;
	prepareCheckout(request: CheckoutRequest): Promise<Checkout>;
	headCommit(): Promise<string>;
	resetSoftTo(sha: string): Promise<void>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	readTextFile(path: string): Promise<string | null>;
	removePath(path: string): Promise<void>;
	listChangedPaths(): Promise<string[]>;
	revertWorkflowChanges(paths: string[]): Promise<{ reverted: string[] }>;
	commitAll(options: CommitOptions): Promise<string | null>;
	pushBranch(options: PushOptions): Promise<void>;
	resetConfig(): Promise<void>;
	initConversation(tx: Tx, conversationId: ConversationId): Promise<void>;
	cleanup(): Promise<void>;
}

export interface WorkspaceCreateOptions {
	config: AppConfig;
	input: JobTaskInput;
	taskId: TaskId;
	attempt: number;
	signal: AbortSignal;
	getGitToken(): Promise<string>;
}

export type WorkspaceFactory = (
	options: WorkspaceCreateOptions,
) => JobWorkspace | Promise<JobWorkspace>;
