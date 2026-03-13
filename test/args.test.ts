import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandArgs, substituteArgs } from "../args.js";

test("parseCommandArgs respects quoted segments", () => {
	assert.deepEqual(parseCommandArgs('alpha "two words" beta'), ["alpha", "two words", "beta"]);
	assert.deepEqual(parseCommandArgs("one 'two three' four"), ["one", "two three", "four"]);
});

test("substituteArgs supports positional, aggregate, and slice replacements", () => {
	const result = substituteArgs("$1 | $@ | $ARGUMENTS | ${@:2} | ${@:2:2}", ["one", "two", "three", "four"]);
	assert.equal(result, "one | one two three four | one two three four | two three four | two three");
});

test("substituteArgs is non-recursive", () => {
	const result = substituteArgs("$1 / $@", ["$2", "$ARGUMENTS"]);
	assert.equal(result, "$2 / $2 $ARGUMENTS");
});
