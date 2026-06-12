import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiObserver } from "../src/observer/gemini.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import type { ContextBundle } from "../src/core/types.ts";

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

test("GeminiObserver maps structured output to an evidence-linked Observation", async () => {
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) };
    return geminiResponse({
      intent: "Refining the reconstruction rules",
      decisionPoint: "Runs tests before trusting a rule change",
      acceptedOptions: ["test-first iteration"],
      rejectedOptions: [],
      inferredPreference: "Prefers deterministic rules over model guesses",
      uncertainty: ["unclear why the second terminal run was needed"],
      suggestedQuestion: "Why re-run the command twice?",
      options: ["Flaky test", "Changed an input"],
      evidenceActionIndexes: [0, 1],
    });
  }) as typeof fetch;

  const obs = await new GeminiObserver({ apiKey: "k", fetchFn }).observe(bundle(), {
    newId: makeSeededIdGen(),
  });

  assert.equal(obs.model, "gemini-3.5-flash");
  assert.equal(obs.intent, "Refining the reconstruction rules");
  assert.deepEqual(obs.evidence, ["act_1", "act_2"], "indexes resolve to action ids");
  assert.deepEqual(obs.options, ["Flaky test", "Changed an input"]);
  assert.equal(obs.uncertainty.length, 1);

  // The request itself: multimodal + forced JSON schema.
  assert.ok(captured!.url.includes("gemini-3.5-flash:generateContent"));
  const contents = captured!.body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
  const parts = contents[0]!.parts;
  assert.equal(parts.filter((p) => p.inlineData).length, 2, "frames ride as inline images");
  assert.ok(parts[parts.length - 1]!.text, "text part is last");
  const gen = captured!.body.generationConfig as {
    responseFormat?: { text?: { mimeType?: string; schema?: unknown } };
  };
  assert.equal(gen.responseFormat?.text?.mimeType, "application/json");
  assert.ok(gen.responseFormat?.text?.schema, "structured output is forced");
});

test("GeminiObserver survives non-JSON output and falls back to all-action evidence", async () => {
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
  assert.deepEqual(obs.evidence, ["act_1", "act_2"]);
  assert.equal(obs.uncertainty.length, 0);
});
