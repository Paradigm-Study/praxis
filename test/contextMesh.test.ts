import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Episode } from "../src/core/types.ts";
import { makeIngest } from "../src/capture/ingest.ts";
import {
  contextSourceWireId,
  episodeToContextFrames,
  isContextFrameCurrentlyConsented,
} from "../src/mesh/contextFrame.ts";
import { MeshPublisher } from "../src/mesh/publisher.ts";
import {
  PrivacyControlStore,
  defaultPrivacyControl,
  type MeshContextSourceConsent,
} from "../src/privacy/control.ts";
import { action, freshStore } from "./helpers.ts";

function episode(id: string, actions: string[], artifacts: string[] = []): Episode {
  return {
    id,
    type: "context_episode",
    startTs: "2026-07-13T12:00:00.000Z",
    endTs: "2026-07-13T12:01:00.000Z",
    summary: "Architecture review activity",
    actions,
    artifacts,
    decisionPoints: [],
    rejectedPaths: [],
    uncertainty: [],
  };
}

test("context frames are default-off and project only the selected source grant", () => {
  const store = freshStore();
  try {
    const event = makeIngest(store).ingest({
      ts: "2026-07-13T12:00:00.000Z",
      source: "audio",
      app: "Zoom",
      window: "Secret client architecture review",
      type: "transcript_segment",
      payload: { text: "private transcript" },
    });
    const meeting = action({
      id: "action-meeting",
      action: "attended_meeting",
      app: "Zoom",
      window: "Secret client architecture review",
      startTs: event.ts,
      evidence: [event.id],
    });
    store.actions.put(meeting);
    const item = episode("episode-meeting", [meeting.id]);
    store.observations.put({
      id: "obs-meeting",
      bundleId: "bundle-meeting",
      episodeId: item.id,
      decisionPoint: "Adopt the event-driven rollout plan",
      acceptedOptions: ["event-driven"],
      rejectedOptions: [],
      uncertainty: [],
      evidence: [meeting.id],
      model: "mock",
      createdTs: item.endTs,
    });

    assert.deepEqual(episodeToContextFrames(item, {
      person: "alice",
      device: "laptop",
      store,
      control: defaultPrivacyControl(),
      status: "done",
    }), []);

    const control = PrivacyControlStore.forStore(store).update({
      meshContextSourceConsents: [{
        id: "source-meeting-1",
        kind: "meeting",
        localSelector: "Secret client architecture review",
        sharedLabel: "Architecture sync",
        initiativeIds: ["initiative-praxis"],
        enabled: true,
      }],
    });
    const frames = episodeToContextFrames(item, {
      person: "alice",
      device: "laptop",
      store,
      control,
      status: "done",
    });
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.source.kind, "meeting");
    assert.equal(frames[0]!.source.id, contextSourceWireId(control.meshContextSourceConsents[0]!));
    assert.equal(frames[0]!.source.label, "Architecture sync");
    assert.equal(frames[0]!.status, "done");
    assert.equal(frames[0]!.signal, "decision");
    assert.equal(frames[0]!.summary, "Adopt the event-driven rollout plan");
    assert.deepEqual(frames[0]!.entities, [{ kind: "initiative", key: "initiative-praxis" }]);
    assert.deepEqual(frames[0]!.evidenceRefs, [event.hash]);
    const active = episodeToContextFrames(item, {
      person: "alice",
      device: "laptop",
      store,
      control,
      status: "active",
    })[0]!;
    assert.notEqual(active.id, frames[0]!.id);
    assert.deepEqual(frames[0]!.links, [{
      relation: "updates",
      targetId: active.id,
      reason: "Episode completed",
    }]);
    const wire = JSON.stringify(frames[0]);
    assert.equal(wire.includes("localSelector"), false);
    assert.equal(wire.includes("Secret client architecture review"), false);
    assert.equal(wire.includes("private transcript"), false);
  } finally {
    store.close();
  }
});

