export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export interface Logger {
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
	child(fields: Record<string, unknown>): Logger;
}

function serializeField(value: unknown): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	return value;
}

export function createLogger(level: LogLevel, baseFields: Record<string, unknown> = {}): Logger {
	const threshold = LEVEL_ORDER[level];
	const write = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>) => {
		if (LEVEL_ORDER[entryLevel] < threshold) {
			return;
		}
		const merged = { ...baseFields, ...fields };
		const serialized = Object.fromEntries(
			Object.entries(merged).map(([key, value]) => [key, serializeField(value)]),
		);
		const suffix = Object.keys(serialized).length > 0 ? ` ${JSON.stringify(serialized)}` : "";
		const line = `${new Date().toISOString()} ${entryLevel.toUpperCase().padEnd(5)} ${message}${suffix}\n`;
		if (entryLevel === "warn" || entryLevel === "error") {
			process.stderr.write(line);
		} else {
			process.stdout.write(line);
		}
	};

	return {
		debug: (message, fields) => write("debug", message, fields),
		info: (message, fields) => write("info", message, fields),
		warn: (message, fields) => write("warn", message, fields),
		error: (message, fields) => write("error", message, fields),
		child: (fields) => createLogger(level, { ...baseFields, ...fields }),
	};
}

export function isLogLevel(value: string | undefined): value is LogLevel {
	return value === "debug" || value === "info" || value === "warn" || value === "error";
}
