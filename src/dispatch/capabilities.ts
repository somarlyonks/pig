export type CapabilityParameterType = "string" | "number" | "boolean";

export interface CapabilityParameter {
	name: string;
	type: CapabilityParameterType;
	required: boolean;
	description: string;
	values?: string[];
}

export interface CapabilityDescriptor {
	name: string;
	description: string;
	scope: "repository";
	dangerous: boolean;
	parameters: CapabilityParameter[];
}

const REPOSITORY_PARAMETER: CapabilityParameter = {
	name: "repo",
	type: "string",
	required: true,
	description: "Repository in owner/name form.",
};

export const PIG_CAPABILITIES: CapabilityDescriptor[] = [
	{
		name: "pig.work",
		description: "Change code and open or update a pull request.",
		scope: "repository",
		dangerous: false,
		parameters: [
			REPOSITORY_PARAMETER,
			{
				name: "anchor",
				type: "number",
				required: false,
				description:
					"Issue or pull request number to work on. Omit to have PiG create an issue first.",
			},
			{
				name: "anchorType",
				type: "string",
				required: false,
				description: "Required when anchor is set.",
				values: ["issue", "pull_request"],
			},
			{
				name: "target",
				type: "string",
				required: false,
				description:
					"Write target. Defaults to new for an issue anchor and head for a pull request anchor.",
				values: ["new", "head", "patch"],
			},
			{
				name: "title",
				type: "string",
				required: false,
				description: "Title for the anchor issue PiG creates.",
			},
			{
				name: "instructions",
				type: "string",
				required: true,
				description: "What Pi should change.",
			},
		],
	},
	{
		name: "pig.review",
		description: "Review a pull request.",
		scope: "repository",
		dangerous: false,
		parameters: [
			REPOSITORY_PARAMETER,
			{
				name: "pullRequest",
				type: "number",
				required: true,
				description: "Pull request number to review.",
			},
			{
				name: "focus",
				type: "string",
				required: false,
				description: "Extra reviewer focus.",
			},
		],
	},
	{
		name: "pig.release",
		description: "Tag the default branch and publish a GitHub Release.",
		scope: "repository",
		dangerous: true,
		parameters: [
			REPOSITORY_PARAMETER,
			{
				name: "bump",
				type: "string",
				required: false,
				description: "Version bump. Defaults to auto.",
				values: ["auto", "major", "minor", "patch"],
			},
			{
				name: "version",
				type: "string",
				required: false,
				description: "Exact version to release.",
			},
			{
				name: "draft",
				type: "boolean",
				required: false,
				description: "Publish the release as a draft.",
			},
			{
				name: "prerelease",
				type: "boolean",
				required: false,
				description: "Mark the release as a prerelease.",
			},
		],
	},
	{
		name: "pig.status",
		description: "Report recent jobs for a repository.",
		scope: "repository",
		dangerous: false,
		parameters: [REPOSITORY_PARAMETER],
	},
	{
		name: "pig.cancel",
		description: "Cancel queued jobs and stop the running job for a repository.",
		scope: "repository",
		dangerous: true,
		parameters: [REPOSITORY_PARAMETER],
	},
];
