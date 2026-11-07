import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
	readonly stderr: string;

	constructor(message: string, stderr = "") {
		super(message);
		this.name = "GitError";
		this.stderr = stderr;
	}
}

export interface GitAuth {
	token: string;
	askpassPath: string;
}

export interface GitRunOptions {
	cwd: string;
	auth?: GitAuth;
	signal?: AbortSignal | undefined;
	timeoutMs?: number;
	allowFailure?: boolean;
}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

const GIT_ENV_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"SYSTEMROOT",
	"COMSPEC",
	"PATHEXT",
];

function gitEnvironment(auth: GitAuth | undefined): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of GIT_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GIT_CONFIG_NOSYSTEM = "1";
	environment.GIT_CONFIG_GLOBAL = "/dev/null";
	environment.GIT_PAGER = "cat";
	if (auth) {
		environment.GIT_ASKPASS = auth.askpassPath;
		environment.PIG_GIT_TOKEN = auth.token;
		environment.GCM_INTERACTIVE = "never";
	}
	return environment;
}

export async function runGit(args: string[], options: GitRunOptions): Promise<GitResult> {
	try {
		const result = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args], {
			cwd: options.cwd,
			env: gitEnvironment(options.auth),
			timeout: options.timeoutMs ?? 10 * 60 * 1000,
			maxBuffer: 32 * 1024 * 1024,
			...(options.signal ? { signal: options.signal } : {}),
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const candidate = error as {
			code?: number | string;
			stderr?: string;
			message?: string;
			signal?: string;
		};
		const stderr = candidate.stderr ?? "";
		const result: GitResult = {
			code: typeof candidate.code === "number" ? candidate.code : 1,
			stdout: "",
			stderr,
		};
		if (options.allowFailure) {
			return result;
		}
		const detail = stderr.trim() || candidate.message || "unknown git failure";
		throw new GitError(
			`git ${args[0] ?? "command"} failed: ${detail.slice(0, 5000)}`,
			stderr,
		);
	}
}

