import type { TaskInspection } from "@earendil-works/pi-durable";

export function nextAlarmForTasks(
	tasks: readonly TaskInspection[],
	now: number,
	recoveryMs: number,
): number | undefined {
	let next: number | undefined;
	const consider = (at: number) => {
		next = next === undefined ? at : Math.min(next, at);
	};
	for (const task of tasks) {
		if (task.state.kind === "blocked") continue;
		const record = task.record;
		if (record.state.status === "sleeping") {
			if (record.state.until > now && !record.abortRequested) {
				consider(record.state.until);
			} else {
				consider(now + recoveryMs);
			}
			continue;
		}
		if (record.state.status === "pending" || record.state.status === "running") {
			consider(now + recoveryMs);
		}
	}
	return next;
}
