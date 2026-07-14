import { resolve, sep } from "node:path";
import type { Store } from "../storage/index.ts";
import { sha256 } from "../core/hash.ts";
import { normalizeCoordinationPayload } from "../mesh/coordination.ts";
import { safeMeshRelayBaseUrl, safeMeshWireIdentity, resolveConsentedWorkspaceProject } from "../mesh/projectConsent.ts";
import { PrivacyControlStore } from "../privacy/control.ts";

const MAX_RESPONSE_BYTES = 256 * 1024;
const DIRECTIVE_TTL_MS = 30 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export type SteeringDirectiveKind = "context" | "caution" | "requires_review";

export interface SteeringDirective {
  id: string;
  kind: SteeringDirectiveKind;
  summary: string;
  evidenceIds: string[];
  expiresAt: string;
}

export interface ClaimDirectiveOptions {
  sessionKey: string;
  cwd: string;
  fetchFn?: typeof fetch;
  now?: Date;
  conductorUrl?: string;
  token?: string;
  person?: string;
}

export interface AcknowledgeDirectiveOptions {
  fetchFn?: typeof fetch;
  conductorUrl?: string;
  token?: string;
}

function selectorMatches(selector: string, cwd: string, sessionKey: string): boolean {
  if (selector === "*") return true;
  if (selector.startsWith("/")) {
    const root = resolve(selector);
    const path = resolve(cwd);
    return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  }
  const expected = selector.toLowerCase();
  return sessionKey.toLowerCase() === expected || cwd.toLowerCase().includes(expected);
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("response too large");
  if (!response.body) return JSON.parse(await response.text()) as unknown;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function initialize(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS mesh_directive_claims (
      directive_id TEXT PRIMARY KEY,
      person TEXT NOT NULL,
      session_key TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      acked_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_mesh_directive_claim_session
      ON mesh_directive_claims(person, session_key, claimed_at);
  `);
}

function kindFor(severity: "info" | "warn" | "urgent"): SteeringDirectiveKind {
  if (severity === "urgent") return "requires_review";
  if (severity === "warn") return "caution";
  return "context";
}

/**
 * Fetch bounded local-conductor coordination and atomically claim one action
 * for this person+agent session. A claimed row survives Studio restarts.
 */
export async function claimSteeringDirective(
  store: Store,
  options: ClaimDirectiveOptions,
): Promise<{ directive: SteeringDirective | null }> {
  const person = safeMeshWireIdentity(options.person ?? process.env.PRAXIS_PERSON);
  const sessionKey = safeMeshWireIdentity(options.sessionKey);
  const teamId = safeMeshWireIdentity(process.env.PRAXIS_MESH_TEAM_ID);
  const token = options.token ?? process.env.BOARDROOM_LOCAL_TOKEN;
  const url = safeMeshRelayBaseUrl(options.conductorUrl ?? "http://127.0.0.1:4610");
  if (!person || !sessionKey || !teamId || !token || !url || !options.cwd.startsWith("/")) {
    return { directive: null };
  }

  const control = PrivacyControlStore.forStore(store).read();
  if (!resolveConsentedWorkspaceProject(control.meshProjectConsents, options.cwd)) {
    return { directive: null };
  }
  const sourceGranted = control.meshContextSourceConsents.some((consent) =>
    consent.enabled
    && consent.kind === "agent_session"
    && selectorMatches(consent.localSelector, options.cwd, sessionKey)
  );
  if (!sourceGranted) return { directive: null };

  const response = await (options.fetchFn ?? fetch)(`${url}/v1/coordination`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2_000),
    redirect: "error",
  });
  if (!response.ok) return { directive: null };
  const coordination = normalizeCoordinationPayload(await boundedJson(response));
  if (!coordination) return { directive: null };

  const activityById = new Map(coordination.activities.map((activity) => [activity.id, activity]));
  const candidates = coordination.actions
    .filter((action) => {
      if (action.person !== person || action.verdict) return false;
      if (action.targets.length === 0) return true;
      return action.targets.some((target) => {
        if (target === person || target === sessionKey) return true;
        const activity = activityById.get(target);
        return activity?.person === person && activity.sessionKey === sessionKey;
      });
    })
    .sort((left, right) => {
      const rank = { urgent: 3, warn: 2, info: 1 } as const;
      return rank[right.severity] - rank[left.severity]
        || Date.parse(right.ts) - Date.parse(left.ts)
        || right.id - left.id;
    });

  initialize(store);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  store.db.prepare(`DELETE FROM mesh_directive_claims WHERE expires_at < ?`).run(
    new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
  );
  const insert = store.db.prepare(`
    INSERT OR IGNORE INTO mesh_directive_claims
      (directive_id, person, session_key, claimed_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const action of candidates) {
    const actionMs = Date.parse(action.ts);
    if (!Number.isFinite(actionMs) || actionMs > now.getTime() + MAX_FUTURE_SKEW_MS) continue;
    const expiresAt = new Date(actionMs + DIRECTIVE_TTL_MS);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) continue;
    // One coordination action can target more than one live agent session.
    // The session fingerprint makes claim identity person+session scoped while
    // keeping the raw local session key out of URLs and logs.
    const id = `coordination:${action.id}:${sha256(sessionKey).slice(0, 16)}`;
    const result = insert.run(id, person, sessionKey, nowIso, expiresAt.toISOString());
    if (Number(result.changes) !== 1) continue;
    return {
      directive: {
        id,
        kind: kindFor(action.severity),
        summary: action.message,
        evidenceIds: action.evidence.slice(0, 32),
        expiresAt: expiresAt.toISOString(),
      },
    };
  }
  return { directive: null };
}

/** Claim reserves one delivery; this idempotent ack confirms the hook emitted it. */
export async function acknowledgeSteeringDirective(
  store: Store,
  id: string,
  now = new Date(),
  options: AcknowledgeDirectiveOptions = {},
): Promise<{ ok: true }> {
  initialize(store);
  let sessionKey: string | undefined;
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id)) {
    store.db.prepare(`
      UPDATE mesh_directive_claims
         SET acked_at = COALESCE(acked_at, ?)
       WHERE directive_id = ?
    `).run(now.toISOString(), id);
    sessionKey = (store.db.prepare(`
      SELECT session_key FROM mesh_directive_claims WHERE directive_id = ?
    `).get(id) as { session_key: string } | undefined)?.session_key;
  }

  // The local receipt is authoritative for one-shot injection. Reporting it
  // to the local conductor is best-effort and cannot undo that durable ack.
  const actionId = /^coordination:(\d+)(?::[a-f0-9]{16})?$/.exec(id)?.[1];
  const token = options.token ?? process.env.BOARDROOM_LOCAL_TOKEN;
  const conductorUrl = safeMeshRelayBaseUrl(
    options.conductorUrl ?? "http://127.0.0.1:4610",
  );
  if (actionId && sessionKey && token && conductorUrl) {
    try {
      await (options.fetchFn ?? fetch)(
        `${conductorUrl}/v1/interventions/${actionId}/agent-delivered`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionKey }),
          signal: AbortSignal.timeout(2_000),
          redirect: "error",
        },
      );
    } catch {
      // Delivery reporting must never break the local agent hook.
    }
  }
  return { ok: true };
}
