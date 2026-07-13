import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextBundle, Observation } from "../src/core/types.ts";
import type { Observer } from "../src/observer/observer.ts";
import { makeClaudeJudge, runAb } from "../src/observer/ab.ts";
import { makeIngest } from "../src/capture/ingest.ts";
import { freshStore } from "./helpers.ts";
import { EgressAuditor } from "../src/privacy/egress.ts";

test("A/B observation gives frame bytes only to image-enabled observers", async () => {
  const store = freshStore();
  const ingest = makeIngest(store);
  ingest.ingest({
    source: "screen_video",
    app: "Code",
    window: "project",
    type: "frame",
    ts: "2026-07-13T20:00:30.000Z",
    payload: { displayID: 1, displayIndex: 0, displays: 1, ocrText: "reference" },
    blobs: [{
      kind: "image",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    }],
  });
  for (let index = 0; index < 3; index += 1) {
    store.actions.put({
      id: `action_ab_${index}`,
      type: "user_action",
      action: "edited_file",
      app: "Code",
      startTs: `2026-07-13T20:00:2${index}.000Z`,
      endTs: `2026-07-13T20:00:2${index}.000Z`,
      confidence: 0.9,
      evidence: [],
    });
  }

  const imageCounts: Array<number | undefined> = [];
  const observer = (wantsImages: boolean, model: string): Observer => ({
    model,
    wantsImages,
    async observe(bundle: ContextBundle): Promise<Observation> {
      imageCounts.push(bundle.frameImages?.length);
      return {
        id: `observation_${model}`,
        bundleId: bundle.id,
        acceptedOptions: [],
        rejectedOptions: [],
        uncertainty: [],
        evidence: bundle.actions.map((action) => action.id),
        model,
        createdTs: bundle.endTs,
      };
    },
  });

  try {
    const rounds = await runAb(
      store,
      observer(true, "image-observer"),
      observer(false, "text-observer"),
      { rounds: 1 },
    );
    assert.equal(rounds.length, 1);
    assert.deepEqual(imageCounts, [1, undefined]);
  } finally {
    store.close();
  }
});

test("the A/B judge rechecks cloud consent before its own provider call", async () => {
  const consent = { cloudObserverConsent: false, screenshotConsent: false };
  const auditor = new EgressAuditor();
  let fetchCalls = 0;
  const judge = makeClaudeJudge("test-key", "claude-test", {
    auditor,
    readConsent: () => consent,
    fetchFn: (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as typeof fetch,
  });
  const observation: Observation = {
    id: "obs",
    bundleId: "bundle",
    acceptedOptions: [],
    rejectedOptions: [],
    uncertainty: [],
    evidence: [],
    model: "test",
    createdTs: "2026-07-13T20:00:00.000Z",
  };

  await assert.rejects(
    judge("sensitive context", observation, observation),
    /cloud observer consent is disabled/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(auditor.recent(1)[0]?.outcome, "blocked");
  assert.equal(auditor.recent(1)[0]?.bytes, 0);
});
