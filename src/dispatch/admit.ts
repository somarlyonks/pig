import type { Octokit } from "@octokit/rest";
import {
	admitDispatch,
	type AdmissionDeps,
	type DispatchInput,
	type WebhookResult,
} from "../durable/admission.ts";
import { dispatchRepository, type DispatchPlanInput } from "./plan.ts";

export async function resolveInstallationId(
	app: Octokit,
	repo: string,
): Promise<number | null> {
	const slash = repo.indexOf("/");
	if (slash <= 0) return null;
	try {
		const response = await app.request("GET /repos/{owner}/{repo}/installation", {
			owner: repo.slice(0, slash),
			repo: repo.slice(slash + 1),
		});
		const data = response.data as { id?: unknown };
		return typeof data.id === "number" ? data.id : null;
	} catch (error) {
		if ((error as { status?: number }).status === 404) return null;
		throw error;
	}
}

export async function dispatchCommand<S extends { phase: string }, R>(options: {
	deps: AdmissionDeps<S, R>;
	app: Octokit;
	input: DispatchPlanInput;
}): Promise<WebhookResult> {
	const repo = dispatchRepository(options.input.params);
	if (!repo) {
		return { status: 400, body: { error: "params.repo must be owner/name" } };
	}
	const installationId = await resolveInstallationId(options.app, repo);
	if (installationId === null) {
		return {
			status: 404,
			body: { error: "PiG is not installed on this repository" },
		};
	}
	const input: DispatchInput = { ...options.input, installationId };
	return admitDispatch(options.deps, input);
}
