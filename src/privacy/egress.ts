import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "../storage/index.ts";

export type EgressOutcome = "allowed" | "blocked" | "succeeded" | "failed";

export interface EgressRecord {
  version: 1;
  id: string;
  ts: string;
  destination: string;
  purpose: string;
  categories: string[];
  bytes: number;
  digest?: string;
  redaction?: string;
  outcome: EgressOutcome;
  status?: number;
  error?: string;
}

export interface EgressInput extends Omit<EgressRecord, "version" | "id" | "ts"> {
  ts?: string;
}

const MAX_RECORDS = 2_000;
const MAX_ERROR_CHARS = 240;

function sanitize(input: EgressInput): EgressRecord {
  let destination = input.destination;
  try {
    const url = new URL(destination);
    destination = `${url.protocol}//${url.host}`;
  } catch {
    destination = destination.slice(0, 200);
  }
  return {
    version: 1,
    id: randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    destination,
    purpose: input.purpose.slice(0, 100),
    categories: [...new Set(input.categories.map((v) => v.slice(0, 80)))],
    bytes: Math.max(0, Math.trunc(input.bytes)),
    ...(input.digest ? { digest: input.digest.slice(0, 128) } : {}),
    ...(input.redaction ? { redaction: input.redaction.slice(0, 80) } : {}),
    outcome: input.outcome,
    ...(input.status !== undefined ? { status: Math.trunc(input.status) } : {}),
    ...(input.error ? { error: input.error.slice(0, MAX_ERROR_CHARS) } : {}),
  };
}

/** Metadata-only, owner-readable egress ledger. Request bodies and credentials never enter it. */
export class EgressAuditor {
  readonly path: string | undefined;
  #memory: EgressRecord[] = [];

  constructor(path?: string) {
    this.path = path;
  }

  static forStore(store?: Store): EgressAuditor {
    if (!store) return new EgressAuditor();
    const existing = AUDITORS.get(store);
    if (existing) return existing;
    const created = store.paths.db === ":memory:"
      ? new EgressAuditor()
      : new EgressAuditor(join(dirname(store.paths.db), "egress.ndjson"));
    AUDITORS.set(store, created);
    return created;
  }

  record(input: EgressInput): EgressRecord {
    const record = sanitize(input);
    if (!this.path) {
      this.#memory.push(record);
      if (this.#memory.length > MAX_RECORDS) this.#memory.splice(0, this.#memory.length - MAX_RECORDS);
      return record;
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(this.path), 0o700);
    } catch {
      // Best effort.
    }
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Best effort.
    }
    this.#compact();
    return record;
  }

  recent(limit = 100): EgressRecord[] {
    const requested = Number.isFinite(limit) ? Math.trunc(limit) : 100;
    const cap = Math.min(MAX_RECORDS, Math.max(1, requested));
    if (!this.path) return this.#memory.slice(-cap).reverse();
    if (!existsSync(this.path)) return [];
    const records: EgressRecord[] = [];
    for (const line of readFileSync(this.path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as EgressRecord);
      } catch {
        // Skip torn records; never expose arbitrary non-JSON log content.
      }
    }
    return records.slice(-cap).reverse();
  }

  #compact(): void {
    if (!this.path) return;
    const all = this.recent(MAX_RECORDS).reverse();
    const lines = readFileSync(this.path, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length <= MAX_RECORDS) return;
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${all.map((r) => JSON.stringify(r)).join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, this.path);
  }
}

const AUDITORS = new WeakMap<Store, EgressAuditor>();
