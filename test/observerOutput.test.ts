import assert from "node:assert/strict";
import { test } from "node:test";
import { observerStrings, observerText } from "../src/observer/output.ts";

test("observer output drops empty values and applies deterministic bounds", () => {
  assert.equal(observerText(" \u0000  \n\t "), undefined);
  assert.equal(observerText(`  ${"x".repeat(20)}  `, 8), "xxxxxxxx");
  assert.deepEqual(
    observerStrings(
      ["  Verify first  ", "verify first", "", null, "Ship later", "ignored"],
      { maxItems: 2, maxChars: 20 },
    ),
    ["Verify first", "Ship later"],
  );
  assert.deepEqual(observerStrings(["must not escape"], { maxItems: 0 }), []);
});