test("agent-session context requires both source and repo-workspace consent", () => {
  const store = freshStore();
  try {
    const fileAction = action({
      id: "action-agent-file",
      action: "edited_file",
      app: "Claude Code",
      startTs: "2026-07-13T12:00:00.000Z",
      payload: {
        cwd: "/Users/alice/work/praxis",
        filePath: "/Users/alice/work/praxis/src/index.ts",
        sessionKey: "session-123",
      },
    });
    store.actions.put(fileAction);
    const item = episode("episode-agent", [fileAction.id], ["/Users/alice/work/praxis/src/index.ts"]);
    const control = PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [{ workspaceRoot: "/Users/alice/work/praxis", project: "acme/praxis" }],
      meshContextSourceConsents: [{
        id: "source-agent-1",
        kind: "agent_session",
        localSelector: "/Users/alice/work/praxis",
        initiativeIds: [],
        enabled: true,
      }],
    });
    assert.equal(episodeToContextFrames(item, {
      person: "alice",
      device: "laptop",
      store,
      control,
      status: "active",
    }).some((frame) => frame.source.kind === "agent_session"), false);
    const frame = episodeToContextFrames(item, {
      person: "alice",
      device: "laptop",
      store,
      control,
      status: "active",
      project: { project: "acme/praxis", repoRoot: "/Users/alice/work/praxis" },
    }).find((candidate) => candidate.source.kind === "agent_session");
    assert.ok(frame);
    assert.equal(frame.sessionKey, "session-123");
    assert.deepEqual(frame.artifacts, [{ repo: "acme/praxis", path: "src/index.ts" }]);
  } finally {
    store.close();
  }
});

test("v1 publisher uses stable context idempotency and drops spooled data after revocation", async () => {
  const store = freshStore();
  const dir = mkdtempSync(join(tmpdir(), "praxis-context-publisher-"));
  const spoolPath = join(dir, "spool.ndjson");
  let grant: MeshContextSourceConsent = {
    id: "source-meeting-1",
    kind: "meeting",
    localSelector: "Zoom",
    initiativeIds: [],
    enabled: true,
  };
  let calls = 0;
  try {
    const frame = {
      v: 1 as const,
      id: "ctx:stable-1",
      kind: "context_frame" as const,
      person: "alice",
      device: "laptop",
      ts: "2026-07-13T12:00:00.000Z",
      source: { kind: "meeting" as const, id: contextSourceWireId(grant), label: "Team sync" },
      signal: "activity" as const,
      summary: "Reviewing the rollout",
      status: "active" as const,
      entities: [],
      artifacts: [],
      links: [],
      uncertainty: [],
      claimsTouched: [],
      evidenceRefs: [],
    };
    let key = "";
    let sentBody = "";
    const publisher = new MeshPublisher({
      url: "https://relay.example.test",
      token: "token",
      person: "alice",
      device: "laptop",
      store,
      currentContextConsent: (candidate) => isContextFrameCurrentlyConsented({
        ...defaultPrivacyControl(),
        meshContextSourceConsents: [grant],
      }, candidate),
      fetchFn: (async (_input, init) => {
        calls += 1;
        key = new Headers(init?.headers).get("idempotency-key") ?? "";
        sentBody = String(init?.body ?? "");
        throw new Error("relay down");
      }) as typeof fetch,
      configPath: join(dir, "missing.json"),
      spoolPath,
    });
    assert.equal((await publisher.publish({
      ...frame,
      source: { ...frame.source, localSelector: "/Users/alice/private" },
      localSelector: "/Users/alice/private",
    } as typeof frame)).ok, false);
    assert.equal(key, "praxis:context:ctx:stable-1");
    assert.equal(sentBody.includes("localSelector"), false);
    assert.equal(sentBody.includes("/Users/alice"), false);
    assert.equal(existsSync(spoolPath), true);
    grant = { ...grant, localSelector: "Google Meet" };
    assert.equal((await publisher.publish({ ...frame, id: "ctx:stable-2" })).ok, false);
    assert.equal(calls, 1, "selector mutation revokes old frames and spool retries before network");
    assert.equal(existsSync(spoolPath), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
