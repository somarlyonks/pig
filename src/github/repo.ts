import type { Octokit } from "@octokit/rest";

export interface RepositoryInfo {
	owner: string;
	name: string;
	fullName: string;
	defaultBranch: string;
	archived: boolean;
}

export function splitRepository(fullName: string): { owner: string; name: string } {
	const slash = fullName.indexOf("/");
	if (slash <= 0 || slash === fullName.length - 1) {
		throw new Error(`Invalid repository name: ${fullName}`);
	}
	return {
		owner: fullName.slice(0, slash),
		name: fullName.slice(slash + 1),
	};
}

export async function fetchRepository(octokit: Octokit, fullName: string): Promise<RepositoryInfo> {
	const { owner, name } = splitRepository(fullName);
	const { data } = await octokit.repos.get({ owner, repo: name });
	return {
		owner,
		name,
		fullName: data.full_name,
		defaultBranch: data.default_branch,
		archived: data.archived,
	};
}
