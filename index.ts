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

interface PendingSkillMessage {
	customType: "skill-loaded";
	content: string;
	display: true;
	details: SkillLoadedDetails;
}

type SkillMessageResolution =
	| { kind: "none" }
	| { kind: "ready"; message: PendingSkillMessage }
	| { kind: "error"; error: string };

interface ExecutionErrorState {
	hasError: boolean;
	error: unknown;
}

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let previousModel: Model<any> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let pendingSkillMessage: PendingSkillMessage | undefined;
	let runtimeModel: Model<any> | undefined;
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

	function getCurrentModel(ctx: Pick<ExtensionContext, "model">): Model<any> | undefined {
		return runtimeModel ?? ctx.model;
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

	function consumePendingSkillMessage() {
		if (!pendingSkillMessage) return undefined;
		const message = pendingSkillMessage;
		pendingSkillMessage = undefined;
		return message;
	}

	function normalizeSkillName(skillName: string): string {
		return skillName.startsWith("skill:") ? skillName.slice("skill:".length) : skillName;
	}

	function isPathResolvableSkillName(skillName: string): boolean {
		if (skillName === "." || skillName === "..") return false;
		if (skillName.includes("/")) return false;
		if (skillName.includes("\\")) return false;
		return true;
	}

	function resolveRegisteredSkillPath(skillName: string): string | undefined {
		const normalizedSkillName = normalizeSkillName(skillName);
		if (!normalizedSkillName) return undefined;
		const candidates = new Set([normalizedSkillName, `skill:${normalizedSkillName}`]);

		for (const command of pi.getCommands()) {
			if (command.source !== "skill") continue;
			if (!command.path) continue;
			if (!candidates.has(command.name)) continue;
			return command.path;
		}

		return undefined;
	}

	function resolveSkillMessage(skillName: string | undefined, cwd: string): SkillMessageResolution {
		if (!skillName) {
			return { kind: "none" };
		}

		const normalizedSkillName = normalizeSkillName(skillName);
		if (!normalizedSkillName) {
			return { kind: "error", error: `Skill "${skillName}" not found` };
		}

		const skillPath =
			resolveRegisteredSkillPath(skillName) ?? (isPathResolvableSkillName(normalizedSkillName) ? resolveSkillPath(normalizedSkillName, cwd) : undefined);
		if (!skillPath) {
			return { kind: "error", error: `Skill "${skillName}" not found` };
		}

		try {
			const skillContent = readSkillContent(skillPath);
			return {
				kind: "ready",
				message: {
					customType: "skill-loaded",
					content: `<skill name="${normalizedSkillName}">\n${skillContent}\n</skill>`,
					display: true,
					details: { skillName: normalizedSkillName, skillContent, skillPath },
				},
			};
		} catch (error) {
			return {
				kind: "error",
				error: `Failed to read skill "${skillName}": ${error instanceof Error ? error.message : String(error)}`,
			};
		}
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
		const shouldRestoreThinking =
			originalThinking !== undefined && (currentThinking === undefined || currentThinking !== originalThinking);

		if (originalModel && !sameModel(originalModel, currentModel)) {
			const restoredModel = await pi.setModel(originalModel);
			if (restoredModel) {
				runtimeModel = originalModel;
				restoredParts.push(originalModel.id);
			} else {
				notify(ctx, `Failed to restore model ${originalModel.provider}/${originalModel.id}`, "error");
			}
		}
		if (shouldRestoreThinking) {
			restoredParts.push(`thinking:${originalThinking}`);
			pi.setThinkingLevel(originalThinking);
		}
		if (restoredParts.length > 0) {
			notify(ctx, `Restored to ${restoredParts.join(", ")}`, "info");
		}
	}

	async function restoreAfterExecution(
		ctx: ExtensionContext,
		shouldRestore: boolean,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel: Model<any> | undefined,
		currentThinking: ThinkingLevel | undefined,
		errorState: ExecutionErrorState,
		phase: "loop" | "chain",
	): Promise<ExecutionErrorState> {
		if (!shouldRestore) return errorState;

		try {
			await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
		} catch (error) {
			if (errorState.hasError) {
				notify(
					ctx,
					`Failed to restore session state after ${phase} error: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return errorState;
			}
			return { hasError: true, error };
		}

		return errorState;
	}

	function notifyLoopCompletion(
		ctx: ExtensionContext,
		completedIterations: number,
		totalIterations: number | null,
		effectiveMax: number,
		converged: boolean,
		requireMultipleIterations: boolean,
	) {
		if (converged) {
			const convergedLabel = totalIterations !== null ? `${completedIterations}/${totalIterations}` : `${completedIterations}`;
			notify(ctx, `Loop converged at ${convergedLabel} (no changes)`, "info");
			return;
		}

		if (completedIterations === 0) return;
		if (requireMultipleIterations && effectiveMax <= 1) return;

		if (totalIterations !== null) {
			notify(ctx, `Loop finished: ${completedIterations}/${totalIterations} iterations`, "info");
			return;
		}
		if (completedIterations === effectiveMax) {
			notify(ctx, `Loop finished: ${completedIterations} iterations (cap reached)`, "info");
			return;
		}
		notify(ctx, `Loop finished: ${completedIterations} iterations`, "info");
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

		const savedModel = getCurrentModel(ctx);
		const savedThinking = pi.getThinkingLevel();
		let currentModel = savedModel;
		let currentThinking = savedThinking;
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
		let loopErrorState: ExecutionErrorState = { hasError: false, error: undefined };

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

				const prepared = await preparePromptExecution(prompt, parseCommandArgs(cleanedArgs), currentModel, ctx.modelRegistry);
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

				const skillResolution = resolveSkillMessage(prompt.skill, ctx.cwd);
				if (skillResolution.kind === "error") {
					notify(ctx, skillResolution.error, "error");
					break;
				}

				if (!prepared.selectedModel.alreadyActive) {
					const switched = await pi.setModel(prepared.selectedModel.model);
					if (!switched) {
						notify(ctx, `Failed to switch to model ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, "error");
						break;
					}
					runtimeModel = prepared.selectedModel.model;
				}
				currentModel = prepared.selectedModel.model;
				currentThinking = pi.getThinkingLevel();

				if (prompt.thinking) {
					pi.setThinkingLevel(prompt.thinking);
					currentThinking = pi.getThinkingLevel();
				}

				pendingSkillMessage = skillResolution.kind === "ready" ? skillResolution.message : undefined;
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
		} catch (error) {
			loopErrorState = { hasError: true, error };
		} finally {
			loopErrorState = await restoreAfterExecution(
				ctx,
				shouldRestore,
				savedModel,
				savedThinking,
				currentModel,
				currentThinking,
				loopErrorState,
				"loop",
			);

			loopState = null;
			pendingSkillMessage = undefined;
			freshCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);

			if (!loopErrorState.hasError) {
				notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, false);
			}
		}

		if (loopErrorState.hasError) {
			throw loopErrorState.error;
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
				const stepPrompt = prompts.get(step.name);
				if (!stepPrompt) continue;
				if (stepPrompt.chain) {
					notify(ctx, `Step "${step.name}" is a chain template. Chain nesting is not supported.`, "error");
					return false;
				}
			}

			return true;
		};

		if (!validateChainSteps()) return;

		const originalModel = getCurrentModel(ctx);
		const chainInheritedModel = getCurrentModel(ctx);
		const originalThinking = pi.getThinkingLevel();
		let currentModel = originalModel;
		let currentThinking = originalThinking;
		chainActive = true;
		pendingSkillMessage = undefined;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = isUnlimited ? true : converge;

		const anchorId = fresh ? ctx.sessionManager.getLeafId() : null;
		const chainStepNames = steps.map((step) => step.name).join(" -> ");
		let completedIterations = 0;
		let converged = false;
		let chainErrorState: ExecutionErrorState = { hasError: false, error: undefined };
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

							const prepared = await preparePromptExecution(template, effectiveArgs, currentModel, ctx.modelRegistry, {
								inheritedModel: chainInheritedModel,
							});
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

							const skillResolution = resolveSkillMessage(template.skill, ctx.cwd);
							if (skillResolution.kind === "error") {
								notify(ctx, `Step ${stepNumber}/${templates.length} failed: ${skillResolution.error}`, "error");
								aborted = true;
								break;
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
								runtimeModel = prepared.selectedModel.model;
							}

							currentModel = prepared.selectedModel.model;
							currentThinking = pi.getThinkingLevel();
							if (template.thinking) {
								pi.setThinkingLevel(template.thinking);
								currentThinking = pi.getThinkingLevel();
							}
							pendingSkillMessage = skillResolution.kind === "ready" ? skillResolution.message : undefined;

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

		} catch (error) {
			chainErrorState = { hasError: true, error };
		} finally {
			chainErrorState = await restoreAfterExecution(
				ctx,
				shouldRestore,
				originalModel,
				originalThinking,
				currentModel,
				currentThinking,
				chainErrorState,
				"chain",
			);

			pendingSkillMessage = undefined;
			chainActive = false;
			loopState = null;
			freshCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);

			if (!chainErrorState.hasError) {
				notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, true);
			}
		}

		if (chainErrorState.hasError) {
			throw chainErrorState.error;
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

		const savedModel = getCurrentModel(ctx);
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

		const skillResolution = resolveSkillMessage(prompt.skill, ctx.cwd);
		if (skillResolution.kind === "error") {
			notify(ctx, skillResolution.error, "error");
			return;
		}

		if (!prepared.selectedModel.alreadyActive) {
			const switched = await pi.setModel(prepared.selectedModel.model);
			if (!switched) {
				notify(ctx, `Failed to switch to model ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, "error");
				return;
			}
			runtimeModel = prepared.selectedModel.model;
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
		pendingSkillMessage = skillResolution.kind === "ready" ? skillResolution.message : undefined;

		pi.sendUserMessage(prepared.content);
		await waitForTurnStart(ctx);
		await ctx.waitForIdle();
	}

	function resetSessionScopedState(ctx: ExtensionContext) {
		storedCommandCtx = null;
		pendingSkillMessage = undefined;
		previousModel = undefined;
		previousThinking = undefined;
		runtimeModel = ctx.model;
		toolManager.clearQueue();
		refreshPrompts(ctx.cwd, ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetSessionScopedState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetSessionScopedState(ctx);
	});

	pi.on("model_select", async (event) => {
		runtimeModel = event.model;
	});

	pi.on("before_agent_start", async (event) => {
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

		const skillMessage = consumePendingSkillMessage();
		const hasSystemPromptOverride = systemPrompt !== event.systemPrompt;
		if (!hasSystemPromptOverride && !skillMessage) return;

		return {
			...(hasSystemPromptOverride ? { systemPrompt } : {}),
			...(skillMessage ? { message: skillMessage } : {}),
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (chainActive) return;
		if (loopState) return;

		runtimeModel = ctx.model;

		const restoreModel = previousModel;
		const restoreThinking = previousThinking;
		previousModel = undefined;
		previousThinking = undefined;

		const restoreFn = async () => {
			if (restoreModel || restoreThinking !== undefined) {
				await restoreSessionState(ctx, restoreModel, restoreThinking, getCurrentModel(ctx), pi.getThinkingLevel());
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
