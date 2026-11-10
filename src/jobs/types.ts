export type JobKind = "review" | "work" | "release" | "control";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Where a command came from. Only the reply channel and audit trail differ. */
export type JobOrigin = "github" | "console";

export interface ReviewCommentContext {
	id: number;
	path: string;
	line: number | null;
	body: string;
}

export interface TriggerContext {
	commentId: number | null;
	commentBody: string | null;
	commentAuthor: string | null;
	reviewComment: ReviewCommentContext | null;
}

export interface IssueAnchor {
	type: "issue";
	number: number;
	title: string | null;
}

export interface PullRequestAnchor {
	type: "pull_request";
	number: number;
	title: string | null;
}

/** An anchor PiG creates itself before working. */
export interface GeneratedAnchor {
	type: "generated";
	number: null;
	title: string | null;
}

/** Repository-scoped commands that need no GitHub object. */
export interface RepositoryAnchor {
	type: "repository";
	number: null;
	title: null;
}

export type JobSource = IssueAnchor | PullRequestAnchor | GeneratedAnchor | RepositoryAnchor;
export type WorkSource = IssueAnchor | PullRequestAnchor | GeneratedAnchor;
export type ReviewSource = PullRequestAnchor;

/**
 * Where PiG writes. The command chooses it; the agent never does.
 *
 * - `new`: a PiG-owned branch from the default branch and a new pull request.
 * - `head`: the anchor pull request's own head branch.
 * - `patch`: a PiG-owned branch above the anchor pull request's head commit.
 */
export type WorkTarget = "new" | "head" | "patch";

export type ReleaseBump = "auto" | "major" | "minor" | "patch";
export type ControlAction = "help" | "status" | "cancel" | "notice";

interface JobRequestBase {
	origin: JobOrigin;
	actor: string;
	trigger: TriggerContext;
	receivedAt: number;
}

export interface ReviewJobRequest extends JobRequestBase {
	kind: "review";
	source: ReviewSource;
	auto: boolean;
	headSha: string | null;
	focus: string | null;
}

export interface WorkJobRequest extends JobRequestBase {
	kind: "work";
	source: WorkSource;
	target: WorkTarget;
	instructions: string;
}

export interface ReleaseJobRequest extends JobRequestBase {
	kind: "release";
	source: JobSource;
	bump: ReleaseBump;
	version: string | null;
	draft: boolean | null;
	prerelease: boolean | null;
}

export interface ControlJobRequest extends JobRequestBase {
	kind: "control";
	source: JobSource;
	action: ControlAction;
	message: string | null;
}

export type JobRequest =
	| ReviewJobRequest
	| WorkJobRequest
	| ReleaseJobRequest
	| ControlJobRequest;
