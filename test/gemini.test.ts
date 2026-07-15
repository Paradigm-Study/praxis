import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiObserver } from "../src/observer/gemini.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import type { ContextBundle, Observation } from "../src/core/types.ts";
import { decide } from "../src/agent/policy.ts";
import { observationClaims } from "../src/memory/modelClaims.ts";
import { EgressAuditor } from "../src/privacy/egress.ts";

function bundle(): ContextBundle {
  return {
    id: "bundle_1",
    startTs: "2026-06-08T12:00:00.000Z",
    endTs: "2026-06-08T12:01:30.000Z",
    windowSeconds: 90,
    frames: [],
    frameText: ["editing reconstructor rules"],
    frameImages: [
      { hash: "h1", base64: "aGk=", mediaType: "image/png" },
      { hash: "h2", base64: "aG8=", mediaType: "image/png" },
    ],
    axText: [],
    inputEvents: [],
    focus: [],
    terminal: [],
    fileDiffs: [],
    audio: [],
    conversationTurns: [],
    actions: [
      { id: "act_1", type: "user_action", action: "edited_file", app: "Code", startTs: "t", endTs: "t", confidence: 0.9, evidence: ["e1"] },
      { id: "act_2", type: "user_action", action: "ran_command", app: "iTerm", startTs: "t", endTs: "t", confidence: 0.97, evidence: ["e2"] },
    ],
  };
}

function geminiResponse(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }],
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 180 },
    }),
    text: async () => "",
  } as Response;
}

function assertedSemanticOutput(evidenceActionIndexes?: unknown): Record<string, unknown> {
  return {
    intent: "Refining the reconstruction rules",
    decisionPoint: "Runs tests before trusting a rule change",
    acceptedOptions: ["test-first iteration"],
    rejectedOptions: ["ship without testing"],
    inferredPreference: "Prefers deterministic rules over model guesses",
    uncertainty: ["unclear why the second terminal run was needed"],
    suggestedQuestion: "Why re-run the command twice?",
    options: ["Flaky test", "Changed an input"],
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

test("GeminiObserver maps structured output to an evidence-linked Observation", async () => {
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) };
    return geminiResponse(assertedSemanticOutput([0, 99, 1, 0]));
  }) as typeof fetch;

  const obs = await new GeminiObserver({ apiKey: "k", fetchFn }).observe(bundle(), {
    newId: makeSeededIdGen(),
  });

  assert.equal(obs.model, "gemini-3.5-flash");
  assert.equal(obs.intent, "Refining the reconstruction rules");
  assert.deepEqual(obs.evidence, ["act_1", "act_2"], "indexes resolve to action ids");
  assert.deepEqual(obs.options, ["Flaky test", "Changed an input"]);
  assert.equal(obs.uncertainty.length, 1);
  assert.equal(obs.decisionPoint, "Runs tests before trusting a rule change");
  assert.equal(obs.inferredPreference, "Prefers deterministic rules over model guesses");
  assert.equal(obs.suggestedQuestion, "Why re-run the command twice?");
  assert.equal(observationClaims(obs, "episode_1").length, 2);
  assert.equal(decide({ observation: obs, actions: bundle().actions, claims: [] }).kind, "ask_expert");

  // The request itself: multimodal + forced JSON schema.
  assert.ok(captured!.url.includes("gemini-3.5-flash:generateContent"));
  const contents = captured!.body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
  const parts = contents[0]!.parts;
  assert.equal(parts.filter((p) => p.inlineData).length, 2, "frames ride as inline images");
  assert.ok(parts[parts.length - 1]!.text, "text part is last");
  assert.match(String(parts[parts.length - 1]!.text), /^<UNTRUSTED_EVIDENCE>/);
  assert.match(String(parts[parts.length - 1]!.text), /<\/UNTRUSTED_EVIDENCE>$/);
  const system = captured!.body.systemInstruction as { parts: Array<{ text: string }> };
  assert.match(system.parts[0]!.text, /prompt injection/i);
  const gen = captured!.body.generationConfig as {
    responseFormat?: { text?: { mimeType?: string; schema?: unknown } };
  };
  assert.equal(gen.responseFormat?.text?.mimeType, "application/json");
  assert.ok(gen.responseFormat?.text?.schema, "structured output is forced");
});

