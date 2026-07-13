import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { PrivacyControlStore } from "../src/privacy/control.ts";
import { buildTeamGate } from "../src/studio/teamGate.ts";
import { freshStore } from "./helpers.ts";

const ENV_KEYS = [
  "PRAXIS_MESH_URL",
  "PRAXIS_MESH_TOKEN",
  "PRAXIS_PERSON",
  "PRAXIS_MESH_TEAM_ID",
  "PRAXIS_MESH_DEVICE_ID",
  "PRAXIS_MESH_ROSTER_JSON",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("team gate derives a consented relative path and hides hosted identities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-team-gate-"));
  const root = join(dir, "app");
  const target = join(root, "src", "auth.ts");
  mkdirSync(join(root, "src"), { recursive: true });
  const store = freshStore();
  try {
    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [{ workspaceRoot: root, project: "git@github.com:Acme/App.git" }],
    });
    process.env.PRAXIS_MESH_URL = "https://relay.example.test";
    process.env.PRAXIS_MESH_TOKEN = "hosted-secret";
    process.env.PRAXIS_PERSON = "member-aaaaaaaaaaaaaaaaaaaaaaaa";
    process.env.PRAXIS_MESH_TEAM_ID = "team-1";
    process.env.PRAXIS_MESH_DEVICE_ID = "device-1";
    process.env.PRAXIS_MESH_ROSTER_JSON = JSON.stringify({
      "member-bbbbbbbbbbbbbbbbbbbbbbbb": "Kim Example",
    });

    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const result = await buildTeamGate(store, {
      cwd: join(root, "src"),
      path: target,
      fetchFn: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({
          conflict: true,
          conflicts: [{
            person: "member-bbbbbbbbbbbbbbbbbbbbbbbb",
            kind: "active_edit",
            detail: "member-bbbbbbbbbbbbbbbbbbbbbbbb has an active workframe touching src/auth.ts",
            ts: "2026-07-12T12:00:00.000Z",
          }],
        }));
      },
    });

    const url = new URL(requestUrl);
    assert.equal(url.pathname, "/gate");
    assert.equal(url.searchParams.get("person"), "member-aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(url.searchParams.get("repo"), "acme/app");
    assert.equal(url.searchParams.get("path"), "src/auth.ts");
    assert.equal(requestUrl.includes(dir), false, "absolute workspace paths stay on-device");
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get("authorization"), "Bearer hosted-secret");
    assert.equal(headers.get("x-mesh-team-id"), "team-1");
    assert.equal(headers.get("x-mesh-device-id"), "device-1");
    assert.equal(requestInit?.redirect, "error");
    assert.deepEqual(result, {
      conflict: true,
      conflicts: [{
        person: "Kim Example",
        kind: "active_edit",
        detail: "Kim Example has an active workframe touching src/auth.ts",
        ts: "2026-07-12T12:00:00.000Z",
      }],
      path: "src/auth.ts",
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("team gate never fetches for unmapped, outside, or unsafe relay inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-team-gate-denied-"));
  const root = join(dir, "app");
  const outside = join(dir, "other", "secret.ts");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(dir, "other"), { recursive: true });
  const store = freshStore();
  try {
    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [{ workspaceRoot: root, project: "acme/app" }],
    });
    process.env.PRAXIS_MESH_URL = "http://localhost:4600";
    process.env.PRAXIS_MESH_TOKEN = "secret";
    process.env.PRAXIS_PERSON = "member-aaaaaaaaaaaaaaaaaaaaaaaa";
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      return new Response("{}");
    };
    assert.deepEqual(await buildTeamGate(store, { cwd: root, path: outside, fetchFn }), {
      conflict: false,
      conflicts: [],
    });
    assert.deepEqual(await buildTeamGate(store, {
      cwd: root,
      path: join(root, "src", "file.ts"),
      fetchFn,
    }), {
      conflict: false,
      conflicts: [],
      path: "src/file.ts",
    });
    process.env.PRAXIS_MESH_URL = "https://relay.example.test";
    assert.deepEqual(await buildTeamGate(store, {
      cwd: root,
      path: join(root, "src", "%2e%2e", "secret.ts"),
      fetchFn,
    }), { conflict: false, conflicts: [] });
    assert.equal(calls, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("team gate rejects a target owned by a more-specific nested consent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-team-gate-nested-"));
  const outer = join(dir, "monorepo");
  const nested = join(outer, "packages", "private-app");
  mkdirSync(join(nested, "src"), { recursive: true });
  const store = freshStore();
  try {
    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [
        { workspaceRoot: outer, project: "acme/monorepo" },
        { workspaceRoot: nested, project: "acme/private-app" },
      ],
    });
    process.env.PRAXIS_MESH_URL = "https://relay.example.test";
    process.env.PRAXIS_MESH_TOKEN = "secret";
    process.env.PRAXIS_PERSON = "member-aaaaaaaaaaaaaaaaaaaaaaaa";
    let calls = 0;
    const result = await buildTeamGate(store, {
      cwd: outer,
      path: join(nested, "src", "file.ts"),
      fetchFn: async () => {
        calls += 1;
        return new Response("{}");
      },
    });
    assert.deepEqual(result, { conflict: false, conflicts: [] });
    assert.equal(calls, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("team gate fails open on oversized relay data without exposing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-team-gate-bounds-"));
  const root = join(dir, "app");
  mkdirSync(join(root, "src"), { recursive: true });
  const store = freshStore();
  try {
    PrivacyControlStore.forStore(store).update({
      meshProjectConsents: [{ workspaceRoot: root, project: "acme/app" }],
    });
    process.env.PRAXIS_MESH_URL = "https://relay.example.test";
    process.env.PRAXIS_MESH_TOKEN = "secret";
    process.env.PRAXIS_PERSON = "member-aaaaaaaaaaaaaaaaaaaaaaaa";
    const result = await buildTeamGate(store, {
      cwd: root,
      path: join(root, "src", "file.ts"),
      fetchFn: async () => new Response("x".repeat(300 * 1024), {
        headers: { "content-length": String(300 * 1024) },
      }),
    });
    assert.deepEqual(result, { conflict: false, conflicts: [], path: "src/file.ts" });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
