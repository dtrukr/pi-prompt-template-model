import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";

const MODEL_ID = "claude-sonnet-4-20250514";
const ACTIVE_MODEL = { provider: "anthropic", id: MODEL_ID };

interface FakeCommand {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

interface FakeTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<any>;
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	tools = new Map<string, FakeTool>();
	events = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	userMessages: string[] = [];
	setModelCalls: string[] = [];
	currentModel = ACTIVE_MODEL;
	private thinking = "medium";

	registerMessageRenderer() {}

	registerCommand(name: string, command: FakeCommand) {
		this.commands.set(name, command);
	}

	registerTool(tool: FakeTool) {
		this.tools.set(tool.name, tool);
	}

	on(event: string, handler: (event: any, ctx: any) => Promise<any> | any) {
		const handlers = this.events.get(event) ?? [];
		handlers.push(handler);
		this.events.set(event, handlers);
	}

	async emit(event: string, payload: any, ctx: any) {
		for (const handler of this.events.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}

	async setModel(model: { provider: string; id: string }) {
		this.setModelCalls.push(`${model.provider}/${model.id}`);
		this.currentModel = model;
		return true;
	}

	getThinkingLevel() {
		return this.thinking;
	}

	setThinkingLevel(level: string) {
		this.thinking = level;
	}

	sendUserMessage(content: string) {
		this.userMessages.push(content);
	}

	sendMessage() {}
}

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-template-model-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function createContext(
	cwd: string,
	pi: FakePi,
	models: Array<{ provider: string; id: string }> = [ACTIVE_MODEL],
	options?: { branchEntries?: () => any[] },
) {
	let navigateCount = 0;
	const notifications: string[] = [];
	const modelRegistry = {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models;
		},
		async getApiKey() {
			return "token";
		},
		isUsingOAuth() {
			return false;
		},
	};

	const ctx = {
		cwd,
		get model() {
			return pi.currentModel;
		},
		modelRegistry,
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			theme: {
				fg(_token: string, text: string) {
					return text;
				},
			},
		},
		isIdle() {
			return false;
		},
		async waitForIdle() {},
		sessionManager: {
			getLeafId() {
				return "root";
			},
			getBranch() {
				return options?.branchEntries ? options.branchEntries() : [];
			},
		},
		async navigateTree() {
			navigateCount++;
			return { cancelled: false };
		},
	};

	return {
		ctx,
		getNavigateCount: () => navigateCount,
		getNotifications: () => notifications,
	};
}

test("bare --loop forces convergence on and ignores --no-converge", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("bounded --loop N runs requested iterations when no-converge is set", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 3 --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["ARGS:task", "ARGS:task", "ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop finished: 3\/3 iterations/);
	});
});

test("bare --loop stops at unlimited cap when each iteration makes changes", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const changedBranchEntries = () => [
			{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
			{
				id: "write-1",
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "write", arguments: { path: "src/file.ts" } }],
				},
			},
		];

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], { branchEntries: changedBranchEntries });
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop", ctx);

		assert.equal(pi.userMessages.length, 50);
		assert.match(getNotifications().join("\n"), /Loop finished: 50 iterations \(cap reached\)/);
	});
});

test("frontmatter loop executes without --loop and strips loop flags", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 3\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --fresh --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["ARGS:task", "ARGS:task", "ARGS:task"]);
		assert.equal(getNavigateCount(), 2);
	});
});

test("chain templates support bare --loop as unlimited with forced convergence", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\nconverge: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("task --loop --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("CLI --loop overrides frontmatter loop and strips repeated loop flags", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 5\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 2 --fresh --fresh --no-converge --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["ARGS:task", "ARGS:task"]);
		assert.equal(getNavigateCount(), 1);
	});
});

test("queued run-prompt applies bare --loop semantics", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-loop", { command: "deslop task --loop --no-converge" });

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.userMessages, ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("chain templates route before non-chain loop extraction and run with CLI --loop", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("task --loop 2 --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:task", "WORK:task"]);
	});
});

test("chain templates apply frontmatter loop/fresh/converge defaults", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\nloop: 3\nfresh: true\nconverge: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("task", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:task", "WORK:task", "WORK:task"]);
		assert.equal(getNavigateCount(), 2);
	});
});

test("chain templates without loop frontmatter preserve --fresh and --no-converge args", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("--fresh --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:--fresh --no-converge"]);
	});
});

test("chain templates honor per-step --loop counts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: first --loop 2 -> second --loop 3\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nfirst`);
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nsecond`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.userMessages, ["first", "first", "second", "second", "second"]);
	});
});

test("chain templates treat quoted --loop step args as literals", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: worker "--loop" "2"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker:$1:$2`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.userMessages, ["worker:--loop:2"]);
	});
});

test("per-step convergence stops on first no-change iteration when step converge is enabled", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker --loop 3\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.userMessages, ["worker"]);
	});
});

test("chain template execution rejects chain nesting when a step is a chain template", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "outer.md"), "---\nchain: inner\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "inner.md"), "---\nchain: leaf\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), `---\nmodel: ${MODEL_ID}\n---\nleaf`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const outer = pi.commands.get("outer");
		assert.ok(outer);
		await outer.handler("", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /chain nesting is not supported/i);
	});
});

test("chain nesting is rejected when a step references a chain template", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "inner.md"), "---\nchain: leaf\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), `---\nmodel: ${MODEL_ID}\n---\nleaf`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("inner", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /chain nesting is not supported/i);
	});
});

test("chain-prompts rejects empty step segments", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\n---\nfirst`);
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\n---\nsecond`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("first -> -> second", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /invalid chain step/i);
	});
});

test("chain templates use step args first and fall back to shared CLI args", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: first explicit -> second\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\n---\nFIRST:$1`);
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\n---\nSECOND:$1`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("shared", ctx);

		assert.deepEqual(pi.userMessages, ["FIRST:explicit", "SECOND:shared"]);
	});
});

test("chain template restore false leaves final model active", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: first -> second\nrestore: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: anthropic/first-model\n---\nfirst");
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), "---\nmodel: anthropic/second-model\n---\nsecond");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const firstModel = { provider: "anthropic", id: "first-model" };
		const secondModel = { provider: "anthropic", id: "second-model" };
		const models = [baseModel, firstModel, secondModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.setModelCalls, ["anthropic/first-model", "anthropic/second-model"]);
		assert.deepEqual(pi.currentModel, secondModel);
	});
});

test("queued run-prompt executes chain templates through runPromptCommand routing", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-chain", { command: "pipeline task --loop 2 --no-converge" });

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.userMessages, ["worker:task", "worker:task"]);
	});
});

test("queued run-prompt restores pending session state before executing queued command", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: anthropic/loop-first\nrestore: true\n---\nfirst");
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), "---\nmodel: anthropic/loop-second\nrestore: true\n---\nsecond");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const firstModel = { provider: "anthropic", id: "loop-first" };
		const secondModel = { provider: "anthropic", id: "loop-second" };
		const models = [baseModel, firstModel, secondModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const first = pi.commands.get("first");
		assert.ok(first);
		await first.handler("", ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/loop-first"]);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-1", { command: "second" });

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/loop-first", "anthropic/base-model", "anthropic/loop-second"]);
	});
});
