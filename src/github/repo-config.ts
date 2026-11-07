import type { Octokit } from "@octokit/rest";
import type { Logger } from "../logger.ts";
import {
	defaultRepoConfig,
	parseRepoConfig,
	type RepoConfig,
} from "../repo-config.ts";
import type { RepositoryInfo } from "./repo.ts";

const CONFIG_PATH = ".pig.yml";
const MAX_CONFIG_BYTES = 64 * 1024;

export class RepoConfigLoader {
	private readonly cache = new Map<string, { expiresAt: number; config: RepoConfig }>();
	private readonly defaultTimeoutMinutes: number;
	private readonly logger: Logger;
	private readonly ttlMs: number;

	constructor(defaultTimeoutMinutes: number, logger: Logger, ttlMs = 5 * 60 * 1000) {
		this.defaultTimeoutMinutes = defaultTimeoutMinutes;
		this.logger = logger;
		this.ttlMs = ttlMs;
	}

	async get(octokit: Octokit, repo: RepositoryInfo, now = Date.now()): Promise<RepoConfig> {
		const cached = this.cache.get(repo.fullName);
		if (cached && cached.expiresAt > now) {
			return cached.config;
		}

		const defaults = defaultRepoConfig(this.defaultTimeoutMinutes);
		let text: string | null;
		try {
			const { data } = await octokit.repos.getContent({
				owner: repo.owner,
				repo: repo.name,
				path: CONFIG_PATH,
				ref: repo.defaultBranch,
			});
			if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
				text = null;
			} else {
				const decoded = Buffer.from(data.content, "base64").toString("utf8");
				if (Buffer.byteLength(decoded, "utf8") > MAX_CONFIG_BYTES) {
					this.logger.warn("Repository config is too large; using defaults", {
						repo: repo.fullName,
					});
					text = null;
				} else {
					text = decoded;
				}
			}
		} catch (error) {
			const status = (error as { status?: number }).status;
			if (status === 404) {
				text = null;
			} else {
				this.logger.warn("Could not load repository config; using defaults", {
					repo: repo.fullName,
					error,
				});
				return defaults;
			}
		}

		const result = text === null ? { config: defaults, warnings: [] } : parseRepoConfig(text, defaults);
		for (const warning of result.warnings) {
			this.logger.warn("Repository config warning", { repo: repo.fullName, warning });
		}
		this.cache.set(repo.fullName, {
			expiresAt: now + this.ttlMs,
			config: result.config,
		});
		return result.config;
	}

	invalidate(repoFullName: string): void {
		this.cache.delete(repoFullName);
	}
}
