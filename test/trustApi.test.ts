import assert from "node:assert/strict";
import { test } from "node:test";
import type { Server } from "node:http";
import { startStudio } from "../src/studio/server.ts";
import { EgressAuditor } from "../src/privacy/egress.ts";
import { RuntimeStatusStore } from "../src/capture/runtimeStatus.ts";
import { action, freshStore } from "./helpers.ts";

async function portOf(server: Server): Promise<number> {
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("trust APIs round-trip privacy, pause/runtime, egress, and retention", async () => {
  const store = freshStore();
  const runtimeStore = RuntimeStatusStore.forStore(store);
  const accessibilityEventAt = new Date().toISOString();
  const agentEventAt = new Date().toISOString();
  const screenEventAt = new Date().toISOString();
  const systemAudioEventAt = new Date().toISOString();
  runtimeStore.write({
    state: "running",
    activeSources: ["native-stdin", "agent_sessions"],
    pid: 42,
    sourceLastEventAt: {
      accessibility: accessibilityEventAt,
      ai_proxy: agentEventAt,
    },
    channelLastEventAt: {
      screen_recording: screenEventAt,
      audio_system: systemAudioEventAt,
    },
    sourceReadiness: {
      screen_recording: { status: "ready", updatedAt: screenEventAt },
      accessibility: { status: "ready", updatedAt: accessibilityEventAt },
      agent_sessions: { status: "ready", updatedAt: agentEventAt },
      audio_system: { status: "ready", updatedAt: systemAudioEventAt },
      audio_mic: { status: "disabled", reason: "not-requested", updatedAt: systemAudioEventAt },
    },
    interpretation: {
      requested: "anthropic",
      active: "offline",
      status: "fallback",
      model: "mock",
      reason: "credential-missing",
    },
  });
  EgressAuditor.forStore(store).record({
    destination: "https://api.example.test/v1",
    purpose: "test",
    categories: ["metadata"],
    bytes: 12,
    outcome: "succeeded",
  });
  const server = startStudio(store, 0);
  const port = await portOf(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const privacy = await fetch(`${base}/api/privacy`).then((r) => r.json()) as { mode: string };
    assert.equal(privacy.mode, "normal");

    const updated = await fetch(`${base}/api/privacy`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ ...privacy, cloudObserverConsent: true, screenshotConsent: false }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { cloudObserverConsent: boolean }).cloudObserverConsent, true);

    const pause = await fetch(`${base}/api/capture/pause`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ minutes: 5 }),
    });
    assert.equal((await pause.json() as { mode: string }).mode, "paused");
    const resume = await fetch(`${base}/api/capture/resume`, {
      method: "POST",
      headers: { origin: base },
    });
    assert.equal((await resume.json() as { mode: string }).mode, "normal");

    const runtime = await fetch(`${base}/api/capture/status`).then((r) => r.json()) as {
      state: string;
      health: {
        daemon: { status: string };
        screenContext: { status: string; lastEventAt: string };
        accessibility: { status: string; lastEventAt: string };
        agentContext: { status: string; lastEventAt: string };
        systemAudio: { status: string; lastEventAt: string };
        microphoneAudio: { status: string; reason: string };
        interpretation: { status: string; reason: string };
      };
    };
    assert.equal(runtime.state, "running");
    assert.deepEqual(runtime.health, {
      daemon: { status: "connected" },
      screenContext: { status: "receiving", lastEventAt: screenEventAt },
      accessibility: { status: "receiving", lastEventAt: accessibilityEventAt },
      agentContext: { status: "receiving", lastEventAt: agentEventAt },
      systemAudio: { status: "receiving", lastEventAt: systemAudioEventAt },
      microphoneAudio: { status: "disabled", reason: "not-requested" },
      interpretation: {
        requested: "anthropic",
        active: "offline",
        status: "fallback",
        model: "mock",
        reason: "credential-missing",
      },
    });

    runtimeStore.write({
      sourceLastEventAt: {},
      channelLastEventAt: { screen_recording: "2020-01-01T00:00:00.000Z" },
      sourceReadiness: {
        screen_recording: {
          status: "ready",
          updatedAt: new Date().toISOString(),
        },
        accessibility: {
          status: "blocked",
          reason: "permission-not-granted",
          updatedAt: new Date().toISOString(),
        },
        agent_sessions: {
          status: "unavailable",
          reason: "transcript-directory-missing",
          updatedAt: new Date().toISOString(),
        },
        audio_system: {
          status: "disabled",
          reason: "not-requested",
          updatedAt: new Date().toISOString(),
        },
        audio_mic: {
          status: "unavailable",
          reason: "no-on-device-model",
          updatedAt: new Date().toISOString(),
        },
      },
    });
    const blockedHealth = await fetch(`${base}/api/capture/status`).then((r) => r.json()) as {
      health: {
        screenContext: { status: string; lastEventAt: string };
        accessibility: { status: string; reason: string };
        agentContext: { status: string; reason: string };
        systemAudio: { status: string; reason: string };
        microphoneAudio: { status: string; reason: string };
      };
    };
    assert.deepEqual(blockedHealth.health.screenContext, {
      status: "watching",
      lastEventAt: "2020-01-01T00:00:00.000Z",
    });
    assert.deepEqual(blockedHealth.health.accessibility, {
      status: "blocked",
      reason: "permission-not-granted",
    });
    assert.deepEqual(blockedHealth.health.agentContext, {
      status: "unavailable",
      reason: "transcript-directory-missing",
    });
    assert.deepEqual(blockedHealth.health.systemAudio, {
      status: "disabled",
      reason: "not-requested",
    });
    assert.deepEqual(blockedHealth.health.microphoneAudio, {
      status: "unavailable",
      reason: "no-on-device-model",
    });
    const resources = await fetch(`${base}/api/runtime/resources`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ powerSource: "battery", suspended: true, batteryAware: true }),
    });
    const resourceStatus = await resources.json() as {
      effectiveState: string;
      resources: { powerSource: string; suspended: boolean; batteryAware: boolean; updatedAt: string };
    };
    assert.equal(resourceStatus.effectiveState, "suspended");
    assert.deepEqual(resourceStatus.resources, {
      powerSource: "battery",
      suspended: true,
      batteryAware: true,
      updatedAt: resourceStatus.resources.updatedAt,
    });
    const egress = await fetch(`${base}/api/egress`).then((r) => r.json()) as Array<{ purpose: string }>;
    assert.equal(egress[0]?.purpose, "test");

    const retention = await fetch(`${base}/api/storage/retention`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ rawDays: 20, mediaDays: 3, derivedDays: 60, maxBytes: 123456 }),
    });
    assert.equal((await retention.json() as { rawDays: number }).rawDays, 20);
    const status = await fetch(`${base}/api/storage/status`).then((r) => r.json()) as {
      usage: { totalBytes: number };
      retention: { mediaDays: number };
    };
    assert.equal(status.retention.mediaDays, 3);
    assert.equal(typeof status.usage.totalBytes, "number");
  } finally {
    await close(server);
    store.close();
  }
});

