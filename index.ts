import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { parseCommandArgs } from "./args.js";
import { notify, summarizePromptDiagnostics, diagnosticsFingerprint } from "./notifications.js";
import { preparePromptExecution } from "./prompt-execution.js";
import { buildPromptCommandDescription, loadPromptsWithModel, readSkillContent, resolveSkillPath, type PromptWithModel } from "./prompt-loader.js";
import { renderSkillLoaded, type SkillLoadedDetails } from "./skill-loaded-renderer.js";

interface ChainStep {
	name: string;
	args: string[];
}

interface ParsedChainSteps {
	steps: ChainStep[];
	sharedArgs: string[];
	invalidSegments: string[];
}

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let previousModel: Model<any> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let pendingSkill: { name: string; cwd: string } | undefined;
	let chainActive = false;
	let lastDiagnostics = "";

	function sameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
		if (!a || !b) return a === b;
		return a.provider === b.provider && a.id === b.id;
	}

	pi.registerMessageRenderer<SkillLoadedDetails>("skill-loaded", renderSkillLoaded);

	function registerPromptCommand(name: string) {
		pi.registerCommand(name, {
			description: buildPromptCommandDescription(prompts.get(name)!),
			handler: async (args, ctx) => {
				await runPromptCommand(name, args, ctx);
			},
		});
	}

	function refreshPrompts(cwd: string, ctx?: ExtensionContext) {
		const result = loadPromptsWithModel(cwd);
		prompts = result.prompts;

		for (const name of prompts.keys()) {
			registerPromptCommand(name);
		}

		const summary = summarizePromptDiagnostics(result.diagnostics);
		const fingerprint = diagnosticsFingerprint(result.diagnostics);
		if (summary && fingerprint !== lastDiagnostics) {
			notify(ctx, summary, "warning");
		}
		lastDiagnostics = fingerprint;
	}

	async function waitForTurnStart(ctx: ExtensionContext) {
		while (ctx.isIdle()) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	async function restoreSessionState(
		ctx: ExtensionContext,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel?: Model<any>,
		currentThinking?: ThinkingLevel,
	) {
		pendingSkill = undefined;
		const restoredParts: string[] = [];
		const shouldRestoreModel = originalModel !== undefined && !sameModel(originalModel, currentModel);
		const shouldRestoreThinking =
			originalThinking !== undefined && (currentThinking === undefined || currentThinking !== originalThinking);

		if (shouldRestoreModel && originalModel) {
			const restoredModel = await pi.setModel(originalModel);
			if (restoredModel) {
				restoredParts.push(originalModel.id);
			} else {
				notify(ctx, `Failed to restore model ${originalModel.provider}/${originalModel.id}`, "error");
			}
		}
		if (shouldRestoreThinking && originalThinking !== undefined) {
			restoredParts.push(`thinking:${originalThinking}`);
			pi.setThinkingLevel(originalThinking);
		}
		if (restoredParts.length > 0) {
			notify(ctx, `Restored to ${restoredParts.join(", ")}`, "info");
		}
	}

	async function runPromptCommand(name: string, args: string, ctx: ExtensionCommandContext) {
		refreshPrompts(ctx.cwd, ctx);
		const prompt = prompts.get(name);
		if (!prompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		const savedModel = ctx.model;
		const savedThinking = pi.getThinkingLevel();
		const prepared = await preparePromptExecution(prompt, parseCommandArgs(args), savedModel, ctx.modelRegistry);
		if (!prepared) {
			notify(ctx, `No available model from: ${prompt.models.join(", ")}`, "error");
			return;
		}
		if ("message" in prepared) {
			if (prepared.warning) notify(ctx, prepared.warning, "warning");
			notify(ctx, prepared.message, "error");
			return;
		}
		if (prepared.warning) {
			notify(ctx, prepared.warning, "warning");
		}

		if (!prepared.selectedModel.alreadyActive) {
			const switched = await pi.setModel(prepared.selectedModel.model);
			if (!switched) {
				notify(ctx, `Failed to switch to model ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, "error");
				return;
			}
		}

		if (prompt.restore && !prepared.selectedModel.alreadyActive) {
			previousModel = savedModel;
			previousThinking = savedThinking;
		}
		if (prompt.thinking) {
			if (prompt.restore && previousThinking === undefined && prompt.thinking !== savedThinking) {
				previousThinking = savedThinking;
			}
			pi.setThinkingLevel(prompt.thinking);
		}
		pendingSkill = prompt.skill ? { name: prompt.skill, cwd: ctx.cwd } : undefined;

		pi.sendUserMessage(prepared.content);
		await waitForTurnStart(ctx);
		await ctx.waitForIdle();
	}

	function splitByUnquotedSeparator(input: string, separator: string): string[] {
		const parts: string[] = [];
		let start = 0;
		let inQuote: string | null = null;

		for (let i = 0; i < input.length; i++) {
			const char = input[i];
			if (inQuote) {
				if (char === inQuote) inQuote = null;
			} else if (char === '"' || char === "'") {
				inQuote = char;
			} else if (i <= input.length - separator.length && input.startsWith(separator, i)) {
				parts.push(input.slice(start, i));
				start = i + separator.length;
				i += separator.length - 1;
			}
		}

		parts.push(input.slice(start));
		return parts;
	}

	function parseChainSteps(args: string): ParsedChainSteps {
		const sharedArgsSplit = splitByUnquotedSeparator(args, " -- ");
		const templatesPart = sharedArgsSplit[0];
		const argsPart = sharedArgsSplit.length > 1 ? sharedArgsSplit.slice(1).join(" -- ") : "";

		const invalidSegments: string[] = [];
		const steps: ChainStep[] = [];

		for (const segment of splitByUnquotedSeparator(templatesPart, "->").map((value) => value.trim()).filter(Boolean)) {
			const tokens = parseCommandArgs(segment);
			if (tokens.length === 0) {
				invalidSegments.push(segment);
				continue;
			}
			steps.push({ name: tokens[0], args: tokens.slice(1) });
		}

		return { steps, sharedArgs: parseCommandArgs(argsPart), invalidSegments };
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshPrompts(ctx.cwd, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!pendingSkill) return;

		const { name: skillName, cwd } = pendingSkill;
		pendingSkill = undefined;

		const skillPath = resolveSkillPath(skillName, cwd);
		if (!skillPath) {
			notify(ctx, `Skill "${skillName}" not found`, "error");
			return;
		}

		const skillContent = readSkillContent(skillPath);
		if (skillContent === undefined) {
			notify(ctx, `Failed to read skill "${skillName}"`, "error");
			return;
		}

		pi.sendMessage<SkillLoadedDetails>({
			customType: "skill-loaded",
			content: `Loaded skill: ${skillName}`,
			display: true,
			details: {
				skillName,
				skillContent,
				skillPath,
			},
		});

		return {
			systemPrompt: `${event.systemPrompt}\n\n<skill name="${skillName}">\n${skillContent}\n</skill>`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (chainActive) return;

		const restoreModel = previousModel;
		const restoreThinking = previousThinking;
		previousModel = undefined;
		previousThinking = undefined;

		if (!restoreModel && restoreThinking === undefined) return;
		await restoreSessionState(ctx, restoreModel, restoreThinking, ctx.model, pi.getThinkingLevel());
	});

	refreshPrompts(process.cwd());

	pi.registerCommand("chain-prompts", {
		description: "Chain prompt templates sequentially [template -> template -> ...]",
		handler: async (args, ctx) => {
			refreshPrompts(ctx.cwd, ctx);
			const { steps, sharedArgs, invalidSegments } = parseChainSteps(args);
			if (invalidSegments.length > 0) {
				notify(ctx, `Invalid chain step: ${invalidSegments[0]}`, "error");
				return;
			}
			if (steps.length === 0) {
				notify(ctx, "No templates specified", "error");
				return;
			}

			const missingTemplates = steps.filter((step) => !prompts.has(step.name));
			if (missingTemplates.length > 0) {
				notify(ctx, `Templates not found: ${missingTemplates.map((step) => step.name).join(", ")}`, "error");
				return;
			}

			const templates = steps.map((step) => ({ ...prompts.get(step.name)!, stepArgs: step.args }));
			const originalModel = ctx.model;
			const originalThinking = pi.getThinkingLevel();
			let currentModel = originalModel;
			let currentThinking = originalThinking;
			chainActive = true;
			pendingSkill = undefined;

			try {
				for (const [index, template] of templates.entries()) {
					const stepNumber = index + 1;
					notify(
						ctx,
						`Step ${stepNumber}/${templates.length}: ${template.name} ${buildPromptCommandDescription(template)}`,
						"info",
					);

					const effectiveArgs = template.stepArgs.length > 0 ? template.stepArgs : sharedArgs;
					const prepared = await preparePromptExecution(template, effectiveArgs, currentModel, ctx.modelRegistry);
					if (!prepared) {
						notify(ctx, `Step ${stepNumber}/${templates.length} failed: no available model from ${template.models.join(", ")}`, "error");
						await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
						return;
					}
					if ("message" in prepared) {
						if (prepared.warning) notify(ctx, prepared.warning, "warning");
						notify(ctx, `Step ${stepNumber}/${templates.length} failed: ${prepared.message}`, "error");
						await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
						return;
					}
					if (prepared.warning) {
						notify(ctx, prepared.warning, "warning");
					}

					if (!prepared.selectedModel.alreadyActive) {
						const switched = await pi.setModel(prepared.selectedModel.model);
						if (!switched) {
							notify(
								ctx,
								`Step ${stepNumber}/${templates.length} failed: could not switch to ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`,
								"error",
							);
							await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
							return;
						}
					}

					currentModel = prepared.selectedModel.model;
					currentThinking = pi.getThinkingLevel();
					if (template.thinking) {
						pi.setThinkingLevel(template.thinking);
						currentThinking = pi.getThinkingLevel();
					}
					pendingSkill = template.skill ? { name: template.skill, cwd: ctx.cwd } : undefined;

					pi.sendUserMessage(prepared.content);
					await waitForTurnStart(ctx);
					await ctx.waitForIdle();
				}

				await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
			} finally {
				pendingSkill = undefined;
				chainActive = false;
			}
		},
	});
}
