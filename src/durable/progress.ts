import type { Octokit } from "@octokit/rest";
import type { Logger } from "../logger.ts";

export interface ProgressRepo {
	owner: string;
	name: string;
}

export function truncateComment(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > 60_000 ? `${trimmed.slice(0, 59_999)}…` : trimmed;
}

export class ProgressComment {
	private id: number | null;
	private readonly octokit: Octokit;
	private readonly repoInfo: ProgressRepo;
	private issueNumber: number | null;
	private readonly onCreated: (id: number) => Promise<void>;
	private readonly logger: Logger;

	constructor(options: {
		octokit: Octokit;
		repoInfo: ProgressRepo;
		issueNumber: number | null;
		initialId: number | null;
		onCreated: (id: number) => Promise<void>;
		logger: Logger;
	}) {
		this.octokit = options.octokit;
		this.repoInfo = options.repoInfo;
		this.issueNumber = options.issueNumber;
		this.onCreated = options.onCreated;
		this.logger = options.logger;
		this.id = options.initialId;
	}

	/**
	 * A job may learn its anchor after it starts: a console command can ask PiG
	 * to create one, and repository-scoped commands never have one.
	 */
	setIssueNumber(issueNumber: number): void {
		this.issueNumber = issueNumber;
	}

	async update(body: string): Promise<boolean> {
		if (this.issueNumber === null) return false;
		const text = truncateComment(body);
		if (this.id === null) {
			await this.create(text);
			return true;
		}
		try {
			await this.octokit.issues.updateComment({
				owner: this.repoInfo.owner,
				repo: this.repoInfo.name,
				comment_id: this.id,
				body: text,
			});
		} catch (error) {
			if ((error as { status?: number }).status === 404) {
				this.id = null;
				await this.create(text);
				return true;
			}
			this.logger.warn("Could not update progress comment", { error });
		}
		return true;
	}

	private async create(text: string): Promise<void> {
		const issueNumber = this.issueNumber;
		if (issueNumber === null) return;
		try {
			const { data } = await this.octokit.issues.createComment({
				owner: this.repoInfo.owner,
				repo: this.repoInfo.name,
				issue_number: issueNumber,
				body: text,
			});
			this.id = data.id;
			await this.onCreated(data.id);
		} catch (error) {
			this.logger.warn("Could not create progress comment", { error });
		}
	}
}