test("Studio mutations reject bodies larger than 64 KiB", async () => {
  const store = freshStore();
  const server = startStudio(store, 0);
  const port = await portOf(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetKind: "claim", targetId: "c", verdict: "edited", note: "x".repeat(70_000) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await close(server);
    store.close();
  }
});

test("question answers require authored text and dismiss semantic duplicates persistently", async () => {
  const store = freshStore();
  const questionAction = action({
    id: "trust_question_action",
    action: "answered_question",
    startTs: "2026-07-13T00:00:00.000Z",
  });
  store.actions.put(questionAction);
  store.decisions.put({
    id: "decision_old",
    kind: "ask_expert",
    reason: "unclear order",
    question: "Should the migration happen before the production rollout?",
    evidence: [questionAction.id],
    createdTs: "2026-07-13T00:00:00.000Z",
  });
  store.decisions.put({
    id: "decision_new",
    kind: "ask_expert",
    reason: "same unclear order",
    question: "Should the database migration run before the production rollout?",
    evidence: [questionAction.id],
    createdTs: "2026-07-13T00:01:00.000Z",
  });
  const server = startStudio(store, 0);
  const port = await portOf(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const before = await fetch(`${base}/api/questions`).then((response) => response.json()) as {
      agent: Array<{ questionId: string }>;
    };
    assert.equal(before.agent.length, 1, "semantic duplicates collapse into one question");

    const placeholder = await fetch(`${base}/api/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        questionId: before.agent[0]!.questionId,
        question: "Should the migration happen before the production rollout?",
        answer: "Close, but not quite",
      }),
    });
    assert.equal(placeholder.status, 400, "an option label is not stored as knowledge");

    const directPlaceholder = await fetch(`${base}/api/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        questionId: before.agent[0]!.questionId,
        question: "Should the migration happen before the production rollout?",
        answer: "No — correct it",
      }),
    });
    assert.equal(directPlaceholder.status, 400, "a correction control label is rejected server-side");

    const dismissed = await fetch(`${base}/api/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        questionId: before.agent[0]!.questionId,
        question: "Should the migration happen before the production rollout?",
        dismissed: true,
      }),
    });
    assert.equal(dismissed.status, 200);
    assert.equal((await dismissed.json() as { verdict: string }).verdict, "rejected");

    const after = await fetch(`${base}/api/questions`).then((response) => response.json()) as {
      agent: unknown[];
    };
    assert.equal(after.agent.length, 0, "dismissal suppresses future semantic duplicates");

    const correction = await fetch(`${base}/api/correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetKind: "action",
        targetId: "action_noise",
        verdict: "edited",
        correctedText: "No — I was doing something else",
      }),
    });
    assert.equal(correction.status, 400, "negative cards require actual replacement text");
  } finally {
    await close(server);
    store.close();
  }
});

