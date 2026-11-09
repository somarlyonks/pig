import type { Harness, SessionEnd } from "@earendil-works/pi-durable";
import type { AppConfig } from "../config.ts";
import type { JobDetail, JobSummary } from "../jobs/context.ts";
import type { WebhookInput, WebhookResult } from "./admission.ts";

export interface PigApp {
	config: AppConfig;
	harness: Harness;
	admit(input: WebhookInput): Promise<WebhookResult>;
	listJobs(repo: string, limit: number): Promise<JobSummary[]>;
	getJob(id: string, repo?: string): Promise<JobDetail | null>;
	activeJobs(): Promise<number>;
	closed: Promise<SessionEnd>;
	shutdown(): Promise<void>;
}
