import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { extractLoopCount, extractLoopFlags, parseCommandArgs } from "./args.js";
import { parseChainSteps, parseChainDeclaration, type ChainStep } from "./chain-parser.js";
import { generateIterationSummary, didIterationMakeChanges, getIterationEntries } from "./loop-utils.js";
import { notify, summarizePromptDiagnostics, diagnosticsFingerprint } from "./notifications.js";
import { preparePromptExecution } from "./prompt-execution.js";
import { buildPromptCommandDescription, loadPromptsWithModel, readSkillContent, resolveSkillPath, type PromptWithModel } from "./prompt-loader.js";
import { renderSkillLoaded, type SkillLoadedDetails } from "./skill-loaded-renderer.js";
import { createToolManager } from "./tool-manager.js";

interface LoopState {
	currentIteration: number;
	totalIterations: number | null;
}

interface FreshCollapse {
	targetId: string;
	task: string;
	iteration: number;
	totalIterations: number | null;
}

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let previousModel: Model<any> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let pendingSkill: { name: string; cwd: string } | undefined;
	let chainActive = false;
	let loopState: LoopState | null = null;
	let freshCollapse: FreshCollapse | null = null;
	let accumulatedSummaries: string[] = [];
	let lastDiagnostics = "";
	let storedCommandCtx: ExtensionCommandContext | null = null;
	const UNLIMITED_LOOP_CAP = 50;

	const toolManager = createToolManager(pi, {
		isActive: () => !!(loopState || chainActive),
		getStoredCtx: () => storedCommandCtx,
		setStoredCtx: (ctx) => {
			storedCommandCtx = ctx;
		},
		executeCommand: executeToolCommand,
	});

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

	function updateLoopStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (loopState) {
			const label =
				loopState.totalIterations !== null
					? `loop ${loopState.currentIteration}/${loopState.totalIterations}`
					: `loop ${loopState.currentIteration}`;
			ctx.ui.setStatus("prompt-loop", ctx.ui.theme.fg("warning", label));
		} else {
			ctx.ui.setStatus("prompt-loop", undefined);
		}
	}

	async function executeToolCommand(command: string, ctx: ExtensionCommandContext) {
		const stripped = command.startsWith("/") ? command.slice(1) : command;
		const spaceIdx = stripped.indexOf(" ");
		const name = spaceIdx >= 0 ? stripped.slice(0, spaceIdx) : stripped;
		const args = spaceIdx >= 0 ? stripped.slice(spaceIdx + 1) : "";

		if (name === "chain-prompts") {
			await runChainCommand(args, ctx);
		} else {
			await runPromptCommand(name, args, ctx);
		}
	}

	async function runPromptLoop(
		name: string,
		cleanedArgs: string,
		totalIterations: number | null,
		freshFlag: boolean,
		converge: boolean,
		ctx: ExtensionCommandContext,
	) {
		refreshPrompts(ctx.cwd, ctx);
		const initialPrompt = prompts.get(name);
		if (!initialPrompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		const savedModel = ctx.model;
		const savedThinking = pi.getThinkingLevel();
		const shouldRestore = initialPrompt.restore;
		const useFresh = freshFlag || initialPrompt.fresh === true;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = isUnlimited ? true : converge && initialPrompt.converge !== false;
		const anchorId = useFresh ? ctx.sessionManager.getLeafId() : null;

		loopState = { currentIteration: 1, totalIterations };
		accumulatedSummaries = [];
		updateLoopStatus(ctx);
		let completedIterations = 0;
		let converged = false;

		try {
			for (let i = 0; i < effectiveMax; i++) {
				loopState.currentIteration = i + 1;
				updateLoopStatus(ctx);
				const iterationLabel = totalIterations !== null ? `${i + 1}/${totalIterations}` : `${i + 1}`;
				notify(ctx, `Loop ${iterationLabel}: ${name}`, "info");

				refreshPrompts(ctx.cwd, ctx);
				const prompt = prompts.get(name);
				if (!prompt) {
					notify(ctx, `Prompt "${name}" no longer exists`, "error");
					break;
				}

				const prepared = await preparePromptExecution(prompt, parseCommandArgs(cleanedArgs), ctx.model, ctx.modelRegistry);
				if (!prepared) {
					notify(ctx, `No available model from: ${prompt.models.join(", ")}`, "error");
					break;
				}
				if ("message" in prepared) {
					if (prepared.warning) notify(ctx, prepared.warning, "warning");
					notify(ctx, prepared.message, "error");
					break;
				}
				if (prepared.warning) {
					notify(ctx, prepared.warning, "warning");
				}

				if (!prepared.selectedModel.alreadyActive) {
					const switched = await pi.setModel(prepared.selectedModel.model);
					if (!switched) {
						notify(ctx, `Failed to switch to model ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, "error");
						break;
					}
				}

				if (prompt.thinking) {
					pi.setThinkingLevel(prompt.thinking);
				}

				pendingSkill = prompt.skill ? { name: prompt.skill, cwd: ctx.cwd } : undefined;
				const iterationStartId = ctx.sessionManager.getLeafId();

				pi.sendUserMessage(prepared.content);
				await waitForTurnStart(ctx);
				await ctx.waitForIdle();
				completedIterations++;

				if (useConverge && (isUnlimited || effectiveMax > 1) && !didIterationMakeChanges(getIterationEntries(ctx, iterationStartId))) {
					converged = true;
					break;
				}

				if (anchorId && i < effectiveMax - 1) {
					freshCollapse = { targetId: anchorId, task: name, iteration: i + 1, totalIterations };
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					freshCollapse = null;
					if (result.cancelled) {
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}
		} finally {
			loopState = null;
			pendingSkill = undefined;
			freshCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);

			if (converged) {
				const convergedLabel = totalIterations !== null ? `${completedIterations}/${totalIterations}` : `${completedIterations}`;
				notify(ctx, `Loop converged at ${convergedLabel} (no changes)`, "info");
			} else if (completedIterations > 0) {
				if (totalIterations !== null) {
					notify(ctx, `Loop finished: ${completedIterations}/${totalIterations} iterations`, "info");
				} else if (completedIterations === effectiveMax) {
					notify(ctx, `Loop finished: ${completedIterations} iterations (cap reached)`, "info");
				} else {
					notify(ctx, `Loop finished: ${completedIterations} iterations`, "info");
				}
			}

			if (shouldRestore) {
				await restoreSessionState(ctx, savedModel, savedThinking, ctx.model, pi.getThinkingLevel());
			}
		}
	}

	async function runSharedChainExecution(
		steps: ChainStep[],
		sharedArgs: string[],
		totalIterations: number | null,
		fresh: boolean,
		converge: boolean,
		shouldRestore: boolean,
		ctx: ExtensionCommandContext,
	) {
		const validateChainSteps = (): boolean => {
			const missingTemplates = steps.filter((step) => !prompts.has(step.name));
			if (missingTemplates.length > 0) {
				notify(ctx, `Templates not found: ${missingTemplates.map((step) => step.name).join(", ")}`, "error");
				return false;
			}

			for (const step of steps) {
				if (prompts.get(step.name)?.chain) {
					notify(ctx, `Step "${step.name}" is a chain template. Chain nesting is not supported.`, "error");
					return false;
				}
			}

			return true;
		};

		if (!validateChainSteps()) return;

		const originalModel = ctx.model;
		const originalThinking = pi.getThinkingLevel();
		let currentModel = originalModel;
		let currentThinking = originalThinking;
		chainActive = true;
		pendingSkill = undefined;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = isUnlimited ? true : converge;

		const anchorId = fresh ? ctx.sessionManager.getLeafId() : null;
		const chainStepNames = steps.map((step) => step.name).join(" -> ");
		let completedIterations = 0;
		let converged = false;
		if (effectiveMax > 1) {
			loopState = { currentIteration: 1, totalIterations };
			accumulatedSummaries = [];
			updateLoopStatus(ctx);
		}

		try {
			for (let iteration = 0; iteration < effectiveMax; iteration++) {
				if (effectiveMax > 1) {
					loopState!.currentIteration = iteration + 1;
					updateLoopStatus(ctx);
					refreshPrompts(ctx.cwd, ctx);
					if (!validateChainSteps()) break;
				}

				const iterationStartId = ctx.sessionManager.getLeafId();
				const templates = steps.map((step) => ({
					...prompts.get(step.name)!,
					stepArgs: step.args,
					stepLoop: step.loopCount ?? 1,
				}));
				let aborted = false;

				for (const [index, template] of templates.entries()) {
					const stepNumber = index + 1;
					const stepLoop = template.stepLoop;
					const effectiveArgs = template.stepArgs.length > 0 ? template.stepArgs : sharedArgs;
					const outerLoopState = loopState ? { ...loopState } : null;
					if (stepLoop > 1) {
						loopState = { currentIteration: 1, totalIterations: stepLoop };
						updateLoopStatus(ctx);
					}

					try {
						for (let stepIteration = 0; stepIteration < stepLoop; stepIteration++) {
							if (stepLoop > 1) {
								loopState = { currentIteration: stepIteration + 1, totalIterations: stepLoop };
								updateLoopStatus(ctx);
							}

							const loopPrefix =
								effectiveMax > 1
									? totalIterations !== null
										? `Loop ${iteration + 1}/${totalIterations}, `
										: `Loop ${iteration + 1}, `
									: "";
							const iterSuffix = stepLoop > 1 ? ` (iter ${stepIteration + 1}/${stepLoop})` : "";
							notify(ctx, `${loopPrefix}Step ${stepNumber}/${templates.length}: ${template.name}${iterSuffix} ${buildPromptCommandDescription(template)}`, "info");

							const prepared = await preparePromptExecution(template, effectiveArgs, currentModel, ctx.modelRegistry);
							if (!prepared) {
								notify(
									ctx,
									`Step ${stepNumber}/${templates.length} failed: no available model from ${template.models.join(", ")}`,
									"error",
								);
								aborted = true;
								break;
							}
							if ("message" in prepared) {
								if (prepared.warning) notify(ctx, prepared.warning, "warning");
								notify(ctx, `Step ${stepNumber}/${templates.length} failed: ${prepared.message}`, "error");
								aborted = true;
								break;
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
									aborted = true;
									break;
								}
							}

							currentModel = prepared.selectedModel.model;
							currentThinking = pi.getThinkingLevel();
							if (template.thinking) {
								pi.setThinkingLevel(template.thinking);
								currentThinking = pi.getThinkingLevel();
							}
							pendingSkill = template.skill ? { name: template.skill, cwd: ctx.cwd } : undefined;

							const stepIterationStartId = ctx.sessionManager.getLeafId();
							pi.sendUserMessage(prepared.content);
							await waitForTurnStart(ctx);
							await ctx.waitForIdle();

							if (stepLoop > 1 && template.converge !== false && !didIterationMakeChanges(getIterationEntries(ctx, stepIterationStartId))) {
								break;
							}
						}
					} finally {
						if (stepLoop > 1) {
							loopState = outerLoopState ? { ...outerLoopState } : null;
							updateLoopStatus(ctx);
						}
					}

					if (aborted) break;
				}

				if (aborted) break;
				completedIterations++;

				if (useConverge && (isUnlimited || effectiveMax > 1) && !didIterationMakeChanges(getIterationEntries(ctx, iterationStartId))) {
					converged = true;
					break;
				}

				if (anchorId && iteration < effectiveMax - 1) {
					freshCollapse = { targetId: anchorId, task: chainStepNames, iteration: iteration + 1, totalIterations };
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					freshCollapse = null;
					if (result.cancelled) {
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}

			if (shouldRestore) {
				await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
			}
		} finally {
			pendingSkill = undefined;
			chainActive = false;
			loopState = null;
			freshCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);

			if (converged) {
				const convergedLabel = totalIterations !== null ? `${completedIterations}/${totalIterations}` : `${completedIterations}`;
				notify(ctx, `Loop converged at ${convergedLabel} (no changes)`, "info");
			} else if (effectiveMax > 1 && completedIterations > 0) {
				if (totalIterations !== null) {
					notify(ctx, `Loop finished: ${completedIterations}/${totalIterations} iterations`, "info");
				} else if (completedIterations === effectiveMax) {
					notify(ctx, `Loop finished: ${completedIterations} iterations (cap reached)`, "info");
				} else {
					notify(ctx, `Loop finished: ${completedIterations} iterations`, "info");
				}
			}
		}
	}

	async function runPromptCommand(name: string, args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);
		const prompt = prompts.get(name);
		if (!prompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		if (prompt.chain) {
			const loop = extractLoopCount(args);
			let totalIterations: number | null = prompt.loop ?? 1;
			let fresh = false;
			let converge = true;
			let cleanedArgs = args;

			if (loop) {
				totalIterations = loop.loopCount;
				fresh = loop.fresh;
				converge = loop.converge;
				cleanedArgs = loop.args;
			} else if (prompt.loop !== undefined) {
				const flags = extractLoopFlags(args);
				fresh = flags.fresh;
				converge = flags.converge;
				cleanedArgs = flags.args;
			}

			const { steps, invalidSegments } = parseChainDeclaration(prompt.chain);
			if (invalidSegments.length > 0) {
				notify(ctx, `Invalid chain step: ${invalidSegments[0]}`, "error");
				return;
			}
			if (steps.length === 0) {
				notify(ctx, "No templates specified", "error");
				return;
			}

			await runSharedChainExecution(
				steps,
				parseCommandArgs(cleanedArgs),
				totalIterations,
				fresh || prompt.fresh === true,
				converge && prompt.converge !== false,
				prompt.restore,
				ctx,
			);
			return;
		}

		const loop = extractLoopCount(args);
		if (loop) {
			await runPromptLoop(name, loop.args, loop.loopCount, loop.fresh, loop.converge, ctx);
			return;
		}

		if (prompt.loop !== undefined) {
			const flags = extractLoopFlags(args);
			await runPromptLoop(name, flags.args, prompt.loop, flags.fresh, flags.converge, ctx);
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

	pi.on("session_start", async (_event, ctx) => {
		storedCommandCtx = null;
		toolManager.clearQueue();
		refreshPrompts(ctx.cwd, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		storedCommandCtx = null;
		toolManager.clearQueue();
		refreshPrompts(ctx.cwd, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		let systemPrompt = event.systemPrompt;

		if (toolManager.isEnabled() && !loopState && !chainActive) {
			const toolGuidance = toolManager.getGuidance();
			const guidance = toolGuidance
				? `The run-prompt tool is available for running prompt template commands. ${toolGuidance}`
				: "The run-prompt tool is available for running prompt template commands.";
			systemPrompt += `\n\n${guidance}`;
		}

		if (loopState) {
			const iterText =
				loopState.totalIterations !== null
					? `iteration ${loopState.currentIteration} of ${loopState.totalIterations}`
					: `iteration ${loopState.currentIteration}`;
			systemPrompt += `\n\nYou are on ${iterText} of the same prompt. Previous iterations and their results are visible in the conversation above. Build on that work — focus on what remains to improve.`;
		}

		if (pendingSkill) {
			const { name: skillName, cwd } = pendingSkill;
			pendingSkill = undefined;

			const skillPath = resolveSkillPath(skillName, cwd);
			if (skillPath) {
				try {
					const skillContent = readSkillContent(skillPath);
					pi.sendMessage<SkillLoadedDetails>({
						customType: "skill-loaded",
						content: `Loaded skill: ${skillName}`,
						display: true,
						details: { skillName, skillContent, skillPath },
					});
					systemPrompt += `\n\n<skill name="${skillName}">\n${skillContent}\n</skill>`;
				} catch (error) {
					notify(ctx, `Failed to read skill "${skillName}": ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			} else {
				notify(ctx, `Skill "${skillName}" not found`, "error");
			}
		}

		if (systemPrompt !== event.systemPrompt) {
			return { systemPrompt };
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (chainActive) return;
		if (loopState) return;

		const restoreModel = previousModel;
		const restoreThinking = previousThinking;
		previousModel = undefined;
		previousThinking = undefined;

		const restoreFn = async () => {
			if (restoreModel || restoreThinking !== undefined) {
				await restoreSessionState(ctx, restoreModel, restoreThinking, ctx.model, pi.getThinkingLevel());
			}
		};
		const processed = await toolManager.processQueue(ctx, restoreFn);
		if (processed) return;
		await restoreFn();
	});

	pi.on("session_before_tree", async (event) => {
		if (!freshCollapse) return;
		if (event.preparation.targetId !== freshCollapse.targetId) return;

		const summary = generateIterationSummary(
			event.preparation.entriesToSummarize,
			freshCollapse.task,
			freshCollapse.iteration,
			freshCollapse.totalIterations,
		);
		accumulatedSummaries.push(summary);

		return {
			summary: {
				summary: accumulatedSummaries.join("\n\n---\n\n"),
			},
		};
	});

	async function runChainCommand(args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);

		const loop = extractLoopCount(args);
		const cleanedArgs = loop ? loop.args : args;

		const { steps, sharedArgs, invalidSegments } = parseChainSteps(cleanedArgs);
		if (invalidSegments.length > 0) {
			notify(ctx, `Invalid chain step: ${invalidSegments[0]}`, "error");
			return;
		}
		if (steps.length === 0) {
			notify(ctx, "No templates specified", "error");
			return;
		}

		await runSharedChainExecution(steps, sharedArgs, loop ? loop.loopCount : 1, loop?.fresh === true, loop?.converge ?? true, true, ctx);
	}

	refreshPrompts(process.cwd());
	if (toolManager.isEnabled()) toolManager.ensureRegistered();

	pi.registerCommand("chain-prompts", {
		description: "Chain prompt templates sequentially [template -> template -> ...]",
		handler: async (args, ctx) => {
			await runChainCommand(args, ctx);
		},
	});
	toolManager.registerCommand();
}
