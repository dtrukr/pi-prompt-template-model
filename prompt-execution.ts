import type { Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { substituteArgs } from "./args.js";
import { getResolvedModelRef, selectModelCandidate, type SelectedModelCandidate } from "./model-selection.js";
import type { PromptWithModel } from "./prompt-loader.js";
import { renderTemplateConditionals } from "./template-conditionals.js";

export interface PreparedPromptExecution {
	selectedModel: SelectedModelCandidate;
	content: string;
	warning?: string;
}

export interface EmptyPromptAbort {
	message: string;
	warning?: string;
}

export async function preparePromptExecution(
	prompt: Pick<PromptWithModel, "name" | "content" | "models">,
	args: string[],
	currentModel: Model<any> | undefined,
	modelRegistry: Pick<ModelRegistry, "find" | "getAll" | "getAvailable" | "getApiKey" | "isUsingOAuth">,
): Promise<PreparedPromptExecution | EmptyPromptAbort | undefined> {
	const selectedModel = await selectModelCandidate(prompt.models, currentModel, modelRegistry);
	if (!selectedModel) return undefined;

	const rendered = renderTemplateConditionals(prompt.content, getResolvedModelRef(selectedModel.model), prompt.name);
	const content = substituteArgs(rendered.content, args);
	if (content.trim().length === 0) {
		return {
			message: `Prompt \`${prompt.name}\` rendered to an empty message.`,
			warning: rendered.error,
		};
	}

	return {
		selectedModel,
		content,
		warning: rendered.error,
	};
}
