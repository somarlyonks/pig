import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
	EnqueueResult,
	JobEventRow,
	JobRow,
	JobStatus,
	NewJob,
	JobKind,
} from "./types.ts";

const JOB_COLUMNS = `
	id,
	installation_id AS installationId,
	repo,
	kind,
	idempotency_key AS idempotencyKey,
	request_json AS requestJson,
	status,
	attempts,
	max_attempts AS maxAttempts,
	available_at AS availableAt,
	lease_owner AS leaseOwner,
	lease_expires_at AS leaseExpiresAt,
	created_at AS createdAt,
	started_at AS startedAt,
	finished_at AS finishedAt,
	progress_comment_id AS progressCommentId,
	checkpoint_json AS checkpointJson,
	result_json AS resultJson,
	error,
	cancel_requested AS cancelRequested
`;

function parseJson(value: unknown): unknown {
	if (typeof value !== "string") {
		return null;
	}
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function mapJob(row: unknown): JobRow {
	const record = row as Record<string, unknown>;
	return {
		id: String(record.id),
		installationId: Number(record.installationId),
		repo: String(record.repo),
		kind: String(record.kind) as JobKind,
		idempotencyKey: String(record.idempotencyKey),
		request: parseJson(record.requestJson),
		status: String(record.status) as JobStatus,
		attempts: Number(record.attempts),
		maxAttempts: Number(record.maxAttempts),
		availableAt: Number(record.availableAt),
		leaseOwner: record.leaseOwner === null ? null : String(record.leaseOwner),
		leaseExpiresAt: record.leaseExpiresAt === null ? null : Number(record.leaseExpiresAt),
		createdAt: Number(record.createdAt),
		startedAt: record.startedAt === null ? null : Number(record.startedAt),
		finishedAt: record.finishedAt === null ? null : Number(record.finishedAt),
		progressCommentId:
			record.progressCommentId === null ? null : Number(record.progressCommentId),
		checkpoint: parseJson(record.checkpointJson),
		result: parseJson(record.resultJson),
		error: record.error === null ? null : String(record.error),
		cancelRequested: Number(record.cancelRequested) === 1,
	};
}

export class JobStore {
	private readonly db: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();

	constructor(path: string) {
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true });
		}
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA busy_timeout = 5000;
			PRAGMA foreign_keys = ON;

			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY,
				installation_id INTEGER NOT NULL,
				repo TEXT NOT NULL,
				kind TEXT NOT NULL,
				idempotency_key TEXT NOT NULL UNIQUE,
				request_json TEXT NOT NULL,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				max_attempts INTEGER NOT NULL DEFAULT 3,
				available_at INTEGER NOT NULL,
				lease_owner TEXT,
				lease_expires_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				progress_comment_id INTEGER,
				checkpoint_json TEXT,
				result_json TEXT,
				error TEXT,
				cancel_requested INTEGER NOT NULL DEFAULT 0
			);

			CREATE INDEX IF NOT EXISTS jobs_claim
				ON jobs(status, available_at, repo, kind);
			CREATE INDEX IF NOT EXISTS jobs_repo_status
				ON jobs(repo, status);
			CREATE INDEX IF NOT EXISTS jobs_created
				ON jobs(created_at);

			CREATE TABLE IF NOT EXISTS job_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				job_id TEXT NOT NULL,
				at INTEGER NOT NULL,
				level TEXT NOT NULL,
				message TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS job_events_job
				ON job_events(job_id, id);

			CREATE TABLE IF NOT EXISTS deliveries (
				delivery_id TEXT PRIMARY KEY,
				event TEXT NOT NULL,
				received_at INTEGER NOT NULL,
				job_id TEXT
			);
		`);
	}

	private statement(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// The transaction may already have been rolled back by SQLite.
			}
			throw error;
		}
	}

	enqueue(job: NewJob, now = Date.now()): EnqueueResult {
		const availableAt = job.availableAt ?? now;
		const inserted = this.statement(`
			INSERT INTO jobs (
				id, installation_id, repo, kind, idempotency_key, request_json,
				status, attempts, max_attempts, available_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
			ON CONFLICT(idempotency_key) DO NOTHING
		`).run(
			job.id,
			job.installationId,
			job.repo,
			job.kind,
			job.idempotencyKey,
			JSON.stringify(job.request),
			job.maxAttempts ?? 3,
			availableAt,
			now,
		);

		const created = Number(inserted.changes) > 0;
		const row = this.statement(
			`SELECT ${JOB_COLUMNS} FROM jobs WHERE idempotency_key = ?`,
		).get(job.idempotencyKey);
		if (!row) {
			throw new Error(`Job ${job.id} was not persisted`);
		}
		return { job: mapJob(row), created };
	}

	claimNext(
		owner: string,
		now = Date.now(),
		leaseMs = 120_000,
		options: { onlyControl?: boolean } = {},
	): JobRow | null {
		return this.transaction(() => {
			const candidate = this.statement(`
				SELECT j.id
				FROM jobs j
				WHERE j.status = 'queued'
					AND j.available_at <= ?
					AND (j.kind = 'control' OR ? = 0)
					AND (
						j.kind = 'control'
						OR NOT EXISTS (
							SELECT 1
							FROM jobs r
							WHERE r.repo = j.repo
								AND r.status = 'running'
								AND r.kind <> 'control'
						)
					)
				ORDER BY CASE WHEN j.kind = 'control' THEN 0 ELSE 1 END, j.created_at ASC
				LIMIT 1
			`).get(now, options.onlyControl ? 1 : 0) as { id?: unknown } | undefined;

			if (!candidate?.id) {
				return null;
			}
			const id = String(candidate.id);
			const updated = this.statement(`
				UPDATE jobs
				SET status = 'running',
					lease_owner = ?,
					lease_expires_at = ?,
					attempts = attempts + 1,
					started_at = COALESCE(started_at, ?)
				WHERE id = ? AND status = 'queued'
			`).run(owner, now + leaseMs, now, id);

			if (Number(updated.changes) === 0) {
				return null;
			}
			const row = this.statement(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id);
			return row ? mapJob(row) : null;
		});
	}

	heartbeat(jobId: string, owner: string, now = Date.now(), leaseMs = 120_000): boolean {
		const result = this.statement(`
			UPDATE jobs
			SET lease_expires_at = ?
			WHERE id = ? AND status = 'running' AND lease_owner = ?
		`).run(now + leaseMs, jobId, owner);
		return Number(result.changes) === 1;
	}

	finish(
		jobId: string,
		owner: string,
		status: "succeeded" | "failed" | "cancelled",
		options: { result?: unknown; error?: string | null; now?: number } = {},
	): boolean {
		const now = options.now ?? Date.now();
		const result = this.statement(`
			UPDATE jobs
			SET status = ?,
				result_json = ?,
				error = ?,
				finished_at = ?,
				lease_owner = NULL,
				lease_expires_at = NULL
			WHERE id = ? AND status = 'running' AND lease_owner = ?
		`).run(
			status,
			options.result === undefined ? null : JSON.stringify(options.result),
			options.error ?? null,
			now,
			jobId,
			owner,
		);
		return Number(result.changes) === 1;
	}

	requeue(
		jobId: string,
		owner: string,
		options: { availableAt?: number; error?: string | null; refundAttempt?: boolean } = {},
	): boolean {
		const result = this.statement(`
			UPDATE jobs
			SET status = 'queued',
				available_at = ?,
				error = ?,
				lease_owner = NULL,
				lease_expires_at = NULL,
				attempts = CASE WHEN ? = 1 THEN MAX(attempts - 1, 0) ELSE attempts END
			WHERE id = ? AND status = 'running' AND lease_owner = ?
		`).run(
			options.availableAt ?? Date.now(),
			options.error ?? null,
			options.refundAttempt ? 1 : 0,
			jobId,
			owner,
		);
		return Number(result.changes) === 1;
	}

	markCancelled(jobId: string, owner: string, reason = "Cancelled by request", now = Date.now()): boolean {
		const result = this.statement(`
			UPDATE jobs
			SET status = 'cancelled',
				error = ?,
				finished_at = ?,
				lease_owner = NULL,
				lease_expires_at = NULL
			WHERE id = ? AND status = 'running' AND lease_owner = ?
		`).run(reason, now, jobId, owner);
		return Number(result.changes) === 1;
	}

	recoverExpiredLeases(now = Date.now()): { requeued: number; failed: number } {
		return this.transaction(() => {
			const failed = this.statement(`
				UPDATE jobs
				SET status = 'failed',
					error = COALESCE(error, 'Job lease expired after the final attempt'),
					finished_at = ?,
					lease_owner = NULL,
					lease_expires_at = NULL
				WHERE status = 'running'
					AND (lease_expires_at IS NULL OR lease_expires_at < ?)
					AND attempts >= max_attempts
			`).run(now, now);

			const requeued = this.statement(`
				UPDATE jobs
				SET status = 'queued',
					available_at = ?,
					error = COALESCE(error, 'Recovered after an interrupted attempt'),
					lease_owner = NULL,
					lease_expires_at = NULL
				WHERE status = 'running'
					AND (lease_expires_at IS NULL OR lease_expires_at < ?)
			`).run(now, now);

			return {
				requeued: Number(requeued.changes),
				failed: Number(failed.changes),
			};
		});
	}

	requestCancel(
		repo: string,
		now = Date.now(),
		excludeJobId: string | null = null,
	): { queued: number; running: number } {
		return this.transaction(() => {
			const queued = this.statement(`
				UPDATE jobs
				SET status = 'cancelled',
					error = 'Cancelled by request',
					finished_at = ?,
					lease_owner = NULL,
					lease_expires_at = NULL
				WHERE repo = ? AND status = 'queued'
			`).run(now, repo);
			const running = this.statement(`
				UPDATE jobs SET cancel_requested = 1
				WHERE repo = ? AND status = 'running' AND kind <> 'control' AND id <> ?
			`).run(repo, excludeJobId ?? "");
			return {
				queued: Number(queued.changes),
				running: Number(running.changes),
			};
		});
	}

	isCancelRequested(jobId: string): boolean {
		const row = this.statement(`
			SELECT cancel_requested AS cancelRequested FROM jobs WHERE id = ?
		`).get(jobId) as { cancelRequested?: unknown } | undefined;
		return Number(row?.cancelRequested ?? 0) === 1;
	}

	setCheckpoint(jobId: string, owner: string, checkpoint: unknown): boolean {
		const result = this.statement(`
			UPDATE jobs SET checkpoint_json = ?
			WHERE id = ? AND status = 'running' AND lease_owner = ?
		`).run(JSON.stringify(checkpoint), jobId, owner);
		return Number(result.changes) === 1;
	}

	setProgressComment(jobId: string, commentId: number): void {
		this.statement(`
			UPDATE jobs SET progress_comment_id = ? WHERE id = ?
		`).run(commentId, jobId);
	}

	getJob(jobId: string): JobRow | null {
		const row = this.statement(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(jobId);
		return row ? mapJob(row) : null;
	}

	getJobsForRepo(repo: string, limit = 10): JobRow[] {
		const rows = this.statement(`
			SELECT ${JOB_COLUMNS} FROM jobs
			WHERE repo = ?
			ORDER BY created_at DESC
			LIMIT ?
		`).all(repo, limit);
		return rows.map(mapJob);
	}

	getRecentJobs(limit = 50): JobRow[] {
		const rows = this.statement(`
			SELECT ${JOB_COLUMNS} FROM jobs
			ORDER BY created_at DESC
			LIMIT ?
		`).all(limit);
		return rows.map(mapJob);
	}

	appendEvent(jobId: string, level: string, message: string, now = Date.now()): void {
		this.statement(`
			INSERT INTO job_events (job_id, at, level, message) VALUES (?, ?, ?, ?)
		`).run(jobId, now, level, message);
		this.statement(`
			DELETE FROM job_events
			WHERE job_id = ? AND id NOT IN (
				SELECT id FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 200
			)
		`).run(jobId, jobId);
	}

	getEvents(jobId: string, limit = 100): JobEventRow[] {
		const rows = this.statement(`
			SELECT id, job_id AS jobId, at, level, message
			FROM job_events
			WHERE job_id = ?
			ORDER BY id DESC
			LIMIT ?
		`).all(jobId, limit) as Record<string, unknown>[];
		return rows.reverse().map((row) => ({
			id: Number(row.id),
			jobId: String(row.jobId),
			at: Number(row.at),
			level: String(row.level),
			message: String(row.message),
		}));
	}

	hasDelivery(deliveryId: string): boolean {
		const row = this.statement(`
			SELECT 1 AS found FROM deliveries WHERE delivery_id = ?
		`).get(deliveryId);
		return row !== undefined;
	}

	recordDelivery(deliveryId: string, event: string, jobId: string | null, now = Date.now()): boolean {
		const result = this.statement(`
			INSERT INTO deliveries (delivery_id, event, received_at, job_id)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(delivery_id) DO NOTHING
		`).run(deliveryId, event, now, jobId);
		return Number(result.changes) > 0;
	}

	close(): void {
		this.db.close();
	}
}
