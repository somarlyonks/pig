import type { Octokit } from "@octokit/rest";
import type { OrchestrationContext, JobOutcome } from "../context.ts";
import { PermanentJobError } from "../errors.ts";
import type { ReleaseJobRequest } from "../types.ts";
import {
	buildReleaseNotes,
	bumpVersion,
	compareSemVer,
	formatSemVer,
	inferBump,
	parseSemVer,
	parseTagVersion,
	type BumpKind,
	type ReleasePullRequest,
	type SemVer,
} from "../../semver.ts";

const MAX_PULL_PAGES = 10;
const PAGE_SIZE = 100;

interface ReleaseCheckpoint {
	tag: string;
	version: string;
	previousTag: string | null;
	body: string;
	sha: string | null;
	draft: boolean;
	prerelease: boolean;
	pullCount: number;
	releaseUrl?: string;
}

interface TaggedVersion {
	tag: string;
	version: SemVer;
}

interface PullCollection {
	pulls: ReleasePullRequest[];
	truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function checkpointFrom(value: unknown): ReleaseCheckpoint | null {
	const record = asRecord(value);
	if (
		!record ||
		typeof record.tag !== "string" ||
		typeof record.version !== "string" ||
		typeof record.body !== "string" ||
		typeof record.draft !== "boolean" ||
		typeof record.prerelease !== "boolean"
	) {
		return null;
	}
	return {
		tag: record.tag,
		version: record.version,
		previousTag: typeof record.previousTag === "string" ? record.previousTag : null,
		body: record.body,
		sha: typeof record.sha === "string" ? record.sha : null,
		draft: record.draft,
		prerelease: record.prerelease,
		pullCount: typeof record.pullCount === "number" ? record.pullCount : 0,
		...(typeof record.releaseUrl === "string" ? { releaseUrl: record.releaseUrl } : {}),
	};
}

async function listTaggedVersions(
	octokit: Octokit,
	owner: string,
	repo: string,
	prefix: string,
): Promise<TaggedVersion[]> {
	const tags = await octokit.paginate(octokit.repos.listTags, {
		owner,
		repo,
		per_page: PAGE_SIZE,
	});
	const versions: TaggedVersion[] = [];
	for (const tag of tags) {
		const version = parseTagVersion(tag.name, prefix);
		if (version) versions.push({ tag: tag.name, version });
	}
	return versions.sort((left, right) => compareSemVer(right.version, left.version));
}

async function tagCommitDate(
	octokit: Octokit,
	owner: string,
	repo: string,
	tag: string,
): Promise<Date> {
	const { data } = await octokit.repos.getCommit({ owner, repo, ref: tag });
	const date = data.commit.committer?.date ?? data.commit.author?.date;
	if (!date) {
		throw new Error(`Could not determine the commit date for tag ${tag}`);
	}
	return new Date(date);
}

async function collectMergedPulls(options: {
	octokit: Octokit;
	owner: string;
	repo: string;
	baseBranch: string;
	since: Date | null;
	until: Date;
}): Promise<PullCollection> {
	const pulls: ReleasePullRequest[] = [];
	let truncated = false;

	for (let page = 1; page <= MAX_PULL_PAGES; page += 1) {
		const { data } = await options.octokit.pulls.list({
			owner: options.owner,
			repo: options.repo,
			state: "closed",
			sort: "updated",
			direction: "desc",
			per_page: PAGE_SIZE,
			page,
		});
		if (data.length === 0) break;

		for (const pull of data) {
			if (!pull.merged_at) continue;
			if (pull.base.ref !== options.baseBranch) continue;
			const mergedAt = new Date(pull.merged_at);
			if (options.since && mergedAt <= options.since) continue;
			if (mergedAt > options.until) continue;
			pulls.push({
				number: pull.number,
				title: pull.title,
				author: pull.user?.login ?? null,
				labels: pull.labels.map((label) => (typeof label === "string" ? label : label.name)),
			});
		}

		const oldestUpdated = data[data.length - 1]?.updated_at;
		if (
			options.since &&
			oldestUpdated &&
			new Date(oldestUpdated) < options.since
		) {
			break;
		}
		if (data.length < PAGE_SIZE) break;
		if (page === MAX_PULL_PAGES) truncated = true;
	}

	return { pulls, truncated };
}

async function getReleaseByTag(
	octokit: Octokit,
	owner: string,
	repo: string,
	tag: string,
): Promise<{ url: string; id: number } | null> {
	try {
		const { data } = await octokit.repos.getReleaseByTag({ owner, repo, tag });
		return { url: data.html_url, id: data.id };
	} catch (error) {
		if ((error as { status?: number }).status === 404) {
			return null;
		}
		throw error;
	}
}

async function tagExists(
	octokit: Octokit,
	owner: string,
	repo: string,
	tag: string,
): Promise<boolean> {
	try {
		await octokit.git.getRef({ owner, repo, ref: `tags/${tag}` });
		return true;
	} catch (error) {
		if ((error as { status?: number }).status === 404) {
			return false;
		}
		throw error;
	}
}

function initialVersion(bump: BumpKind): SemVer {
	return bump === "major"
		? { major: 1, minor: 0, patch: 0, prerelease: null }
		: { major: 0, minor: 1, patch: 0, prerelease: null };
}

function releaseOutcome(
	checkpoint: ReleaseCheckpoint,
	url: string,
	duplicate: boolean,
): JobOutcome {
	const verb = checkpoint.draft ? "created draft release" : "released";
	const summary = `${duplicate ? "Release already exists" : "Released"} ${checkpoint.tag}${checkpoint.draft ? " (draft)" : ""}${checkpoint.pullCount ? ` with ${checkpoint.pullCount} pull request${checkpoint.pullCount === 1 ? "" : "s"}` : ""}.`;
	return {
		comment: duplicate
			? `Release ${checkpoint.tag} already exists: ${url}`
			: `PiG ${verb} ${checkpoint.tag}: ${url}`,
		summary,
		result: {
			tag: checkpoint.tag,
			version: checkpoint.version,
			previousTag: checkpoint.previousTag,
			releaseUrl: url,
			draft: checkpoint.draft,
			prerelease: checkpoint.prerelease,
			pullCount: checkpoint.pullCount,
			duplicate,
		},
	};
}

export async function runReleaseJob(context: OrchestrationContext): Promise<JobOutcome> {
	const request = context.request as ReleaseJobRequest;
	const { owner, name: repo } = context.repoInfo;
	const prefix = context.config.release.tagPrefix;
	let checkpoint = checkpointFrom(context.checkpoint);

	if (checkpoint?.releaseUrl) {
		return releaseOutcome(checkpoint, checkpoint.releaseUrl, true);
	}

	if (!checkpoint) {
		const tagged = await listTaggedVersions(context.octokit, owner, repo, prefix);
		const latest = tagged[0] ?? null;

		let targetVersion: SemVer;
		let previousTag: string | null = latest?.tag ?? null;
		let targetTag: string;
		let isExistingTag = false;
		let targetDate = new Date();
		let autoCollection: PullCollection | null = null;

		if (request.version) {
			const explicit = parseSemVer(request.version);
			if (!explicit) {
				throw new PermanentJobError(`Invalid release version: ${request.version}`);
			}
			targetVersion = explicit;
			targetTag = `${prefix}${formatSemVer(targetVersion)}`;
			const existing = tagged.find((entry) => entry.tag === targetTag);
			if (existing) {
				isExistingTag = true;
				previousTag =
					tagged.find((entry) => compareSemVer(entry.version, targetVersion) < 0)?.tag ?? null;
				targetDate = await tagCommitDate(context.octokit, owner, repo, targetTag);
			} else if (latest && compareSemVer(targetVersion, latest.version) < 0) {
				throw new PermanentJobError(
					`${targetTag} is older than the latest release ${latest.tag}. Choose a higher version.`,
				);
			}
		} else {
			let bump: BumpKind;
			if (request.bump === "auto") {
				const since =
					latest === null
						? null
						: await tagCommitDate(context.octokit, owner, repo, latest.tag);
				const collection = await collectMergedPulls({
					octokit: context.octokit,
					owner,
					repo,
					baseBranch: context.repoInfo.defaultBranch,
					since,
					until: new Date(),
				});
				autoCollection = collection;
				if (collection.pulls.length === 0) {
					throw new PermanentJobError(
						latest
							? `No merged pull requests since ${latest.tag}; nothing to release.`
							: "No merged pull requests were found; nothing to release.",
					);
				}
				bump = inferBump(collection.pulls);
			} else {
				bump = request.bump;
			}
			targetVersion = latest
				? bumpVersion(latest.version, bump)
				: initialVersion(bump);
			targetTag = `${prefix}${formatSemVer(targetVersion)}`;
			const existing = tagged.find((entry) => entry.tag === targetTag);
			if (existing) {
				isExistingTag = true;
				previousTag =
					tagged.find((entry) => compareSemVer(entry.version, targetVersion) < 0)?.tag ?? null;
				targetDate = await tagCommitDate(context.octokit, owner, repo, targetTag);
			}
		}

		if (isExistingTag) {
			const existingRelease = await getReleaseByTag(context.octokit, owner, repo, targetTag);
			if (existingRelease) {
				return {
					comment: `Release ${targetTag} already exists: ${existingRelease.url}`,
					summary: `Release ${targetTag} already exists.`,
					result: { tag: targetTag, releaseUrl: existingRelease.url, duplicate: true },
				};
			}
		}

		const previousTagDate =
			previousTag === null
				? null
				: await tagCommitDate(context.octokit, owner, repo, previousTag);
		const collection =
			request.bump === "auto" &&
			autoCollection !== null &&
			previousTag === (latest?.tag ?? null)
				? autoCollection
				: await collectMergedPulls({
						octokit: context.octokit,
						owner,
						repo,
						baseBranch: context.repoInfo.defaultBranch,
						since: previousTagDate,
						until: targetDate,
					});

		if (!isExistingTag && collection.pulls.length === 0) {
			throw new PermanentJobError(
				previousTag
					? `No merged pull requests since ${previousTag}; nothing to release.`
					: "No merged pull requests were found; nothing to release.",
			);
		}

		const body = buildReleaseNotes({
			repository: context.repoInfo.fullName,
			tag: targetTag,
			previousTag,
			pulls: collection.pulls,
		}) + (collection.truncated
			? "\n> Release notes were limited to the most recently updated merged pull requests.\n"
			: "");

		const sha = isExistingTag
			? null
			: (await context.octokit.repos.getBranch({
					owner,
					repo,
					branch: context.repoInfo.defaultBranch,
				})).data.commit.sha;

		checkpoint = {
			tag: targetTag,
			version: formatSemVer(targetVersion),
			previousTag,
			body,
			sha,
			draft: request.draft ?? context.config.release.draft,
			prerelease: request.prerelease ?? targetVersion.prerelease !== null,
			pullCount: collection.pulls.length,
		};
		await context.setCheckpoint(checkpoint);
	}

	context.signal.throwIfAborted();
	if (!(await tagExists(context.octokit, owner, repo, checkpoint.tag))) {
		if (!checkpoint.sha) {
			throw new PermanentJobError(`Tag ${checkpoint.tag} does not exist and has no commit to point to.`);
		}
		try {
			await context.octokit.git.createRef({
				owner,
				repo,
				ref: `refs/tags/${checkpoint.tag}`,
				sha: checkpoint.sha,
			});
		} catch (error) {
			if ((error as { status?: number }).status !== 422) {
				throw error;
			}
		}
	}

	const existingRelease = await getReleaseByTag(context.octokit, owner, repo, checkpoint.tag);
	if (existingRelease) {
		checkpoint.releaseUrl = existingRelease.url;
		await context.setCheckpoint(checkpoint);
		return releaseOutcome(checkpoint, existingRelease.url, true);
	}

	context.signal.throwIfAborted();
	let release;
	try {
		release = await context.octokit.repos.createRelease({
			owner,
			repo,
			tag_name: checkpoint.tag,
			name: checkpoint.tag,
			body: checkpoint.body,
			draft: checkpoint.draft,
			prerelease: checkpoint.prerelease,
			generate_release_notes: false,
		});
	} catch (error) {
		if ((error as { status?: number }).status !== 422) {
			throw error;
		}
		release = await context.octokit.repos.getReleaseByTag({
			owner,
			repo,
			tag: checkpoint.tag,
		});
	}

	checkpoint.releaseUrl = release.data.html_url;
	await context.setCheckpoint(checkpoint);
	return releaseOutcome(checkpoint, release.data.html_url, false);
}

