const SAFE_SHELL_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"SYSTEMROOT",
	"COMSPEC",
	"PATHEXT",
];

export function buildShellEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of SAFE_SHELL_KEYS) {
		const value = source[key];
		if (typeof value === "string" && value !== "") {
			environment[key] = value;
		}
	}
	environment.CI = "1";
	environment.NO_COLOR = "1";
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GCM_INTERACTIVE = "never";
	return environment;
}
