import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "../src/studio/brief.ts";
import { PrivacyControlStore } from "../src/privacy/control.ts";
import { freshStore } from "./helpers.ts";

const KEYS = [
  "PRAXIS_MESH_URL",
  "PRAXIS_MESH_TOKEN",
  "PRAXIS_PERSON",
  "PRAXIS_MESH_TEAM_ID",
  "PRAXIS_MESH_DEVICE_ID",
] as const;
const prior = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) prior.set(key, process.env[key]);
  process.env.PRAXIS_MESH_URL = "https://relay.example.test";
  process.env.PRAXIS_MESH_TOKEN = "token";
  process.env.PRAXIS_PERSON = "alice";
  process.env.PRAXIS_MESH_TEAM_ID = "team-praxis";
  process.env.PRAXIS_MESH_DEVICE_ID = "device-praxis";
});

afterEach(() => {
  for (const key of KEYS) {
    const value = prior.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("/api/brief model adds bounded coordination only when a source grant is active", async () => {
  const store = freshStore();
  try {
    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [{ workspaceRoot: "/Users/alice/work/praxis", project: "acme/praxis" }],
      meshContextSourceConsents: [{
        id: "meeting-1",
        kind: "meeting",
        localSelector: "Highly private Zoom title",
        sharedLabel: "Team sync",
        initiativeIds: [],
        enabled: true,
      }],
    });
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.pathname === "/brief") {
        return new Response(JSON.stringify({ teammates: [], lockedSpecs: [], recentDecisions: [] }));
      }
      return new Response(JSON.stringify({
        generatedAt: "2026-07-13T12:05:00.000Z",
        activities: [{
          id: "activity-1",
          seq: 1,
          person: "bob",
          ts: "2026-07-13T12:00:00.000Z",
          sourceKinds: ["meeting", "repository"],
          sourceId: "meeting-1",
          sourceLabel: "Team sync",
          signal: "decision",
          summary: "Ship the event-driven migration",
          status: "done",
          entities: [{ kind: "initiative", key: "initiative-1" }],
          artifacts: [{ repo: "acme/praxis", path: "src/index.ts" }],
        }],
        relationships: [],
        initiatives: [],
        actions: [],
      }));
    }) as typeof fetch;
    const brief = await buildBrief(store, {
      cwd: "/Users/alice/work/praxis",
      fetchFn,
    });
    assert.equal(brief.coordination?.activities[0]?.summary, "Ship the event-driven migration");
    assert.equal(urls.some((value) => new URL(value).pathname === "/v1/coordination"), true);
    assert.equal(urls.some((value) => value.includes("Highly private Zoom title")), false);
    const coordinationUrl = new URL(urls.find((value) => new URL(value).pathname === "/v1/coordination")!);
    assert.equal(coordinationUrl.searchParams.get("person"), "alice");
    assert.equal(coordinationUrl.searchParams.has("cwd"), false);
    assert.equal(coordinationUrl.searchParams.has("project"), false);
  } finally {
    store.close();
  }
});

test("coordination remains absent and uncontacted while all source grants are disabled", async () => {
  const store = freshStore();
  try {
    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [{ workspaceRoot: "/Users/alice/work/praxis", project: "acme/praxis" }],
      meshContextSourceConsents: [{
        id: "meeting-1",
        kind: "meeting",
        localSelector: "Zoom",
        initiativeIds: [],
        enabled: false,
      }],
    });
    const urls: string[] = [];
    const brief = await buildBrief(store, {
      cwd: "/Users/alice/work/praxis",
      fetchFn: (async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ teammates: [], lockedSpecs: [], recentDecisions: [] }));
      }) as typeof fetch,
    });
    assert.equal(brief.coordination, undefined);
    assert.equal(urls.filter((value) => new URL(value).pathname === "/v1/coordination").length, 0);
  } finally {
    store.close();
  }
});
