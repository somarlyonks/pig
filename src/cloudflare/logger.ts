import type { Logger } from "../logger.ts";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function serialize(value: unknown): unknown {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	return value;
}

export function createConsoleLogger(level: Level): Logger {
	const write = (entry: Level, message: string, fields?: Record<string, unknown>) => {
		if (ORDER[entry] < ORDER[level]) return;
		const serialized = Object.fromEntries(
			Object.entries(fields ?? {}).map(([key, value]) => [key, serialize(value)]),
		);
		const suffix = Object.keys(serialized).length > 0 ? ` ${JSON.stringify(serialized)}` : "";
		const line = `${entry.toUpperCase()} ${message}${suffix}`;
		if (entry === "error") console.error(line);
		else if (entry === "warn") console.warn(line);
		else console.log(line);
	};
	return {
		debug: (message, fields) => write("debug", message, fields),
		info: (message, fields) => write("info", message, fields),
		warn: (message, fields) => write("warn", message, fields),
		error: (message, fields) => write("error", message, fields),
		child: () => createConsoleLogger(level),
	};
}
