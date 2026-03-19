import test from "node:test";
import assert from "node:assert/strict";
import { parseChainDeclaration } from "../chain-parser.js";

test("parseChainDeclaration keeps the first valid per-step --loop and strips repeated loop tokens", () => {
	const parsed = parseChainDeclaration("worker --loop 2 --loop 3");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: 2 }]);
});

test("parseChainDeclaration strips invalid loop tokens when a later valid loop exists", () => {
	const parsed = parseChainDeclaration("worker --loop 1000 --loop 2");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: 2 }]);
});

test("parseChainDeclaration keeps quoted --loop tokens as step args", () => {
	const parsed = parseChainDeclaration('worker "--loop" "2"');
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: ["--loop", "2"], loopCount: undefined }]);
});
