import type { JobOutcome, JobSummary, OrchestrationContext } from "../context.ts";
import type { ControlJobRequest } from "../types.ts";

const HELP_TEXT = `### PiG — Pi-durable In GitHub

Mention me in an issue or PR comment. \`/pig\` works as an alias for \`@pig\`.

- \`@pig fix <instructions>\` — make the change and open a PR, or update the PR this comment is on.
- \`@pig review [focus]\` — review the pull request. Focus is optional extra context.
- \`@pig release [auto|major|minor|patch|<version>]\` — tag the default branch and publish a GitHub Release. Add \`--draft\` or \`--prerelease\` as needed.
- \`@pig status\` — show recent jobs for this repository.
- \`@pig cancel\` — cancel queued jobs and stop the running job.
- \`@pig help\` — show this message.

A plain comment such as \`@pig add tests for the parser\` is treated as a \`fix\` request. Only users with write access can start jobs. Repository behavior can be tuned in a \`.pig.yml\` file on the default branch.`;

function formatAge(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function escapeTableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function jobDetail(job: JobSummary): string {
	if (job.error) return job.error;
	if (job.summary) return job.summary;
	if (job.status === "running") return "running";
	if (job.status === "queued") return "waiting for a worker";
	if (job.status === "waiting") return "waiting for the previous job";
	if (job.status === "sleeping") return "waiting to retry";
	return "";
}

function renderStatus(jobs: JobSummary[], now: number): string {
	if (jobs.length === 0) {
		return "### PiG status\n\nNo jobs have run for this repository yet.";
	}
	const lines = [
		"### PiG status",
		"",
		"| Job | Kind | Status | Attempts | Age | Detail |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const job of jobs) {
		const detail = escapeTableCell(jobDetail(job)).slice(0, 160);
		lines.push(
			`| \`${job.id.slice(0, 8)}\` | ${job.kind} | ${job.status} | ${job.attempts}/${job.maxAttempts} | ${formatAge(now - job.createdAt)} | ${detail} |`,
		);
	}
	return lines.join("\n");
}

export async function runControlJob(ctx: OrchestrationContext): Promise<JobOutcome> {
	const request = ctx.request as ControlJobRequest;
	let comment: string;
	switch (request.action) {
		case "help":
			comment = HELP_TEXT;
			break;
		case "status":
			comment = renderStatus(await ctx.listJobs(10), ctx.now());
			break;
		case "cancel": {
			const counts = await ctx.cancelRepositoryJobs();
			comment = `### Cancellation requested\n\nCancelled ${counts.cancelled} job${counts.cancelled === 1 ? "" : "s"}. ${
				counts.running > 0
					? `${counts.running} running job${counts.running === 1 ? " is" : "s are"} stopping now.`
					: "No jobs were running."
			}`;
			break;
		}
		case "notice":
			comment = request.message ?? "PiG could not understand that command. Try `@pig help`.";
			break;
	}
	const summary =
		request.action === "cancel" ? "Cancellation requested" : `Control command: ${request.action}`;
	return {
		comment,
		summary,
		result: { action: request.action },
	};
}
