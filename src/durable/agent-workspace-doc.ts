import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

export interface AgentWorkspaceState {
	[key: string]: JsonValue;
	workspaceId: string;
}

export const AgentWorkspaceDoc = defineDoc<AgentWorkspaceState>({
	kind: "pig.agent-workspace",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ workspaceId: "" }),
	checkpointWhen: () => false,
});
