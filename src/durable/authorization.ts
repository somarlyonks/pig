import type { Octokit } from "@octokit/rest";
import type { RepositoryInfo } from "../github/repo.ts";
import type { Logger } from "../logger.ts";
import type { RepoConfig } from "../repo-config.ts";
import { PermanentJobError } from "../jobs/errors.ts";

export async function assertAuthorized(
	octokit: Octokit,
	repoInfo: RepositoryInfo,
	actor: string,
	config: RepoConfig,
	logger: Logger,
): Promise<void> {
	if (config.permissions.allow.includes(actor.toLowerCase())) {
		return;
	}
	let allowed = false;
	try {
		const { data } = await octokit.repos.getCollaboratorPermissionLevel({
			owner: repoInfo.owner,
			repo: repoInfo.name,
			username: actor,
		});
		allowed = ["admin", "maintain", "write", "push"].includes(data.permission.toLowerCase());
	} catch (error) {
		if ((error as { status?: number }).status !== 404) {
			throw error;
		}
	}
	if (!allowed) {
		logger.info("Authorization denied", { actor });
		throw new PermanentJobError(
			`@${actor} needs write access to this repository to use PiG.`,
		);
	}
}
