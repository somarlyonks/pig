import type { CheckoutRequest, CommitOptions, PushOptions } from "./workspace.ts";

export interface RemoteRunnerConfig {
	baseUrl: string;
	token: string;
}

export interface RunnerWorkspace {
	workspaceId: string;
	repoPath: string;
	baseSha: string;
}

export interface RunnerEntry {
	name: string;
	kind: "file" | "directory" | "symlink";
}

export interface RunnerBashResult {
	output: string;
	exitCode: number;
	truncated: boolean;
}

export class RemoteRunnerError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "RemoteRunnerError";
		this.status = status;
	}
}

interface CreateWorkspaceInput extends CheckoutRequest {
	jobId: string;
	repo: string;
	attempt: number;
	token: string;
	remoteUrl: string;
}

export class RemoteRunnerClient {
	private readonly baseUrl: string;
	private readonly token: string;

	constructor(config: RemoteRunnerConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.token = config.token;
	}

	private async call<T>(path: string, body: unknown): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify(body),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new RemoteRunnerError(
				`Runner ${path} failed (${response.status}): ${text.slice(0, 2000)}`,
				response.status,
			);
		}
		return (text === "" ? undefined : JSON.parse(text)) as T;
	}

	createWorkspace(input: CreateWorkspaceInput): Promise<RunnerWorkspace> {
		return this.call<RunnerWorkspace>("/workspaces", input);
	}

	read(workspaceId: string, path: string): Promise<{ content: string | null }> {
		return this.call(`/workspaces/${workspaceId}/read`, { path });
	}

	write(workspaceId: string, path: string, content: string): Promise<unknown> {
		return this.call(`/workspaces/${workspaceId}/write`, { path, content });
	}

	edit(
		workspaceId: string,
		path: string,
		edits: { oldText: string; newText: string }[],
	): Promise<unknown> {
		return this.call(`/workspaces/${workspaceId}/edit`, { path, edits });
	}

	list(workspaceId: string, path: string): Promise<{ entries: RunnerEntry[] }> {
		return this.call(`/workspaces/${workspaceId}/list`, { path });
	}

	bash(workspaceId: string, command: string, timeout?: number): Promise<RunnerBashResult> {
		return this.call(`/workspaces/${workspaceId}/bash`, { command, timeout });
	}

	head(workspaceId: string): Promise<{ sha: string }> {
		return this.call(`/workspaces/${workspaceId}/head`, {});
	}

	resetSoftTo(workspaceId: string, sha: string): Promise<unknown> {
		return this.call(`/workspaces/${workspaceId}/reset-soft`, { sha });
	}

	changed(workspaceId: string): Promise<{ paths: string[] }> {
		return this.call(`/workspaces/${workspaceId}/changed`, {});
	}

	revertWorkflows(workspaceId: string, paths: string[]): Promise<{ reverted: string[] }> {
		return this.call(`/workspaces/${workspaceId}/revert-workflows`, { paths });
	}

	commit(workspaceId: string, options: CommitOptions): Promise<{ sha: string | null }> {
		return this.call(`/workspaces/${workspaceId}/commit`, options);
	}

	push(workspaceId: string, options: PushOptions, token: string): Promise<unknown> {
		return this.call(`/workspaces/${workspaceId}/push`, { ...options, token });
	}

	resetConfig(workspaceId: string, repo: string): Promise<unknown> {
		return this.call(`/workspaces/${workspaceId}/reset-config`, { repo });
	}

	remove(workspaceId: string, path: string): Promise<unknown> {
		return this.call(`/workspaces/${workspaceId}/remove`, { path });
	}

	cleanup(workspaceId: string): Promise<unknown> {
		return this.call(`/workspaces/${workspaceId}/cleanup`, {});
	}
}
