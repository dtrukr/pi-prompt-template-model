import test from "node:test";
import assert from "node:assert/strict";
import { parseChainDeclaration } from "../chain-parser.js";

test("parseChainDeclaration keeps the first valid per-step --loop and strips repeated loop tokens", () => {
	const parsed = parseChainDeclaration("worker --loop 2 --loop 3");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ type: "prompt", name: "worker", args: [], loopCount: 2 }]);
});

test("parseChainDeclaration strips invalid loop tokens when a later valid loop exists", () => {
	const parsed = parseChainDeclaration("worker --loop 1000 --loop 2");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ type: "prompt", name: "worker", args: [], loopCount: 2 }]);
});

test("parseChainDeclaration keeps quoted --loop tokens as step args", () => {
	const parsed = parseChainDeclaration('worker "--loop" "2"');
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ type: "prompt", name: "worker", args: ["--loop", "2"], loopCount: undefined }]);
});

test("parseChainDeclaration treats fully quoted segments as inline steps", () => {
	const parsed = parseChainDeclaration('analyze -> "make UI better" --loop 2 -> verify');
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [
		{ type: "prompt", name: "analyze", args: [], loopCount: undefined },
		{ type: "inline", name: "<inline>", content: "make UI better", args: [], loopCount: 2 },
		{ type: "prompt", name: "verify", args: [], loopCount: undefined },
	]);
});
