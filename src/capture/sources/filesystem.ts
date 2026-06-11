import { watch, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CaptureSource, EventSink } from "../source.ts";
import { sha256 } from "../../core/hash.ts";
import { lineDiff } from "../../core/diff.ts";
import { logger } from "../../core/log.ts";

const log = logger("filesystem");

const IGNORE = [
  "node_modules",
  ".git",
  ".build",
  ".praxis",
  "data/blobs",
  "dist",
  ".next",
];

// Machine-written files (Praxis's own DB/logs, build artifacts) — never source edits.
const IGNORE_EXT = /\.(db|db-wal|db-shm|log|lock|tmp|swp|map)$/i;

/**
 * Filesystem tap. Watches a project tree and, on each change, captures the new
 * content hash, byte size, and a line diff vs the previous snapshot. The full
 * snapshot and the diff are offloaded to blobs; only hashes ride inline.
 */
export class FilesystemSource implements CaptureSource {
  readonly name = "filesystem";
  readonly source = "filesystem" as const;
  #root: string;
  #watcher: ReturnType<typeof watch> | undefined;
  #prev = new Map<string, string>();
  #debounce = new Map<string, ReturnType<typeof setTimeout>>();
  #maxBytes: number;

  constructor(opts: { root: string; maxBytes?: number }) {
    this.#root = opts.root;
    this.#maxBytes = opts.maxBytes ?? 512 * 1024;
  }

  start(sink: EventSink): void {
    this.#watcher = watch(
      this.#root,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString();
        if (IGNORE.some((p) => rel.includes(p)) || IGNORE_EXT.test(rel)) return;
        const existing = this.#debounce.get(rel);
        if (existing) clearTimeout(existing);
        this.#debounce.set(
          rel,
          setTimeout(() => this.#onChange(rel, sink), 120),
        );
      },
    );
    log.info(`watching ${this.#root}`);
  }

  #onChange(rel: string, sink: EventSink): void {
    const abs = join(this.#root, rel);
    let content: string;
    let bytes: number;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > this.#maxBytes) return;
      bytes = st.size;
      content = readFileSync(abs, "utf8");
    } catch {
      return; // deleted or unreadable
    }
    const hashAfter = `sha256:${sha256(content)}`;
    const before = this.#prev.get(rel);
    if (before === content) return;
    const diff = before !== undefined ? lineDiff(before, content) : "";
    this.#prev.set(rel, content);

    sink({
      source: "filesystem",
      app: "filesystem",
      window: relative(process.cwd(), abs),
      type: before === undefined ? "file_opened" : "file_changed",
      payload: { path: rel, hashAfter, bytes },
      blobs: [
        { kind: "file", data: content },
        ...(diff ? [{ kind: "diff" as const, data: diff }] : []),
      ],
    });
  }

  stop(): void {
    this.#watcher?.close();
    for (const t of this.#debounce.values()) clearTimeout(t);
  }
}
