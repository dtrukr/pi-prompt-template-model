import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const RESERVED_COMMAND_NAMES = new Set([
	"chain-prompts",
	"settings",
	"model",
	"scoped-models",
	"export",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"tree",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
]);

export type PromptSource = "user" | "project";

export interface PromptWithModel {
	name: string;
	description: string;
	content: string;
	models: string[];
	restore: boolean;
	skill?: string;
	thinking?: ThinkingLevel;
	source: PromptSource;
	subdir?: string;
	filePath: string;
}

export interface PromptLoaderDiagnostic {
	code: string;
	message: string;
	filePath: string;
	source: PromptSource;
	key: string;
}

export interface LoadPromptsWithModelResult {
	prompts: Map<string, PromptWithModel>;
	diagnostics: PromptLoaderDiagnostic[];
}

function createDiagnostic(
	code: string,
	filePath: string,
	source: PromptSource,
	message: string,
): PromptLoaderDiagnostic {
	return {
		code,
		message,
		filePath,
		source,
		key: `${code}:${filePath}:${message}`,
	};
}

function lexicalCompare(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function normalizeStringField(
	field: string,
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: expected a string.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function isValidModelSelectionSpec(spec: string): boolean {
	if (!spec || spec.includes("*") || /\s/.test(spec)) return false;

	const segments = spec.split("/");
	if (segments.length === 1) return true;
	if (segments.length !== 2) return false;
	return segments[0].length > 0 && segments[1].length > 0;
}

function normalizeFrontmatterRecord(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-frontmatter",
			filePath,
			source,
			`Skipping prompt template at ${filePath}: frontmatter must be a key-value object.`,
		),
	);
	return undefined;
}

function normalizeModelSpecs(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-model",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter field "model" must be a string.`,
			),
		);
		return undefined;
	}

	const models = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	if (models.length === 0) {
		diagnostics.push(
			createDiagnostic(
				"empty-model",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter field "model" is empty.`,
			),
		);
		return undefined;
	}

	const invalidSpec = models.find((model) => !isValidModelSelectionSpec(model));
	if (invalidSpec) {
		diagnostics.push(
			createDiagnostic(
				"invalid-model-spec",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: invalid model spec ${JSON.stringify(invalidSpec)} in frontmatter field "model".`,
			),
		);
		return undefined;
	}

	return models;
}

function normalizeRestore(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-restore",
			filePath,
			source,
			`Using default restore=true for ${filePath}: frontmatter field "restore" must be true or false.`,
		),
	);
	return true;
}

function normalizeThinking(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): ThinkingLevel | undefined {
	const thinking = normalizeStringField("thinking", value, filePath, source, diagnostics);
	if (thinking === undefined) return undefined;

	const normalized = thinking.toLowerCase();
	if ((VALID_THINKING_LEVELS as readonly string[]).includes(normalized)) {
		return normalized as ThinkingLevel;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-thinking",
			filePath,
			source,
			`Ignoring invalid thinking level in ${filePath}: ${JSON.stringify(thinking)}.`,
		),
	);
	return undefined;
}

