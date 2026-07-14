import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/core/hash.ts";
import { normalizeCoordinationPayload } from "../src/mesh/coordination.ts";
import { PrivacyControlStore } from "../src/privacy/control.ts";
import {
  acknowledgeSteeringDirective,
  claimSteeringDirective,
} from "../src/studio/directives.ts";
import { freshStore } from "./helpers.ts";

let priorTeam: string | undefined;

beforeEach(() => {
  priorTeam = process.env.PRAXIS_MESH_TEAM_ID;
  process.env.PRAXIS_MESH_TEAM_ID = "team-praxis";
});

afterEach(() => {
  if (priorTeam === undefined) delete process.env.PRAXIS_MESH_TEAM_ID;
  else process.env.PRAXIS_MESH_TEAM_ID = priorTeam;
});

function coordination(actionId = 7, ts = "2026-07-13T12:00:00.000Z"): unknown {
  return {
    generatedAt: ts,
    activities: [{
      id: "activity-agent-1",
      seq: 9,
      person: "alice",
      ts,
      sourceKinds: ["agent_session"],
      sourceId: "source-agent-1",
      signal: "activity",
      summary: "Implementing the rollout",
      status: "active",
      entities: [],
      artifacts: [{ repo: "acme/praxis", path: "src/index.ts" }],
      sessionKey: "session-123",
    }],
    relationships: [],
    initiatives: [],
    actions: [{
      id: actionId,
      person: "alice",
      targets: ["activity-agent-1"],
      triggerClass: "decision_impacts_work",
      ts,
      severity: "urgent",
      message: "Pause: the API contract changed",
      evidence: ["ctx:one", "not/a/safe/ref"],
      receipts: [],
    }],
  };
}

function grant(store: ReturnType<typeof freshStore>, enabled = true): void {
  PrivacyControlStore.forStore(store).update({
    meshProjectConsents: [{ workspaceRoot: "/Users/alice/work/praxis", project: "acme/praxis" }],
    meshContextSourceConsents: [{
      id: "source-agent-1",
      kind: "agent_session",
      localSelector: "/Users/alice/work/praxis",
      initiativeIds: [],
      enabled,
    }],
  });
}

test("targeted directives are bounded and claimed exactly once across concurrent agent polls", async () => {
  const store = freshStore();
  try {
    grant(store);
    let calls = 0;
    const options = {
      sessionKey: "session-123",
      cwd: "/Users/alice/work/praxis/packages/api",
      person: "alice",
      token: "local-token",
      conductorUrl: "http://127.0.0.1:4610",
      now: new Date("2026-07-13T12:05:00.000Z"),
      fetchFn: (async () => {
        calls += 1;
        return new Response(JSON.stringify(coordination()), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    };
    const claims = await Promise.all([
      claimSteeringDirective(store, options),
      claimSteeringDirective(store, options),
    ]);
    const delivered = claims.flatMap((claim) => claim.directive ? [claim.directive] : []);
    const directiveId = `coordination:7:${sha256("session-123").slice(0, 16)}`;
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0], {
      id: directiveId,
      kind: "requires_review",
      summary: "Pause: the API contract changed",
      evidenceIds: ["ctx:one"],
      expiresAt: "2026-07-13T12:30:00.000Z",
    });
    assert.deepEqual(await claimSteeringDirective(store, options), { directive: null });
    assert.ok(calls >= 2);

    const secondPayload = coordination() as {
      actions: Array<{ targets: string[] }>;
    };
    secondPayload.actions[0]!.targets.push("session-456");
    const secondSession = await claimSteeringDirective(store, {
      ...options,
      sessionKey: "session-456",
      fetchFn: (async () => new Response(JSON.stringify(secondPayload))) as typeof fetch,
    });
    assert.equal(
      secondSession.directive?.id,
      `coordination:7:${sha256("session-456").slice(0, 16)}`,
      "one action can be claimed once by each explicitly targeted session",
    );

    const reports: Array<{ url: string; auth: string | null; body: string }> = [];
    const reportOptions = {
      token: "conductor-token",
      conductorUrl: "http://127.0.0.1:4610",
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        reports.push({
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
          body: String(init?.body),
        });
        return new Response(JSON.stringify({ ok: true }));
      }) as typeof fetch,
    };
    assert.deepEqual(
      await acknowledgeSteeringDirective(store, directiveId, options.now, reportOptions),
      { ok: true },
    );
    assert.deepEqual(
      await acknowledgeSteeringDirective(store, directiveId, options.now, reportOptions),
      { ok: true },
    );
    assert.deepEqual(reports, [
      {
        url: "http://127.0.0.1:4610/v1/interventions/7/agent-delivered",
        auth: "Bearer conductor-token",
        body: JSON.stringify({ sessionKey: "session-123" }),
      },
      {
        url: "http://127.0.0.1:4610/v1/interventions/7/agent-delivered",
        auth: "Bearer conductor-token",
        body: JSON.stringify({ sessionKey: "session-123" }),
      },
    ]);
    assert.deepEqual(
      await acknowledgeSteeringDirective(store, directiveId, options.now, {
        ...reportOptions,
        fetchFn: (async () => { throw new Error("conductor down"); }) as typeof fetch,
      }),
      { ok: true },
      "a reporting outage cannot revoke the local receipt",
    );
    const row = store.db.prepare(`
      SELECT acked_at FROM mesh_directive_claims WHERE directive_id = ?
    `).get(directiveId) as { acked_at: string };
    assert.equal(row.acked_at, options.now.toISOString());
  } finally {
    store.close();
  }
});

