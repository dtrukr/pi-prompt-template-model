import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";

export function generateIterationSummary(entries: SessionEntry[], task: string, iteration: number, totalIterations: number | null): string {
	const filesRead = new Set<string>();
	const filesWritten = new Set<string>();
	let commandCount = 0;
	let lastAssistantText = "";

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "assistant") continue;

		for (const block of (msg as AssistantMessage).content) {
			if (block.type === "text") {
				lastAssistantText = block.text;
			}
			if (block.type !== "toolCall") continue;
			if (block.name === "bash") {
				commandCount++;
				continue;
			}
			const path = (block.arguments as Record<string, unknown>).path as string | undefined;
			if (block.name === "read" && path) filesRead.add(path);
			if (block.name === "write" && path) filesWritten.add(path);
			if (block.name === "edit" && path) filesWritten.add(path);
		}
	}

	let summary = totalIterations !== null ? `[Loop iteration ${iteration}/${totalIterations}]\nTask: "${task}"` : `[Loop iteration ${iteration}]\nTask: "${task}"`;

	const actionParts: string[] = [];
	if (filesRead.size > 0) actionParts.push(`read ${filesRead.size} file(s)`);
	if (filesWritten.size > 0) actionParts.push(`modified ${[...filesWritten].join(", ")}`);
	if (commandCount > 0) actionParts.push(`ran ${commandCount} command(s)`);
	if (actionParts.length > 0) {
		summary += `\nActions: ${actionParts.join(", ")}.`;
	}

	if (lastAssistantText) {
		const cleaned = lastAssistantText.replace(/\n+/g, " ").trim();
		const truncated = cleaned.slice(0, 500);
		summary += `\nOutcome: ${truncated}${cleaned.length > 500 ? "..." : ""}`;
	}

	return summary;
}

export function didIterationMakeChanges(entries: SessionEntry[]): boolean {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "assistant") continue;
		for (const block of (entry.message as AssistantMessage).content) {
			if (block.type !== "toolCall") continue;
			if (block.name === "write" || block.name === "edit") return true;
		}
	}
	return false;
}

export function getIterationEntries(ctx: Pick<ExtensionContext, "sessionManager">, startId: string | null): SessionEntry[] {
	if (!startId) return [];
	const branch = ctx.sessionManager.getBranch();
	const startIdx = branch.findIndex((e) => e.id === startId);
	return startIdx >= 0 ? branch.slice(startIdx + 1) : [];
}
