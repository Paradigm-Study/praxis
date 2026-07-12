import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultProvider, NgramCosineProvider } from "../src/core/similarity.ts";

test("defaultProvider is the trigram-cosine provider (no longer the noop stub)", () => {
  assert.equal(defaultProvider, NgramCosineProvider);
  assert.equal(defaultProvider.name, "ngram_cosine");
});

test("identical texts score 1", () => {
  const s = defaultProvider.similarity(
    "migrate the postgres database",
    "migrate the postgres database",
  );
  assert.ok(Math.abs(s - 1) < 1e-9, `expected ~1, got ${s}`);
});

test("normalization: case and punctuation do not matter", () => {
  const s = defaultProvider.similarity("Deploy the API!!", "deploy, the api");
  assert.ok(Math.abs(s - 1) < 1e-9, `expected ~1 after normalization, got ${s}`);
});

test("symmetric and always within [0, 1]", () => {
  const pairs: Array<[string, string]> = [
    ["postgres migration", "migrate postgres"],
    ["a", "b"],
    ["run the linter before committing", "bake a chocolate cake"],
    ["", "anything"],
    ["short", "a much much longer sentence about entirely different things"],
  ];
  for (const [a, b] of pairs) {
    const ab = defaultProvider.similarity(a, b);
    const ba = defaultProvider.similarity(b, a);
    assert.equal(ab, ba, `similarity must be symmetric for (${a}, ${b})`);
    assert.ok(ab >= 0 && ab <= 1, `similarity out of range for (${a}, ${b}): ${ab}`);
  }
});

test("empty or non-alphanumeric text scores 0 against everything", () => {
  assert.equal(defaultProvider.similarity("", "postgres"), 0);
  assert.equal(defaultProvider.similarity("!!! ---", "postgres"), 0);
  assert.equal(defaultProvider.similarity("", ""), 0);
});

test("on-topic paraphrase outranks an unrelated text", () => {
  const task = "run the postgres database migration";
  const related = defaultProvider.similarity(task, "Prefer Postgres for database migrations.");
  const unrelated = defaultProvider.similarity(task, "User likes dark chocolate cake for dessert.");
  assert.ok(
    related > unrelated,
    `related (${related}) must beat unrelated (${unrelated})`,
  );
  assert.ok(related > 0.3, `related pair should score substantially (> 0.3), got ${related}`);
  assert.ok(unrelated < 0.2, `unrelated pair should score low (< 0.2), got ${unrelated}`);
});

test("morphological variants still align (character grams beat exact tokens)", () => {
  const s = defaultProvider.similarity("database migration", "database migrations");
  assert.ok(s > 0.8, `singular/plural should stay close, got ${s}`);
});

test("deterministic: repeated calls return the identical value", () => {
  const a = "refactor the capture manager polling loop";
  const b = "polling loop refactor in capture manager";
  const first = defaultProvider.similarity(a, b);
  for (let i = 0; i < 5; i++) {
    assert.equal(defaultProvider.similarity(a, b), first);
  }
});
