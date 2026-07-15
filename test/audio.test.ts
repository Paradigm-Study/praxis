import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstruct, reconstructEvents } from "../src/reconstructor/reconstructor.ts";
import { makeSeededIdGen } from "../src/core/ids.ts";
import type { RawEvent } from "../src/core/types.ts";
import { freshStore } from "./helpers.ts";

const T0 = Date.parse("2026-06-08T12:00:00.000Z");
let n = 0;
function seg(
  channel: "mic" | "system",
  offsetSec: number,
  text: string,
  app = "zoom.us",
): RawEvent {
  const id = `a${++n}`;
  return {
    id,
    ts: new Date(T0 + offsetSec * 1000).toISOString(),
    source: "audio",
    app,
    window: app,
    type: "transcript_segment",
    payload: { channel, text },
    blobRefs: [],
    hash: "h" + id,
  };
}

test("interleaved mic + system speech reconstructs an attended_meeting", () => {
  const events = [
    seg("system", 0, "so walk me through the launch plan"),
    seg("mic", 4, "sure, we ship the capture client first"),
    seg("system", 12, "and when does the studio land"),
    seg("mic", 18, "studio lands the week after"),
  ];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  const meeting = actions.find((a) => a.action === "attended_meeting");
  assert.ok(meeting, "expected an attended_meeting");
  assert.ok(meeting!.confidence >= 0.75, `conf ${meeting!.confidence}`);
  assert.ok(meeting!.evidence.length >= 2, "evidence spans both channels");
  assert.match(String(meeting!.payload?.micText), /capture client/);
  assert.match(String(meeting!.payload?.systemText), /launch plan/);
  // No double-reporting: the same audio must not ALSO be playback/dictation.
  assert.ok(!actions.some((a) => a.action === "listened_audio"));
  assert.ok(!actions.some((a) => a.action === "spoke_aloud"));
});

test("system speech alone is listened_audio with honest uncertainty", () => {
  const events = [
    seg("system", 0, "in this tutorial we set the reverb decay", "Ableton Live"),
    seg("system", 8, "to around two seconds for the snare", "Ableton Live"),
  ];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  const listened = actions.find((a) => a.action === "listened_audio");
  assert.ok(listened, "expected listened_audio");
  assert.equal(listened!.app, "Ableton Live");
  assert.ok(listened!.uncertainty?.some((u) => /actively listening/.test(u)));
  assert.ok(
    !actions.some((a) => a.action === "attended_meeting"),
    "no meeting without mic speech",
  );
});

test("mic speech alone is spoke_aloud, kept uncertain", () => {
  const events = [seg("mic", 0, "remind me to revisit the consolidation threshold")];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  const spoke = actions.find((a) => a.action === "spoke_aloud");
  assert.ok(spoke, "expected spoke_aloud");
  assert.ok(spoke!.confidence < 0.8, "lone mic speech must stay uncertain");
  assert.ok(spoke!.uncertainty?.length, "carries an honest uncertainty note");
});

test("segments far apart split into separate spans, not one mega-action", () => {
  const events = [
    seg("system", 0, "first podcast episode"),
    seg("system", 300, "totally different video an hour later"),
  ];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  const listened = actions.filter((a) => a.action === "listened_audio");
  assert.equal(listened.length, 2, "a 5-minute gap is a new span");
});

test("reconstruction is idempotent — same audio yields the same action ids", () => {
  const events = [
    seg("system", 0, "so walk me through the launch plan"),
    seg("mic", 4, "sure, we ship the capture client first"),
  ];
  const a1 = reconstructEvents(events, { newId: makeSeededIdGen() });
  const a2 = reconstructEvents(events, { newId: makeSeededIdGen() });
  assert.deepEqual(
    a1.map((a) => a.id),
    a2.map((a) => a.id),
  );
});

test("mic loopback matching system speech is suppressed instead of becoming a meeting", () => {
  const events = [
    seg("system", 0, "Welcome everyone to the weekly launch review."),
    seg("mic", 1, "welcome everyone to weekly launch review"),
  ];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  assert.deepEqual(actions.map((action) => action.action), ["listened_audio"]);
});

test("a known meeting app makes a distinct two-sided exchange an attended meeting", () => {
  const events = [
    seg("system", 0, "Can you walk us through the launch risks?"),
    seg("mic", 1, "The largest risk is the vendor migration schedule."),
  ];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  assert.deepEqual(actions.map((action) => action.action), ["attended_meeting"]);
});

test("one generic mic/system coincidence stays uncertain instead of asserting a meeting", () => {
  const events = [
    seg("system", 0, "Today we will review the launch dashboard.", "Google Chrome"),
    seg("mic", 1, "Remind me to send the vendor invoice.", "Google Chrome"),
  ];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  assert.deepEqual(
    actions.map((action) => action.action),
    ["listened_audio", "spoke_aloud"],
  );
  assert.ok(actions.every((action) => action.uncertainty?.length));
  assert.ok(!actions.some((action) => action.action === "attended_meeting"));
});

test("three genuinely alternating turns establish a meeting in a generic app", () => {
  const events = [
    seg("system", 0, "Can you walk through the launch risk?", "Google Chrome"),
    seg("mic", 5, "The vendor migration is the largest risk.", "Google Chrome"),
    seg("system", 10, "What fallback should the team prepare?", "Google Chrome"),
  ];
  const actions = reconstructEvents(events, { newId: makeSeededIdGen() });
  assert.deepEqual(actions.map((action) => action.action), ["attended_meeting"]);
});

test("audio classification and ids are stable when raw events arrive out of order", () => {
  const events = [
    seg("system", 0, "Can you walk us through the launch risks?"),
    seg("mic", 4, "The largest risk is the vendor migration schedule."),
    seg("system", 10, "That makes sense, what is the fallback?"),
  ];
  const forward = reconstructEvents(events, { newId: makeSeededIdGen() });
  const reverse = reconstructEvents([...events].reverse(), { newId: makeSeededIdGen() });
  assert.deepEqual(
    forward.map(({ id, action, evidence }) => ({ id, action, evidence })),
    reverse.map(({ id, action, evidence }) => ({ id, action, evidence })),
  );
});

test("a later mic reply retracts the stale playback materialization", () => {
  const store = freshStore();
  store.events.append(seg("system", 0, "Can you walk us through the launch risks?"));
  const initial = reconstruct(store, { newId: makeSeededIdGen() });
  assert.deepEqual(initial.map((action) => action.action), ["listened_audio"]);

  store.events.append(seg("mic", 4, "The largest risk is the vendor migration schedule."));
  reconstruct(store, { newId: makeSeededIdGen() });
  assert.deepEqual(store.actions.range().map((action) => action.action), ["attended_meeting"]);
  store.close();
});

test("a later loopback segment preserves the stable playback action", () => {
  const store = freshStore();
  store.events.append(seg("system", 0, "Welcome everyone to the weekly launch review."));
  reconstruct(store, { newId: makeSeededIdGen() });
  const original = store.actions.range()[0];
  assert.equal(original?.action, "listened_audio");

  store.events.append(seg("mic", 1, "welcome everyone to weekly launch review"));
  reconstruct(store, { newId: makeSeededIdGen() });
  const persisted = store.actions.range();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.action, "listened_audio");
  assert.equal(persisted[0]?.id, original?.id);
  store.close();
});
