import { PermanentJobError, TransientJobError } from "./errors.ts";
import type { AgentRunResult } from "./context.ts";

export function assertAgentSucceeded(result: AgentRunResult): void {
	switch (result.status) {
		case "done":
			return;
		case "aborted":
			throw new TransientJobError(result.error ?? "The agent run was cancelled.");
		case "timeout":
			throw new PermanentJobError(result.error ?? "Pi timed out while working on this request.");
		case "failed": {
			const error = result.error ?? "Pi could not finish this run.";
			throw result.retryable ? new TransientJobError(error) : new PermanentJobError(error);
		}
	}
}
