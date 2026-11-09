import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { isSafeRepositoryPath } from "../diff.ts";
import {
	commitAll,
	headCommit,
	listChangedPaths,
	prepareRepository,
	pushBranch,
	repositoryUrl,
	resetLocalGitConfig,
	resetSoftTo,
	revertWorkflowChanges,
	withGitAskpass,
} from "../git.ts";
import { buildShellEnvironment } from "../shell-env.ts";

export interface RunnerConfig {
	port: number;
	token: string;
	workspaceRoot: string;
	remoteUrlForRepo?: (repo: string) => string;
}

export interface RunningRunner {
	server: Server;
	port: number;
	close(): Promise<void>;
}

interface WorkspaceMarker {
	jobId: string;
	attempt: number;
	ref: string;
	localBranch: string | null;
	baseSha: string;
	remoteUrl: string;
}

class RunnerHttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	response.end(text);
}

async function readJson(request: IncomingMessage, limit = 5 * 1024 * 1024): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > limit) {
			throw new RunnerHttpError(413, "Request body too large");
		}
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new RunnerHttpError(400, "JSON object required");
		}
		return value as Record<string, unknown>;
	} catch (error) {
		if (error instanceof RunnerHttpError) throw error;
		throw new RunnerHttpError(400, "Invalid JSON");
	}
}

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value === "") {
		throw new RunnerHttpError(400, `${key} must be a non-empty string`);
	}
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | null {
	const value = body[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new RunnerHttpError(400, `${key} must be a string`);
	}
	return value;
}

function requireNumber(body: Record<string, unknown>, key: string, fallback?: number): number {
	const value = body[key];
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new RunnerHttpError(400, `${key} must be a number`);
	}
	return value;
}

function validateWorkspaceId(id: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) {
		throw new RunnerHttpError(400, "Invalid workspace id");
	}
	return id;
}

function resolveInside(root: string, path: string): string {
	if (!isSafeRepositoryPath(path)) {
		throw new RunnerHttpError(400, `Unsafe workspace path: ${path}`);
	}
	const absolute = resolve(root, path);
	if (!absolute.startsWith(resolve(root) + sep)) {
		throw new RunnerHttpError(400, `Workspace path escapes the checkout: ${path}`);
	}
	return absolute;
}

function readMarker(workspaceDir: string): WorkspaceMarker | null {
	try {
		const value = JSON.parse(
			readFileSync(join(workspaceDir, "checkout.json"), "utf8"),
		) as WorkspaceMarker;
		if (
			typeof value.attempt === "number" &&
			typeof value.ref === "string" &&
			typeof value.baseSha === "string" &&
			typeof value.remoteUrl === "string" &&
			(value.localBranch === null || typeof value.localBranch === "string")
		) {
			return value;
		}
	} catch {
		// Missing or invalid marker.
	}
	return null;
}

function workspacePaths(config: RunnerConfig, id: string): { workspaceDir: string; repoDir: string } {
	validateWorkspaceId(id);
	const workspaceDir = join(config.workspaceRoot, id);
	return { workspaceDir, repoDir: join(workspaceDir, "repo") };
}

async function createWorkspace(
	config: RunnerConfig,
	body: Record<string, unknown>,
): Promise<{ workspaceId: string; repoPath: string; baseSha: string }> {
	const jobId = validateWorkspaceId(requireString(body, "jobId"));
	const repo = requireString(body, "repo");
	const ref = requireString(body, "ref");
	const token = requireString(body, "token");
	const attempt = requireNumber(body, "attempt");
	const localBranch = optionalString(body, "localBranch");
	const detached = body.detached === true;
	const depth = requireNumber(body, "depth", 30);
	const remoteUrl =
		optionalString(body, "remoteUrl") ??
		config.remoteUrlForRepo?.(repo) ??
		repositoryUrl(repo);
	const { workspaceDir, repoDir } = workspacePaths(config, jobId);
	const marker = readMarker(workspaceDir);
	const reusable =
		marker !== null &&
		marker.attempt === attempt &&
		marker.ref === ref &&
		marker.localBranch === localBranch &&
		existsSync(join(repoDir, ".git"));
	if (reusable) {
		return { workspaceId: jobId, repoPath: repoDir, baseSha: marker.baseSha };
	}

	rmSync(repoDir, { recursive: true, force: true });
	mkdirSync(workspaceDir, { recursive: true });
	await withGitAskpass(async (askpassPath) => {
		await prepareRepository({
			dir: repoDir,
			fullName: repo,
			ref,
			...(localBranch !== null ? { localBranch } : {}),
			detached,
			depth,
			auth: { token, askpassPath },
			remoteUrl,
		});
	});
	const baseSha = await headCommit(repoDir);
	writeFileSync(
		join(workspaceDir, "checkout.json"),
		JSON.stringify(
			{ jobId, attempt, ref, localBranch, baseSha, remoteUrl } satisfies WorkspaceMarker,
			null,
			2,
		),
		"utf8",
	);
	return { workspaceId: jobId, repoPath: repoDir, baseSha };
}