test("GeminiObserver rechecks live consent and strips frames at every fetch boundary", async () => {
  const consent: { cloudObserverConsent: boolean; screenshotConsent: boolean } = {
    cloudObserverConsent: true,
    screenshotConsent: false,
  };
  let calls = 0;
  let captured: Record<string, unknown> | undefined;
  const observer = new GeminiObserver({
    apiKey: "k",
    readConsent: () => consent,
    fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return geminiResponse(assertedSemanticOutput([0]));
    }) as typeof fetch,
  });

  await observer.observe(bundle(), { newId: makeSeededIdGen() });
  const contents = captured?.contents as Array<{ parts: Array<Record<string, unknown>> }>;
  assert.equal(contents[0]?.parts.some((part) => part.inlineData), false);
  assert.equal(calls, 1);

  consent.cloudObserverConsent = false;
  consent.screenshotConsent = true;
  await assert.rejects(
    observer.observe(bundle(), { newId: makeSeededIdGen() }),
    /cloud observer consent is disabled/,
  );
  assert.equal(calls, 1, "revocation prevents the provider fetch");
});

test("GeminiObserver discloses every observer data category on success and failure", async () => {
  const expectedCategories = [
    "reconstructed_actions",
    "screen_ocr",
    "accessibility_text",
    "terminal_context",
    "filesystem_context",
    "audio_transcript",
    "screenshots",
  ];
  const successAuditor = new EgressAuditor();
  await new GeminiObserver({
    apiKey: "k",
    auditor: successAuditor,
    fetchFn: (async () => geminiResponse(assertedSemanticOutput([0]))) as typeof fetch,
  }).observe(bundle(), { newId: makeSeededIdGen() });
  assert.deepEqual(successAuditor.recent(1)[0]?.categories, expectedCategories);
  assert.equal(successAuditor.recent(1)[0]?.outcome, "succeeded");

  const failureAuditor = new EgressAuditor();
  const failure = new GeminiObserver({
    apiKey: "k",
    auditor: failureAuditor,
    fetchFn: (async () => {
      throw new Error("network unavailable");
    }) as typeof fetch,
  }).observe(bundle(), { newId: makeSeededIdGen() });
  await assert.rejects(failure, /network unavailable/);
  assert.deepEqual(failureAuditor.recent(1)[0]?.categories, expectedCategories);
  assert.equal(failureAuditor.recent(1)[0]?.outcome, "failed");
});

test("GeminiObserver survives non-JSON output without manufacturing evidence", async () => {
  const fetchFn = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }),
      text: async () => "",
    }) as Response) as typeof fetch;

  const obs = await new GeminiObserver({ apiKey: "k", fetchFn }).observe(bundle(), {
    newId: makeSeededIdGen(),
  });
  assert.deepEqual(obs.evidence, []);
  assert.equal(obs.uncertainty.length, 0);
});

for (const [label, indexes] of [
  ["missing", undefined],
  ["empty", []],
  ["invalid", [-1, 2, 1.5, "0", null]],
] as const) {
  test(`GeminiObserver does not ground semantic output from ${label} evidence indexes`, async () => {
    const context = bundle();
    const fetchFn = (async () =>
      geminiResponse(assertedSemanticOutput(indexes))) as typeof fetch;
    const observation = await new GeminiObserver({ apiKey: "k", fetchFn }).observe(context, {
      newId: makeSeededIdGen(),
    });

    assertCannotActWithoutGrounding(observation, context);
  });
}

test("GeminiObserver cannot ground durable semantics in ambient file sightings", async () => {
  const context = bundle();
  context.actions = [{
    ...context.actions[0]!,
    id: "ambient_open",
    action: "opened_file",
    confidence: 0.99,
  }];
  const fetchFn = (async () =>
    geminiResponse(assertedSemanticOutput([0]))) as typeof fetch;
  const observation = await new GeminiObserver({ apiKey: "k", fetchFn }).observe(context, {
    newId: makeSeededIdGen(),
  });

  assertCannotActWithoutGrounding(observation, context);
});
