import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { isSafeRepositoryPath } from "../diff.ts";
import {
	commitAll,
	headCommit,
	listChangedPaths,
	prepareRepository,
	pushBranch,
	repositoryUrl,
	resetSoftTo,
	resetLocalGitConfig,
	revertWorkflowChanges,
	withGitAskpass,
} from "../git.ts";
import type {
	Checkout,
	CheckoutRequest,
	CommitOptions,
	JobWorkspace,
	PushOptions,
	WorkspaceCreateOptions,
} from "./workspace.ts";

interface CheckoutMarker {
	attempt: number;
	ref: string;
	localBranch: string | null;
	baseSha: string;
}

function readCheckoutMarker(workspaceDir: string): CheckoutMarker | null {
	try {
		const parsed = JSON.parse(
			readFileSync(join(workspaceDir, "checkout.json"), "utf8"),
		) as CheckoutMarker;
		if (
			typeof parsed.attempt === "number" &&
			typeof parsed.ref === "string" &&
			typeof parsed.baseSha === "string" &&
			(parsed.localBranch === null || typeof parsed.localBranch === "string")
		) {
			return parsed;
		}
	} catch {
		// Missing or invalid marker: prepare a fresh checkout.
	}
	return null;
}

export interface LocalWorkspaceOptions extends WorkspaceCreateOptions {
	remoteUrlForRepo?: (repo: string) => string;
}

export class LocalJobWorkspace implements JobWorkspace {
	readonly mode = "local" as const;
	readonly id: string;
	repoPath: string | null = null;
	private readonly fullName: string;
	private readonly attempt: number;
	private readonly signal: AbortSignal;
	private readonly getGitToken: () => Promise<string>;
	private readonly remoteUrl: string;
	private readonly workspaceDir: string;
	private readonly repoDir: string;

	constructor(options: LocalWorkspaceOptions) {
		this.fullName = options.input.repo;
		this.id = String(options.taskId);
		this.attempt = options.attempt;
		this.signal = options.signal;
		this.getGitToken = options.getGitToken;
		this.remoteUrl =
			options.remoteUrlForRepo?.(options.input.repo) ??
			repositoryUrl(options.input.repo);
		this.workspaceDir = join(options.config.workspaceRoot, this.id);
		this.repoDir = join(this.workspaceDir, "repo");
	}

	async prepareCheckout(request: CheckoutRequest): Promise<Checkout> {
		const marker = readCheckoutMarker(this.workspaceDir);
		const localBranch = request.localBranch ?? null;
		const reusable =
			marker !== null &&
			marker.attempt === this.attempt &&
			marker.ref === request.ref &&
			marker.localBranch === localBranch &&
			existsSync(join(this.repoDir, ".git"));
		if (reusable) {
			this.repoPath = this.repoDir;
			return { repoDir: this.repoDir, baseSha: marker.baseSha };
		}

		rmSync(this.repoDir, { recursive: true, force: true });
		mkdirSync(this.workspaceDir, { recursive: true });
		await withGitAskpass(async (askpassPath) => {
			await prepareRepository({
				dir: this.repoDir,
				fullName: this.fullName,
				ref: request.ref,
				...(localBranch !== null ? { localBranch } : {}),
				detached: request.detached ?? false,
				depth: request.depth ?? 30,
				auth: { token: await this.getGitToken(), askpassPath },
				signal: this.signal,
				remoteUrl: this.remoteUrl,
			});
		});
		const baseSha = await headCommit(this.repoDir, this.signal);
		writeFileSync(
			join(this.workspaceDir, "checkout.json"),
			JSON.stringify(
				{
					attempt: this.attempt,
					ref: request.ref,
					localBranch,
					baseSha,
				} satisfies CheckoutMarker,
				null,
				2,
			),
			"utf8",
		);
		this.repoPath = this.repoDir;
		return { repoDir: this.repoDir, baseSha };
	}

	async headCommit(): Promise<string> {
		return headCommit(this.repoDir, this.signal);
	}

	async resetSoftTo(sha: string): Promise<void> {
		await resetSoftTo(this.repoDir, sha, this.signal);
	}

	private resolvePath(path: string): string {
		if (!isSafeRepositoryPath(path)) {
			throw new Error(`Unsafe workspace path: ${path}`);
		}
		const absolute = resolve(this.repoDir, path);
		const root = resolve(this.repoDir) + sep;
		if (!absolute.startsWith(root)) {
			throw new Error(`Workspace path escapes the checkout: ${path}`);
		}
		return absolute;
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const absolute = this.resolvePath(path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	}

	async readTextFile(path: string): Promise<string | null> {
		const absolute = this.resolvePath(path);
		try {
			return readFileSync(absolute, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async removePath(path: string): Promise<void> {
		rmSync(this.resolvePath(path), { recursive: true, force: true });
	}

	async listChangedPaths(): Promise<string[]> {
		return listChangedPaths(this.repoDir, this.signal);
	}

	async revertWorkflowChanges(paths: string[]): Promise<{ reverted: string[] }> {
		return revertWorkflowChanges(this.repoDir, paths, this.signal);
	}

	async commitAll(options: CommitOptions): Promise<string | null> {
		return commitAll({
			cwd: this.repoDir,
			message: options.message,
			name: options.name,
			email: options.email,
			signal: this.signal,
		});
	}

	async pushBranch(options: PushOptions): Promise<void> {
		await withGitAskpass(async (askpassPath) => {
			await pushBranch({
				cwd: this.repoDir,
				branch: options.branch,
				force: options.force,
				remoteUrl: this.remoteUrl,
				auth: { token: await this.getGitToken(), askpassPath },
				signal: this.signal,
			});
		});
	}

	async resetConfig(): Promise<void> {
		resetLocalGitConfig(this.repoDir, this.fullName);
	}

	async initConversation(_tx: Tx, _conversationId: ConversationId): Promise<void> {
		// Local tools use the conversation cwd; no extra conversation state is needed.
	}

	async cleanup(): Promise<void> {
		rmSync(this.workspaceDir, { recursive: true, force: true });
	}
}

export function createLocalWorkspace(options: LocalWorkspaceOptions): JobWorkspace {
	return new LocalJobWorkspace(options);
}
