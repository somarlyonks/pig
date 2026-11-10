import type { ExportedHandler } from "@cloudflare/workers-types";
import { renderConsoleHtml } from "../../console/ui.ts";
import type { ConsoleEnv } from "./env.ts";

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

const worker: ExportedHandler<ConsoleEnv> = {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/healthz") {
			return json({ ok: true, app: "pig-console" });
		}
		if (request.method === "GET" && url.pathname === "/") {
			return new Response(renderConsoleHtml(), {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			});
		}
		if (url.pathname.startsWith("/api/")) {
			const stub = env.CONSOLE.get(env.CONSOLE.idFromName("workspace"));
			return stub.fetch(request);
		}
		return json({ error: "not found" }, 404);
	},
};

export { ConsoleDurableObject } from "./console-do.ts";
export default worker;