test("directive claim fails closed on expired work, revoked source consent, or missing repo grant", async () => {
  const store = freshStore();
  try {
    grant(store);
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(JSON.stringify(coordination(8, "2026-07-13T10:00:00.000Z")));
    }) as typeof fetch;
    const base = {
      sessionKey: "session-123",
      cwd: "/Users/alice/work/praxis",
      person: "alice",
      token: "local-token",
      conductorUrl: "http://127.0.0.1:4610",
      now: new Date("2026-07-13T12:05:00.000Z"),
      fetchFn,
    };
    assert.deepEqual(await claimSteeringDirective(store, base), { directive: null });
    assert.deepEqual(await claimSteeringDirective(store, {
      ...base,
      fetchFn: (async () => {
        calls += 1;
        return new Response(JSON.stringify(coordination(9, "2026-07-14T12:00:00.000Z")));
      }) as typeof fetch,
    }), { directive: null }, "far-future timestamps cannot bypass directive expiry");
    PrivacyControlStore.forStore(store).update({
      meshContextSourceConsents: [{
        id: "source-agent-1",
        kind: "agent_session",
        localSelector: "/Users/alice/work/praxis",
        initiativeIds: [],
        enabled: false,
      }],
    });
    assert.deepEqual(await claimSteeringDirective(store, base), { directive: null });
    assert.equal(calls, 2, "revocation is checked before contacting the conductor");

    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [],
      meshContextSourceConsents: [{
        id: "source-agent-1",
        kind: "agent_session",
        localSelector: "*",
        initiativeIds: [],
        enabled: true,
      }],
    });
    assert.deepEqual(await claimSteeringDirective(store, base), { directive: null });
    assert.equal(calls, 2);
  } finally {
    store.close();
  }
});

test("coordination normalization strips paths, oversized fields, and unknown wire data", () => {
  const normalized = normalizeCoordinationPayload({
    ...(coordination() as Record<string, unknown>),
    actions: [{
      ...(coordination() as { actions: Array<Record<string, unknown>> }).actions[0],
      message: `Inspect /Users/alice/private ${"x".repeat(2_000)}`,
      evidence: ["safe-ref", "../../unsafe", "x".repeat(200)],
      rawPrompt: "must never survive",
    }],
  });
  assert.ok(normalized);
  assert.ok(normalized.actions[0]!.message.length <= 500);
  assert.equal(normalized.actions[0]!.message.includes("/Users/alice"), false);
  assert.deepEqual(normalized.actions[0]!.evidence, ["safe-ref"]);
  assert.equal("rawPrompt" in normalized.actions[0]!, false);
});
