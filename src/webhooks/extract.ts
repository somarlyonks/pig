export function extractRepository(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null) return null;
	const repository = (payload as { repository?: unknown }).repository;
	if (typeof repository !== "object" || repository === null) return null;
	const fullName = (repository as { full_name?: unknown }).full_name;
	if (typeof fullName !== "string") return null;
	const slash = fullName.indexOf("/");
	if (slash <= 0 || slash === fullName.length - 1) return null;
	return fullName;
}
