import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlobKind, BlobRecord } from "../core/types.ts";
import { sha256 } from "../core/hash.ts";
import { nowIso } from "../core/time.ts";

/**
 * Content-addressed blob store. Large payloads (screen frames, video chunks,
 * terminal logs, file snapshots, audio) are written once under their sha256 and
 * referenced by hash from raw events. Identical content is stored exactly once.
 */
export interface BlobStore {
  /** Store bytes; returns the record (idempotent on identical content). */
  put(kind: BlobKind, data: Uint8Array | string): BlobRecord;
  get(hash: string): Uint8Array | undefined;
  getText(hash: string): string | undefined;
  record(hash: string): BlobRecord | undefined;
  has(hash: string): boolean;
}

function shard(dir: string, hash: string): { dir: string; path: string } {
  const sub = join(dir, hash.slice(0, 2));
  return { dir: sub, path: join(sub, hash) };
}

export function makeBlobStore(db: DatabaseSync, blobDir: string): BlobStore {
  mkdirSync(blobDir, { recursive: true });
  const upsert = db.prepare(
    `INSERT OR IGNORE INTO blobs (hash, kind, path, bytes, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const byHash = db.prepare(`SELECT * FROM blobs WHERE hash = ?`);

  function record(hash: string): BlobRecord | undefined {
    const row = byHash.get(hash) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      hash: row.hash as string,
      kind: row.kind as BlobKind,
      path: row.path as string,
      bytes: Number(row.bytes),
      createdAt: row.created_at as string,
    };
  }

  return {
    put(kind, data) {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const hash = sha256(bytes);
      const { dir, path } = shard(blobDir, hash);
      const existing = record(hash);
      if (!existing) {
        mkdirSync(dir, { recursive: true });
        if (!existsSync(path)) writeFileSync(path, bytes);
        upsert.run(hash, kind, path, bytes.byteLength, nowIso());
      }
      return (
        record(hash) ?? {
          hash,
          kind,
          path,
          bytes: bytes.byteLength,
          createdAt: nowIso(),
        }
      );
    },
    get(hash) {
      const rec = record(hash);
      if (!rec || !existsSync(rec.path)) return undefined;
      return readFileSync(rec.path);
    },
    getText(hash) {
      const buf = this.get(hash);
      return buf ? Buffer.from(buf).toString("utf8") : undefined;
    },
    record,
    has(hash) {
      return record(hash) !== undefined;
    },
  };
}
