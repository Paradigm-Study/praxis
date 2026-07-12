import type { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BlobKind, BlobRecord } from "../core/types.ts";
import { sha256 } from "../core/hash.ts";
import { nowIso } from "../core/time.ts";
import type { StorageCipher } from "./crypto.ts";

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

export function makeBlobStore(
  db: DatabaseSync,
  blobDir: string,
  cipher?: StorageCipher,
): BlobStore {
  mkdirSync(blobDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(blobDir, 0o700);
  } catch {
    // Best effort.
  }
  const upsert = db.prepare(
    `INSERT OR IGNORE INTO blobs (hash, kind, path, bytes, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const byHash = db.prepare(`SELECT * FROM blobs WHERE hash = ?`);
  const root = `${resolve(blobDir)}/`;

  function record(hash: string): BlobRecord | undefined {
    const row = byHash.get(hash) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const path = row.path as string;
    if (!resolve(path).startsWith(root)) return undefined;
    return {
      hash: row.hash as string,
      kind: row.kind as BlobKind,
      path,
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
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (!existsSync(path)) {
          const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
          const persisted = cipher ? cipher.encryptBytes(bytes, `blob:${hash}`) : bytes;
          writeFileSync(tmp, persisted, { mode: 0o600 });
          renameSync(tmp, path);
        }
        try {
          chmodSync(dir, 0o700);
          chmodSync(path, 0o600);
        } catch {
          // Best effort.
        }
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
      const persisted = readFileSync(rec.path);
      return cipher ? cipher.decryptBytes(persisted, `blob:${hash}`) : persisted;
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
