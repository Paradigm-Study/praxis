import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import type { ActionEvent, Episode } from "../src/core/types.ts";
import { startStudio } from "../src/studio/server.ts";
import { action, freshStore } from "./helpers.ts";

interface WorkflowPage {
  items: Array<{
    episode: Episode;
    actions: ActionEvent[];
    truncation: {
      truncated: boolean;
      fields: string[];
      omittedFieldCount: number;
      actionCounts: { referenced: number; included: number; omitted: number; missing: number };
    };
  }>;
  nextCursor: string | null;
}

async function portOf(server: Server): Promise<number> {
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function episode(index: number, actionIds: string[], overrides: Partial<Episode> = {}): Episode {
  const startTs = new Date(Date.UTC(2026, 5, 10, 10, index)).toISOString();
  return {
    id: `episode_${String(index).padStart(3, "0")}`,
    type: "context_episode",
    startTs,
    endTs: new Date(Date.parse(startTs) + 30_000).toISOString(),
    summary: `Workflow ${index}`,
    actions: actionIds,
    artifacts: [],
    decisionPoints: [],
    rejectedPaths: [],
    uncertainty: [],
    ...overrides,
  };
}

test("workflow pages use stable newest-first keysets while newer rows arrive", async () => {
  const store = freshStore();
  for (let index = 0; index < 62; index += 1) {
    const id = `action_${String(index).padStart(3, "0")}`;
    const startTs = new Date(Date.UTC(2026, 5, 10, 10, index)).toISOString();
    store.actions.put(action({ id, action: "edited_file", startTs }));
    store.episodes.put(episode(index, [id]));
  }
  const server = startStudio(store, 0);
  const base = `http://127.0.0.1:${await portOf(server)}`;
  try {
    const first = await fetch(`${base}/api/workflows?limit=999`).then((response) => response.json()) as WorkflowPage;
    assert.equal(first.items.length, 25);
    assert.equal(first.items[0]?.episode.id, "episode_061");
    assert.equal(first.items[24]?.episode.id, "episode_037");
    assert.equal(typeof first.nextCursor, "string");

    // A newest insert must not shift the continuation window or duplicate a
    // row already returned on page one.
    store.actions.put(action({ id: "action_new", action: "edited_file", startTs: "2026-06-12T10:00:00.000Z" }));
    store.episodes.put({
      ...episode(100, ["action_new"]),
      id: "episode_new",
      startTs: "2026-06-12T10:00:00.000Z",
      endTs: "2026-06-12T10:01:00.000Z",
    });
    const second = await fetch(`${base}/api/workflows?limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`).then((response) => response.json()) as WorkflowPage;
    assert.equal(second.items.length, 25);
    assert.equal(second.items[0]?.episode.id, "episode_036");
    assert.equal(second.items[24]?.episode.id, "episode_012");
    assert.equal(typeof second.nextCursor, "string");
    assert.equal(second.items.some((item) => item.episode.id === "episode_new"), false);

    const last = await fetch(`${base}/api/workflows?limit=25&cursor=${encodeURIComponent(second.nextCursor!)}`).then((response) => response.json()) as WorkflowPage;
    assert.equal(last.items.length, 12);
    assert.equal(last.items[0]?.episode.id, "episode_011");
    assert.equal(last.items[11]?.episode.id, "episode_000");
    assert.equal(last.nextCursor, null);

    const malformed = await fetch(`${base}/api/workflows?limit=nope`).then((response) => response.json()) as WorkflowPage;
    assert.equal(malformed.items.length, 25);
    assert.equal(malformed.items[0]?.episode.id, "episode_new");
    assert.equal((await fetch(`${base}/api/workflows?cursor=not+base64`)).status, 400);
    const invalidTimestamp = Buffer.from(JSON.stringify({ v: 1, startTs: "yesterday", id: "episode_1" })).toString("base64url");
    assert.equal((await fetch(`${base}/api/workflows?cursor=${invalidTimestamp}`)).status, 400);
  } finally {
    await close(server);
    store.close();
  }
});

test("workflow projection omits payloads and explicitly reports bounded fields", async () => {
  const store = freshStore();
  const marker = "must-not-cross-the-workflow-api";
  store.actions.put({
    ...action({
      id: "action_projection",
      action: "edited_file",
      startTs: "2026-06-10T10:00:00.000Z",
      app: "A".repeat(400),
      text: "T".repeat(3_000),
      evidence: Array.from({ length: 30 }, (_, index) => `evidence-${index}-${"e".repeat(200)}`),
      uncertainty: Array.from({ length: 20 }, () => "u".repeat(600)),
      payload: { marker },
    }),
    window: "W".repeat(800),
    reconstructedBy: Array.from({ length: 20 }, () => "rule." + "r".repeat(200)),
  });
  store.episodes.put(episode(0, ["action_projection"], {
    summary: "S".repeat(3_000),
    artifacts: Array.from({ length: 70 }, () => "a".repeat(600)),
    decisionPoints: Array.from({ length: 40 }, () => "d".repeat(600)),
    rejectedPaths: Array.from({ length: 40 }, () => "r".repeat(600)),
    uncertainty: Array.from({ length: 40 }, () => "u".repeat(600)),
    payload: { marker },
  }));
  const server = startStudio(store, 0);
  const base = `http://127.0.0.1:${await portOf(server)}`;
  try {
    const response = await fetch(`${base}/api/workflows?limit=1`);
    const body = await response.text();
    const page = JSON.parse(body) as WorkflowPage;
    const item = page.items[0]!;
    assert.ok(Buffer.byteLength(body, "utf8") < 5_000_000);
    assert.equal(body.includes(marker), false);
    assert.equal(Object.hasOwn(item.episode, "payload"), false);
    assert.equal(Object.hasOwn(item.actions[0]!, "payload"), false);
    assert.equal(item.episode.summary.length, 2_000);
    assert.equal(item.episode.artifacts.length, 64);
    assert.equal(item.actions[0]?.text?.length, 2_000);
    assert.equal(item.actions[0]?.evidence.length, 24);
    assert.equal(item.truncation.truncated, true);
    assert.ok(item.truncation.fields.includes("episode.summary"));
    assert.match(item.episode.uncertainty.at(-1) ?? "", /review incomplete/);
  } finally {
    await close(server);
    store.close();
  }
});

test("an oversized episode reduces actions at the byte guard and remains resumable", async () => {
  const store = freshStore();
  const large = (episodeIndex: number) => {
    const actionIds: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      const id = `large_${episodeIndex}_${index}`;
      actionIds.push(id);
      store.actions.put({
        ...action({
          id,
          action: "x".repeat(200),
          app: "a".repeat(300),
          startTs: `2026-06-10T1${episodeIndex}:00:00.000Z`,
          text: "t".repeat(2_500),
          evidence: Array.from({ length: 30 }, () => "e".repeat(200)),
          uncertainty: Array.from({ length: 16 }, () => "u".repeat(600)),
        }),
        window: "w".repeat(600),
        reconstructedBy: Array.from({ length: 20 }, () => "r".repeat(200)),
      });
    }
    store.episodes.put(episode(episodeIndex, actionIds));
  };
  large(0);
  large(1);
  const server = startStudio(store, 0);
  const base = `http://127.0.0.1:${await portOf(server)}`;
  try {
    const firstResponse = await fetch(`${base}/api/workflows?limit=25`);
    const firstBody = await firstResponse.text();
    const first = JSON.parse(firstBody) as WorkflowPage;
    assert.ok(Buffer.byteLength(firstBody, "utf8") < 5_000_000);
    assert.equal(first.items.length, 1);
    assert.equal(typeof first.nextCursor, "string");
    assert.equal(first.items[0]?.truncation.actionCounts.referenced, 400);
    assert.equal(first.items[0]?.truncation.actionCounts.included, 200);
    assert.equal(first.items[0]?.truncation.actionCounts.omitted, 200);
    assert.match(first.items[0]?.episode.uncertainty.at(-1) ?? "", /included 200 of 400/);

    const secondResponse = await fetch(`${base}/api/workflows?limit=25&cursor=${encodeURIComponent(first.nextCursor!)}`);
    const secondBody = await secondResponse.text();
    const second = JSON.parse(secondBody) as WorkflowPage;
    assert.ok(Buffer.byteLength(secondBody, "utf8") < 5_000_000);
    assert.equal(second.items[0]?.episode.id, "episode_000");
    assert.equal(second.nextCursor, null);
  } finally {
    await close(server);
    store.close();
  }
});
