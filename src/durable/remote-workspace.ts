import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { AgentWorkspaceDoc } from "./agent-workspace-doc.ts";
import type { RemoteRunnerClient } from "./remote-runner.ts";
import type {
	Checkout,
	CheckoutRequest,
	CommitOptions,
	JobWorkspace,
	PushOptions,
	WorkspaceCreateOptions,
} from "./workspace.ts";

export interface RemoteWorkspaceOptions extends WorkspaceCreateOptions {
	client: RemoteRunnerClient;
	remoteUrl: string;
}

export class RemoteJobWorkspace implements JobWorkspace {
	readonly mode = "remote" as const;
	readonly id: string;
	repoPath: string | null = null;
	private readonly client: RemoteRunnerClient;
	private readonly input: WorkspaceCreateOptions["input"];
	private readonly attempt: number;
	private readonly remoteUrl: string;
	private readonly getGitToken: () => Promise<string>;

	constructor(options: RemoteWorkspaceOptions) {
		this.client = options.client;
		this.input = options.input;
		const repoHex = Array.from(new TextEncoder().encode(options.input.repo), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		this.id = `${repoHex}-${options.taskId}`;
		this.attempt = options.attempt;
		this.remoteUrl = options.remoteUrl;
		this.getGitToken = options.getGitToken;
	}

	async prepareCheckout(request: CheckoutRequest): Promise<Checkout> {
		const result = await this.client.createWorkspace({
			jobId: this.id,
			repo: this.input.repo,
			attempt: this.attempt,
			ref: request.ref,
			localBranch: request.localBranch ?? null,
			detached: request.detached ?? false,
			depth: request.depth ?? 30,
			token: await this.getGitToken(),
			remoteUrl: this.remoteUrl,
		});
		this.repoPath = result.repoPath;
		return { repoDir: result.repoPath, baseSha: result.baseSha };
	}

	async headCommit(): Promise<string> {
		return (await this.client.head(this.id)).sha;
	}

	async resetSoftTo(sha: string): Promise<void> {
		await this.client.resetSoftTo(this.id, sha);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.client.write(
			this.id,
			path,
			typeof content === "string" ? content : new TextDecoder().decode(content),
		);
	}

	async readTextFile(path: string): Promise<string | null> {
		return (await this.client.read(this.id, path)).content;
	}

	async removePath(path: string): Promise<void> {
		await this.client.remove(this.id, path);
	}

	async listChangedPaths(): Promise<string[]> {
		return (await this.client.changed(this.id)).paths;
	}

	async revertWorkflowChanges(paths: string[]): Promise<{ reverted: string[] }> {
		return this.client.revertWorkflows(this.id, paths);
	}

	async commitAll(options: CommitOptions): Promise<string | null> {
		return (await this.client.commit(this.id, options)).sha;
	}

	async pushBranch(options: PushOptions): Promise<void> {
		await this.client.push(this.id, options, await this.getGitToken());
	}

	async resetConfig(): Promise<void> {
		await this.client.resetConfig(this.id, this.input.repo);
	}

	async initConversation(tx: Tx, conversationId: ConversationId): Promise<void> {
		const doc = await tx.doc(AgentWorkspaceDoc, conversationId);
		doc.workspaceId = this.id;
	}

	async cleanup(): Promise<void> {
		await this.client.cleanup(this.id);
	}
}
