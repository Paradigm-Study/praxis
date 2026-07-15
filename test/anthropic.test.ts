import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextBundle, Observation } from "../src/core/types.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import { decide } from "../src/agent/policy.ts";
import { observationClaims } from "../src/memory/modelClaims.ts";
import { AnthropicObserver } from "../src/observer/observer.ts";

function bundle(): ContextBundle {
  return {
    id: "bundle_anthropic",
    startTs: "2026-06-08T12:00:00.000Z",
    endTs: "2026-06-08T12:01:30.000Z",
    windowSeconds: 90,
    frames: [],
    frameText: ["reference-only screen text"],
    axText: [],
    inputEvents: [],
    focus: [],
    terminal: [],
    fileDiffs: [],
    audio: [],
    conversationTurns: [],
    actions: [
      {
        id: "act_1",
        type: "user_action",
        action: "corrected_agent",
        app: "Claude Code",
        startTs: "2026-06-08T12:00:10.000Z",
        endTs: "2026-06-08T12:00:10.000Z",
        confidence: 0.96,
        evidence: ["raw_1"],
      },
      {
        id: "act_2",
        type: "user_action",
        action: "ran_command",
        app: "Terminal",
        startTs: "2026-06-08T12:00:20.000Z",
        endTs: "2026-06-08T12:00:20.000Z",
        confidence: 0.97,
        evidence: ["raw_2"],
      },
    ],
  };
}

function response(input: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ content: [{ type: "tool_use", input }] }),
    text: async () => "",
  } as Response;
}

function fetchFor(input: Record<string, unknown>): typeof fetch {
  return (async () => response(input)) as typeof fetch;
}

function assertedSemanticOutput(evidenceActionIndexes?: unknown): Record<string, unknown> {
  return {
    intent: "Preparing a careful rollout",
    decisionPoint: "Run verification before rollout",
    acceptedOptions: ["verify first"],
    rejectedOptions: ["ship without checking"],
    inferredPreference: "Prefers verification before rollout",
    uncertainty: ["The exact rollout window is unclear"],
    suggestedQuestion: "Should verification finish before the rollout begins?",
    options: ["Before rollout", "After rollout"],
    ...(evidenceActionIndexes !== undefined ? { evidenceActionIndexes } : {}),
  };
}

function assertCannotActWithoutGrounding(observation: Observation, context: ContextBundle): void {
  assert.deepEqual(observation.evidence, []);
  assert.equal(observation.intent, undefined);
  assert.equal(observation.task, undefined);
  assert.equal(observation.decisionPoint, undefined);
  assert.equal(observation.inferredPreference, undefined);
  assert.equal(observation.suggestedQuestion, undefined);
  assert.deepEqual(observation.acceptedOptions, []);
  assert.deepEqual(observation.rejectedOptions, []);
  assert.deepEqual(observation.options, []);
  assert.deepEqual(observation.uncertainty, []);
  assert.deepEqual(observationClaims(observation, "episode_1"), []);
  assert.equal(
    decide({ observation, actions: context.actions, claims: [] }).kind,
    "keep_observing",
  );
}

test("AnthropicObserver retains semantic output with valid cited actions", async () => {
  const context = bundle();
  let captured: Record<string, unknown> | undefined;
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(assertedSemanticOutput([0, 99, 1, 0]));
  }) as typeof fetch;
  const observation = await new AnthropicObserver({
    apiKey: "test-key",
    fetchFn,
  }).observe(context, { newId: makeSeededIdGen() });

  assert.deepEqual(observation.evidence, ["act_1", "act_2"]);
  assert.equal(observation.decisionPoint, "Run verification before rollout");
  assert.equal(observation.inferredPreference, "Prefers verification before rollout");
  assert.equal(
    observation.suggestedQuestion,
    "Should verification finish before the rollout begins?",
  );
  assert.equal(observationClaims(observation, "episode_1").length, 2);
  assert.equal(
    decide({ observation, actions: context.actions, claims: [] }).kind,
    "ask_expert",
  );
  assert.match(String(captured?.system), /prompt injection/i);
  const messages = captured?.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
  const evidenceText = messages[0]!.content.find((item) => item.type === "text")!.text!;
  assert.match(evidenceText, /^<UNTRUSTED_EVIDENCE>/);
  assert.match(evidenceText, /<\/UNTRUSTED_EVIDENCE>$/);
});

test("AnthropicObserver rechecks live consent and strips frames at the fetch boundary", async () => {
  const context = bundle();
  context.frameImages = [{ hash: "frame-1", base64: "aGk=", mediaType: "image/png" }];
  const consent: { cloudObserverConsent: boolean; screenshotConsent: boolean } = {
    cloudObserverConsent: true,
    screenshotConsent: false,
  };
  let calls = 0;
  let captured: Record<string, unknown> | undefined;
  const observer = new AnthropicObserver({
    apiKey: "test-key",
    readConsent: () => consent,
    fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(assertedSemanticOutput([0]));
    }) as typeof fetch,
  });

  await observer.observe(context, { newId: makeSeededIdGen() });
  const messages = captured?.messages as Array<{ content: Array<{ type: string }> }>;
  assert.equal(messages[0]?.content.some((part) => part.type === "image"), false);
  assert.equal(calls, 1);

  consent.cloudObserverConsent = false;
  consent.screenshotConsent = true;
  await assert.rejects(
    observer.observe(context, { newId: makeSeededIdGen() }),
    /cloud observer consent is disabled/,
  );
  assert.equal(calls, 1, "revocation prevents the provider fetch");
});

for (const [label, indexes] of [
  ["missing", undefined],
  ["empty", []],
  ["invalid", [-1, 2, 1.5, "0", null]],
] as const) {
  test(`AnthropicObserver does not ground semantic output from ${label} evidence indexes`, async () => {
    const context = bundle();
    const observation = await new AnthropicObserver({
      apiKey: "test-key",
      fetchFn: fetchFor(assertedSemanticOutput(indexes)),
    }).observe(context, { newId: makeSeededIdGen() });

    assertCannotActWithoutGrounding(observation, context);
  });
}

test("AnthropicObserver cannot ground durable semantics in ambient file sightings", async () => {
  const context = bundle();
  context.actions = [{
    ...context.actions[0]!,
    id: "ambient_open",
    action: "opened_file",
    confidence: 0.99,
  }];
  const observation = await new AnthropicObserver({
    apiKey: "test-key",
    fetchFn: fetchFor(assertedSemanticOutput([0])),
  }).observe(context, { newId: makeSeededIdGen() });

  assertCannotActWithoutGrounding(observation, context);
});