export async function withGitAskpass<T>(
	operation: (askpassPath: string) => Promise<T>,
): Promise<T> {
	const directory = mkdtempSync(join(tmpdir(), "pig-askpass-"));
	const askpassPath = join(directory, `${randomUUID()}.sh`);
	writeFileSync(
		askpassPath,
		`#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' "x-access-token" ;;
  *) printf '%s\\n' "$PIG_GIT_TOKEN" ;;
esac
`,
		{ mode: 0o700 },
	);
	try {
		return await operation(askpassPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export function createWorkspace(workspaceRoot: string, jobId: string): string {
	const path = join(workspaceRoot, jobId);
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path, { recursive: true });
	return path;
}

export function removeWorkspace(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

export function assertSafeGitRef(ref: string): void {
	if (
		ref.length === 0 ||
		ref.startsWith("-") ||
		ref.includes("..") ||
		ref.includes("@{") ||
		ref.includes("\\") ||
		ref.includes(" ") ||
		/[\u0000-\u001f\u007f~^:?*[\]]/.test(ref)
	) {
		throw new Error(`Unsafe git reference: ${ref}`);
	}
}

function repositoryUrl(fullName: string): string {
	return `https://github.com/${fullName}.git`;
}

function addLocalExclude(repoDir: string): void {
	const excludePath = join(repoDir, ".git", "info", "exclude");
	mkdirSync(dirname(excludePath), { recursive: true });
	const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	if (!current.includes(".pig/")) {
		appendFileSync(excludePath, `${current.endsWith("\n") || current === "" ? "" : "\n"}.pig/\n`);
	}
}

export interface PrepareRepositoryOptions {
	dir: string;
	fullName: string;
	ref: string;
	auth: GitAuth;
	signal?: AbortSignal;
	detached?: boolean;
	localBranch?: string;
	depth?: number;
}

export async function prepareRepository(options: PrepareRepositoryOptions): Promise<void> {
	assertSafeGitRef(options.ref);
	if (!options.detached) {
		if (!options.localBranch) {
			throw new Error("localBranch is required when checking out a branch");
		}
		assertSafeGitRef(options.localBranch);
	}
	mkdirSync(options.dir, { recursive: true });
	await runGit(["init", "-q"], { cwd: options.dir, signal: options.signal });
	await runGit(["remote", "add", "origin", repositoryUrl(options.fullName)], {
		cwd: options.dir,
		signal: options.signal,
	});
	await runGit(
		["fetch", "--no-tags", "--depth", String(options.depth ?? 30), "origin", options.ref],
		{ cwd: options.dir, auth: options.auth, signal: options.signal },
	);
	if (options.detached) {
		await runGit(["checkout", "-q", "--detach", "FETCH_HEAD"], {
			cwd: options.dir,
			signal: options.signal,
		});
	} else {
		await runGit(["checkout", "-q", "-B", options.localBranch!, "FETCH_HEAD"], {
			cwd: options.dir,
			signal: options.signal,
		});
	}
	addLocalExclude(options.dir);
}

export function resetLocalGitConfig(cwd: string, fullName: string): void {
	const configPath = join(cwd, ".git", "config");
	writeFileSync(
		configPath,
		`[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
[remote "origin"]
	url = ${repositoryUrl(fullName)}
	fetch = +refs/heads/*:refs/remotes/origin/*
`,
	);
}

export async function listChangedPaths(
	cwd: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const tracked = await runGit(["diff", "--name-only", "-z", "HEAD"], { cwd, signal });
	const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], {
		cwd,
		signal,
	});
	const paths = `${tracked.stdout}\0${untracked.stdout}`
		.split("\0")
		.filter((path) => path.length > 0);
	return [...new Set(paths)].sort();
}

export interface WorkflowGuardResult {
	reverted: string[];
}

export async function revertWorkflowChanges(
	cwd: string,
	changedPaths: string[],
	signal?: AbortSignal,
): Promise<WorkflowGuardResult> {
	const reverted: string[] = [];
	const root = resolve(cwd);
	for (const path of changedPaths) {
		if (!path.startsWith(".github/workflows/")) {
			continue;
		}
		const existsAtHead = await runGit(["cat-file", "-e", `HEAD:${path}`], {
			cwd,
			signal,
			allowFailure: true,
		});
		if (existsAtHead.code === 0) {
			await runGit(["checkout", "-q", "HEAD", "--", path], { cwd, signal });
		} else {
			await runGit(["reset", "-q", "HEAD", "--", path], {
				cwd,
				signal,
				allowFailure: true,
			});
			const absolute = resolve(cwd, path);
			if (absolute.startsWith(`${root}/`) && existsSync(absolute)) {
				unlinkSync(absolute);
			}
		}
		reverted.push(path);
	}
	return { reverted };
}

export interface CommitOptions {
	cwd: string;
	message: string;
	name: string;
	email: string;
	signal?: AbortSignal;
}

export async function headCommit(cwd: string, signal?: AbortSignal | undefined): Promise<string> {
	const result = await runGit(["rev-parse", "HEAD"], { cwd, signal });
	return result.stdout.trim();
}

export async function resetSoftTo(
	cwd: string,
	sha: string,
	signal?: AbortSignal | undefined,
): Promise<void> {
	await runGit(["reset", "--soft", sha], { cwd, signal });
}

export async function commitAll(options: CommitOptions): Promise<string | null> {
	await runGit(["add", "-A"], { cwd: options.cwd, signal: options.signal });
	const status = await runGit(["status", "--porcelain"], {
		cwd: options.cwd,
		signal: options.signal,
	});
	if (status.stdout.trim() === "") {
		return null;
	}
	await runGit(
		[
			"-c",
			`user.name=${options.name}`,
			"-c",
			`user.email=${options.email}`,
			"commit",
			"-q",
			"-m",
			options.message,
		],
		{ cwd: options.cwd, signal: options.signal },
	);
	const head = await runGit(["rev-parse", "HEAD"], { cwd: options.cwd, signal: options.signal });
	return head.stdout.trim();
}

export async function pushBranch(options: {
	cwd: string;
	branch: string;
	force: boolean;
	remoteUrl: string;
	auth: GitAuth;
	signal?: AbortSignal;
}): Promise<void> {
	assertSafeGitRef(options.branch);
	const args = ["push", "--porcelain"];
	if (options.force) {
		args.push("--force");
	}
	args.push(options.remoteUrl, `HEAD:refs/heads/${options.branch}`);
	await runGit(args, {
		cwd: options.cwd,
		auth: options.auth,
		signal: options.signal,
		timeoutMs: 15 * 60 * 1000,
	});
}

export function sanitizeCommitMessage(message: string, fallback: string): string {
	const firstLine = message.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
	const cleaned = firstLine.length > 0 ? firstLine.slice(0, 72) : fallback.replace(/\s+/g, " ").trim().slice(0, 72);
	return cleaned || "PiG: apply requested changes";
}

export function branchSlug(text: string, fallback = "task"): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return slug || fallback;
}
