export type JobKind = "review" | "work" | "release" | "control";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

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

export interface JobSource {
	type: "issue" | "pull_request";
	number: number;
	title: string | null;
}

export interface BaseJobRequest {
	kind: JobKind;
	actor: string;
	source: JobSource;
	trigger: TriggerContext;
	receivedAt: number;
}

export interface ReviewJobRequest extends BaseJobRequest {
	kind: "review";
	auto: boolean;
	headSha: string | null;
	focus: string | null;
}

export interface WorkJobRequest extends BaseJobRequest {
	kind: "work";
	instructions: string;
}

export type ReleaseBump = "auto" | "major" | "minor" | "patch";

export interface ReleaseJobRequest extends BaseJobRequest {
	kind: "release";
	bump: ReleaseBump;
	version: string | null;
	draft: boolean | null;
	prerelease: boolean | null;
}

export type ControlAction = "help" | "status" | "cancel" | "notice";

export interface ControlJobRequest extends BaseJobRequest {
	kind: "control";
	action: ControlAction;
	message: string | null;
}

export type JobRequest =
	| ReviewJobRequest
	| WorkJobRequest
	| ReleaseJobRequest
	| ControlJobRequest;