function loadPromptsWithModelFromDir(
	dir: string,
	source: PromptSource,
	subdir = "",
	visitedDirectories = new Set<string>(),
): { prompts: PromptWithModel[]; diagnostics: PromptLoaderDiagnostic[] } {
	const prompts: PromptWithModel[] = [];
	const diagnostics: PromptLoaderDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { prompts, diagnostics };
	}

	let canonicalDir: string;
	try {
		canonicalDir = realpathSync(dir);
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : "failed to resolve directory"}.`,
			),
		);
		return { prompts, diagnostics };
	}

	if (visitedDirectories.has(canonicalDir)) {
		diagnostics.push(
			createDiagnostic(
				"directory-cycle",
				dir,
				source,
				`Skipping already visited prompt directory at ${dir}.`,
			),
		);
		return { prompts, diagnostics };
	}

	visitedDirectories.add(canonicalDir);

	try {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => lexicalCompare(a.name, b.name));

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
					isDirectory = stats.isDirectory();
				} catch {
					diagnostics.push(
						createDiagnostic(
							"unreadable-symlink",
							fullPath,
							source,
							`Skipping unreadable symlink at ${fullPath}.`,
						),
					);
					continue;
				}
			}

			if (isDirectory) {
				const nextSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
				const nested = loadPromptsWithModelFromDir(fullPath, source, nextSubdir, visitedDirectories);
				prompts.push(...nested.prompts);
				diagnostics.push(...nested.diagnostics);
				continue;
			}

			if (!isFile || !entry.name.endsWith(".md")) continue;

			try {
				const rawContent = readFileSync(fullPath, "utf-8");
				const parsed = parseFrontmatter<Record<string, unknown>>(rawContent);
				const frontmatter = normalizeFrontmatterRecord(parsed.frontmatter, fullPath, source, diagnostics);
				if (!frontmatter) continue;
				const { body } = parsed;
				const models = normalizeModelSpecs(frontmatter.model, fullPath, source, diagnostics);
				if (!models) continue;

				const name = entry.name.slice(0, -3);
				if (RESERVED_COMMAND_NAMES.has(name)) {
					diagnostics.push(
						createDiagnostic(
							"reserved-command-name",
							fullPath,
							source,
							`Skipping prompt template at ${fullPath}: command name "${name}" is reserved.`,
						),
					);
					continue;
				}

				const description = normalizeStringField("description", frontmatter.description, fullPath, source, diagnostics) ?? "";
				const skill = normalizeStringField("skill", frontmatter.skill, fullPath, source, diagnostics);
				const thinking = normalizeThinking(frontmatter.thinking, fullPath, source, diagnostics);
				const restore = normalizeRestore(frontmatter.restore, fullPath, source, diagnostics);

				prompts.push({
					name,
					description,
					content: body,
					models,
					restore,
					skill,
					thinking,
					source,
					subdir: subdir || undefined,
					filePath: fullPath,
				});
			} catch (error) {
				diagnostics.push(
					createDiagnostic(
						"invalid-prompt-file",
						fullPath,
						source,
						`Skipping prompt template at ${fullPath}: ${error instanceof Error ? error.message : "failed to parse file"}.`,
					),
				);
			}
		}
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : "failed to read directory"}.`,
			),
		);
	}

	return { prompts, diagnostics };
}

export function loadPromptsWithModel(cwd: string): LoadPromptsWithModelResult {
	const globalDir = join(homedir(), ".pi", "agent", "prompts");
	const projectDir = resolve(cwd, ".pi", "prompts");
	const promptMap = new Map<string, PromptWithModel>();
	const diagnostics: PromptLoaderDiagnostic[] = [];

	function addPrompt(prompt: PromptWithModel) {
		const existing = promptMap.get(prompt.name);
		if (!existing) {
			promptMap.set(prompt.name, prompt);
			return;
		}

		if (existing.source === prompt.source) {
			diagnostics.push(
				createDiagnostic(
					"duplicate-command-name",
					prompt.filePath,
					prompt.source,
					`Skipping ${prompt.source} prompt template "${prompt.name}" at ${prompt.filePath} because it conflicts with ${existing.filePath}.`,
				),
			);
			return;
		}

		promptMap.set(prompt.name, prompt);
	}

	const globalResult = loadPromptsWithModelFromDir(globalDir, "user");
	diagnostics.push(...globalResult.diagnostics);
	for (const prompt of globalResult.prompts) {
		addPrompt(prompt);
	}

	const projectResult = loadPromptsWithModelFromDir(projectDir, "project");
	diagnostics.push(...projectResult.diagnostics);
	for (const prompt of projectResult.prompts) {
		addPrompt(prompt);
	}

	return { prompts: promptMap, diagnostics };
}

export function buildPromptCommandDescription(prompt: PromptWithModel): string {
	const sourceLabel = prompt.subdir ? `(${prompt.source}:${prompt.subdir})` : `(${prompt.source})`;
	const modelLabel = prompt.models.map((model) => model.split("/").pop() || model).join("|");
	const skillLabel = prompt.skill ? ` +${prompt.skill}` : "";
	const thinkingLabel = prompt.thinking ? ` ${prompt.thinking}` : "";
	const details = `[${modelLabel}${thinkingLabel}${skillLabel}] ${sourceLabel}`;
	return prompt.description ? `${prompt.description} ${details}` : details;
}

export function resolveSkillPath(skillName: string, cwd: string): string | undefined {
	const projectPath = resolve(cwd, ".pi", "skills", skillName, "SKILL.md");
	if (existsSync(projectPath)) return projectPath;

	const userPath = join(homedir(), ".pi", "agent", "skills", skillName, "SKILL.md");
	if (existsSync(userPath)) return userPath;

	return undefined;
}

export function readSkillContent(skillPath: string): string | undefined {
	try {
		const raw = readFileSync(skillPath, "utf-8");
		return parseFrontmatter(raw).body;
	} catch {
		return undefined;
	}
}