function shellEnv(): NodeJS.ProcessEnv {
	return { ...buildShellEnvironment(), PAGER: "cat" };
}

interface BashResult {
	output: string;
	exitCode: number;
	truncated: boolean;
}

function runBash(repoDir: string, command: string, timeoutSeconds: number): Promise<BashResult> {
	return new Promise((resolvePromise) => {
		const limit = 200 * 1024;
		let output = "";
		let truncated = false;
		let killed = false;
		const child = spawn("/bin/bash", ["-lc", command], {
			cwd: repoDir,
			env: shellEnv(),
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const append = (chunk: Buffer) => {
			if (truncated) return;
			output += chunk.toString("utf8");
			if (Buffer.byteLength(output, "utf8") > limit) {
				output = output.slice(0, limit);
				truncated = true;
			}
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		const kill = () => {
			if (killed || !child.pid) return;
			killed = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(kill, Math.max(1, timeoutSeconds) * 1000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({
				output,
				exitCode: killed ? 124 : (code ?? 1),
				truncated,
			});
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolvePromise({ output: `${output}\n${error.message}`, exitCode: 1, truncated });
		});
	});
}

export function startRunnerServer(config: RunnerConfig): Promise<RunningRunner> {
	const server = createServer((request, response) => {
		void handle(request, response).catch((error) => {
			if (error instanceof RunnerHttpError) {
				sendJson(response, error.status, { error: error.message });
			} else {
				sendJson(response, 500, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://runner");
		if (request.method === "GET" && url.pathname === "/healthz") {
			sendJson(response, 200, { ok: true });
			return;
		}
		if (request.headers.authorization !== `Bearer ${config.token}`) {
			throw new RunnerHttpError(401, "Unauthorized");
		}
		if (request.method !== "POST") {
			throw new RunnerHttpError(405, "Method not allowed");
		}
		if (url.pathname === "/workspaces") {
			const body = await readJson(request);
			sendJson(response, 200, await createWorkspace(config, body));
			return;
		}
		const match = /^\/workspaces\/([^/]+)\/([a-z-]+)$/.exec(url.pathname);
		if (!match?.[1] || !match[2]) {
			throw new RunnerHttpError(404, "Not found");
		}
		const id = validateWorkspaceId(decodeURIComponent(match[1]));
		const operation = match[2];
		const { workspaceDir, repoDir } = workspacePaths(config, id);
		if (!existsSync(join(repoDir, ".git"))) {
			throw new RunnerHttpError(404, "Workspace not found");
		}
		const marker = readMarker(workspaceDir);
		const remoteUrl = marker?.remoteUrl ?? repositoryUrl("unknown/unknown");
		const body = await readJson(request);

		switch (operation) {
			case "read": {
				const path = requireString(body, "path");
				try {
					const content = readFileSync(resolveInside(repoDir, path), "utf8");
					sendJson(response, 200, {
						content: content.length > 512 * 1024 ? content.slice(0, 512 * 1024) : content,
					});
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						sendJson(response, 200, { content: null });
						return;
					}
					throw error;
				}
				return;
			}
			case "write": {
				const path = requireString(body, "path");
				const content = body.content;
				if (typeof content !== "string") {
					throw new RunnerHttpError(400, "content must be a string");
				}
				const absolute = resolveInside(repoDir, path);
				mkdirSync(dirname(absolute), { recursive: true });
				writeFileSync(absolute, content, "utf8");
				sendJson(response, 200, { ok: true });
				return;
			}
			case "edit": {
				const path = requireString(body, "path");
				const edits = body.edits;
				if (!Array.isArray(edits)) throw new RunnerHttpError(400, "edits must be an array");
				const absolute = resolveInside(repoDir, path);
				let content = readFileSync(absolute, "utf8");
				for (const raw of edits) {
					if (typeof raw !== "object" || raw === null) {
						throw new RunnerHttpError(400, "Invalid edit");
					}
					const edit = raw as { oldText?: unknown; newText?: unknown };
					if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
						throw new RunnerHttpError(400, "Invalid edit");
					}
					const index = content.indexOf(edit.oldText);
					if (index === -1 || content.indexOf(edit.oldText, index + 1) !== -1) {
						throw new RunnerHttpError(
							400,
							`Edit target must occur exactly once in ${path}`,
						);
					}
					content = content.slice(0, index) + edit.newText + content.slice(index + edit.oldText.length);
				}
				writeFileSync(absolute, content, "utf8");
				sendJson(response, 200, { ok: true });
				return;
			}
			case "list": {
				const path = optionalString(body, "path") ?? ".";
				const directory = path === "." ? repoDir : resolveInside(repoDir, path);
				const entries = readdirSync(directory, { withFileTypes: true })
					.slice(0, 1000)
					.map((entry) => {
						const absolute = join(directory, entry.name);
						let kind: "file" | "directory" | "symlink" = "file";
						try {
							const stats = statSync(absolute);
							kind = stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "file";
						} catch {
							kind = "symlink";
						}
						return { name: entry.name, kind };
					})
					.sort((left, right) => left.name.localeCompare(right.name));
				sendJson(response, 200, { entries });
				return;
			}
			case "bash": {
				const command = requireString(body, "command");
				const timeout = requireNumber(body, "timeout", 120);
				sendJson(response, 200, await runBash(repoDir, command, timeout));
				return;
			}
			case "head": {
				sendJson(response, 200, { sha: await headCommit(repoDir) });
				return;
			}
			case "changed": {
				sendJson(response, 200, { paths: await listChangedPaths(repoDir) });
				return;
			}
			case "revert-workflows": {
				const paths = body.paths;
				if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
					throw new RunnerHttpError(400, "paths must be a string array");
				}
				sendJson(response, 200, await revertWorkflowChanges(repoDir, paths as string[]));
				return;
			}
			case "commit": {
				const sha = await commitAll({
					cwd: repoDir,
					message: requireString(body, "message"),
					name: requireString(body, "name"),
					email: requireString(body, "email"),
				});
				sendJson(response, 200, { sha });
				return;
			}
			case "push": {
				const token = requireString(body, "token");
				const branch = requireString(body, "branch");
				const force = body.force === true;
				await withGitAskpass(async (askpassPath) => {
					await pushBranch({
						cwd: repoDir,
						branch,
						force,
						remoteUrl,
						auth: { token, askpassPath },
					});
				});
				sendJson(response, 200, { ok: true });
				return;
			}
			case "reset-config": {
				resetLocalGitConfig(repoDir, requireString(body, "repo"));
				sendJson(response, 200, { ok: true });
				return;
			}
			case "reset-soft": {
				await resetSoftTo(repoDir, requireString(body, "sha"));
				sendJson(response, 200, { ok: true });
				return;
			}
			case "remove": {
				rmSync(resolveInside(repoDir, requireString(body, "path")), {
					recursive: true,
					force: true,
				});
				sendJson(response, 200, { ok: true });
				return;
			}
			case "cleanup": {
				rmSync(workspaceDir, { recursive: true, force: true });
				sendJson(response, 200, { ok: true });
				return;
			}
			default:
				throw new RunnerHttpError(404, "Unknown operation");
		}
	}

	return new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(config.port, "0.0.0.0", () => {
			server.off("error", reject);
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : config.port;
			resolvePromise({
				server,
				port,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
						server.closeIdleConnections();
					}),
			});
		});
	});
}