test("correction and answer APIs reject nonexistent targets without writing receipts", async () => {
  const store = freshStore();
  const server = startStudio(store, 0);
  const port = await portOf(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const targetKind of ["action", "episode", "claim", "observation", "decision"] as const) {
      const response = await fetch(`${base}/api/correction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetKind, targetId: "missing", verdict: "confirmed" }),
      });
      assert.equal(response.status, 404, targetKind);
    }
    const answer = await fetch(`${base}/api/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "missing", answer: "Use the safe rollout order." }),
    });
    assert.equal(answer.status, 404);
    assert.equal(store.corrections.all().length, 0);
  } finally {
    await close(server);
    store.close();
  }
});

test("Studio validates correction and answer targets inside the writer transaction", async () => {
  const store = freshStore();
  const evidence = action({
    id: "transaction_evidence",
    action: "answered_question",
    startTs: "2026-07-13T00:00:00.000Z",
  });
  store.actions.put(evidence);
  store.decisions.put({
    id: "transaction_question",
    kind: "ask_expert",
    reason: "rollout order needs confirmation",
    question: "Which rollout order should we use?",
    evidence: [evidence.id],
    createdTs: "2026-07-13T00:00:01.000Z",
  });

  let actionCheckInTransaction = false;
  let decisionCheckInTransaction = false;
  let missingCheckInTransaction = false;
  const getAction = store.actions.get;
  const getDecision = store.decisions.get;
  const getClaim = store.claims.get;
  store.actions.get = (id) => {
    if (id === evidence.id) actionCheckInTransaction = store.db.isTransaction;
    return getAction(id);
  };
  store.decisions.get = (id) => {
    if (id === "transaction_question") {
      decisionCheckInTransaction = store.db.isTransaction;
    }
    return getDecision(id);
  };
  store.claims.get = (id) => {
    if (id === "missing_transaction_claim") {
      missingCheckInTransaction = store.db.isTransaction;
    }
    return getClaim(id);
  };

  const server = startStudio(store, 0);
  const port = await portOf(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const correction = await fetch(`${base}/api/correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetKind: "action",
        targetId: evidence.id,
        verdict: "confirmed",
      }),
    });
    assert.equal(correction.status, 200);
    assert.equal((await correction.json() as { origin?: string }).origin, "human");

    const answer = await fetch(`${base}/api/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        questionId: "transaction_question",
        question: "Which rollout order should we use?",
        answer: "Run the migration before the production rollout.",
      }),
    });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json() as { origin?: string }).origin, "human");

    const missing = await fetch(`${base}/api/correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetKind: "claim",
        targetId: "missing_transaction_claim",
        verdict: "confirmed",
      }),
    });
    assert.equal(missing.status, 404);

    assert.equal(actionCheckInTransaction, true);
    assert.equal(decisionCheckInTransaction, true);
    assert.equal(missingCheckInTransaction, true);
    assert.equal(store.db.isTransaction, false, "404 validation rolls back the writer transaction");
    assert.equal(store.corrections.all().length, 2);
  } finally {
    await close(server);
    store.close();
  }
});
