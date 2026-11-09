export function sanitizeCommitMessage(message: string, fallback: string): string {
	const firstLine = message.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
	const cleaned =
		firstLine.length > 0
			? firstLine.slice(0, 72)
			: fallback.replace(/\s+/g, " ").trim().slice(0, 72);
	return cleaned || "PiG: apply requested changes";
}

export function branchSlug(text: string, fallback = "task"): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return slug || fallback;
}
