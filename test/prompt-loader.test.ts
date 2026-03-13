import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptsWithModel, RESERVED_COMMAND_NAMES } from "../prompt-loader.js";

function withTempHome(run: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-template-model-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("loadPromptsWithModel keeps the first same-layer duplicate after lexical sorting", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "alpha"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts", "zeta"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "alpha", "dup.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nalpha');
		writeFileSync(join(cwd, ".pi", "prompts", "zeta", "dup.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nzeta');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("dup")?.content, "alpha");
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /conflicts with/);
	});
});

test("loadPromptsWithModel lets project prompts override user prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "prompts", "same.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nuser');
		writeFileSync(join(cwd, ".pi", "prompts", "same.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nproject');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("same")?.source, "project");
		assert.equal(result.prompts.get("same")?.content, "project");
	});
});

test("loadPromptsWithModel skips reserved command names and surfaces diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "model.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nhello');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("model"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /reserved/);
	});
});

test("loadPromptsWithModel uses canonical frontmatter parsing for booleans and warns on invalid thinking", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "debug.md"),
			'---\nmodel: claude-sonnet-4-20250514\nrestore: false\nthinking: turbo\ndescription: "Debug prompt"\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("debug")?.restore, false);
		assert.equal(result.prompts.get("debug")?.description, "Debug prompt");
		assert.equal(result.prompts.get("debug")?.thinking, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid thinking level/i);
	});
});

test("loadPromptsWithModel trims optional string frontmatter fields", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "trimmed.md"),
			'---\nmodel: claude-sonnet-4-20250514\ndescription: "  Trim me  "\nskill: "  tmux  "\nthinking: " high "\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("trimmed")?.description, "Trim me");
		assert.equal(result.prompts.get("trimmed")?.skill, "tmux");
		assert.equal(result.prompts.get("trimmed")?.thinking, "high");
	});
});

test("loadPromptsWithModel rejects invalid model declarations up front", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad.md"), '---\nmodel: anthropic/*\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid model spec/i);
	});
});

test("loadPromptsWithModel rejects model declarations with internal whitespace", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-space.md"), '---\nmodel: anthropic /claude-sonnet-4-20250514\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-space"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid model spec/i);
	});
});

test("loadPromptsWithModel avoids recursive symlink loops", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(join(promptsDir, "nested"), { recursive: true });
		writeFileSync(join(promptsDir, "nested", "ok.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nbody');
		symlinkSync(promptsDir, join(promptsDir, "nested", "loop"));

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("ok")?.content, "body");
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /already visited prompt directory/i);
	});
});

test("loadPromptsWithModel rejects non-object frontmatter roots", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-frontmatter.md"), '---\n- model\n- claude-sonnet-4-20250514\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-frontmatter"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /frontmatter must be a key-value object/i);
	});
});

test("reserved built-in command mirror is explicit", () => {
	assert.deepEqual([...RESERVED_COMMAND_NAMES].sort(), [
		"chain-prompts",
		"changelog",
		"compact",
		"copy",
		"export",
		"fork",
		"hotkeys",
		"login",
		"logout",
		"model",
		"name",
		"new",
		"quit",
		"reload",
		"resume",
		"scoped-models",
		"session",
		"settings",
		"share",
		"tree",
	].sort());
});
