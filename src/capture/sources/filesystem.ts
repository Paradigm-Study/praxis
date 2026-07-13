import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
type WatchHandle = { close(): void };
type WatchCallback = (filename: string | Buffer | null) => void;

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function identityOf(stats: Stats): FileIdentity {
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function boundedUtf8Read(fd: number, maxBytes: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const bytes = readSync(fd, buffer, 0, buffer.length, null);
    if (bytes === 0) break;
    chunks.push(buffer.subarray(0, bytes));
    total += bytes;
  }
  if (total > maxBytes) throw new RangeError("file exceeds capture byte limit");
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Filesystem tap. Watches a project tree and, on each change, captures the new
 * content hash, byte size, and a line diff vs the previous snapshot. The full
 * snapshot and the diff are offloaded to blobs; only hashes ride inline.
 */
export class FilesystemSource implements CaptureSource {
  readonly name = "filesystem";
  readonly source = "filesystem" as const;
  #root: string;
  #watcher: WatchHandle | undefined;
  #prev = new Map<string, string>();
  #debounce = new Map<string, ReturnType<typeof setTimeout>>();
  #maxBytes: number;
  #canAcquire: (absolutePath: string, relativePath: string) => boolean;
  #readText: (fd: number, maxBytes: number) => string;
  #watchTree: (root: string, callback: WatchCallback) => WatchHandle;
  #canonicalRoot: string | undefined;
  #beforeOpen?: (absolutePath: string) => void;
  #afterOpen?: (absolutePath: string, fd: number) => void;

  constructor(opts: {
    root: string;
    maxBytes?: number;
    canAcquire?: (absolutePath: string, relativePath: string) => boolean;
    readText?: (fd: number, maxBytes: number) => string;
    watchTree?: (root: string, callback: WatchCallback) => WatchHandle;
    /** Failure-injection seam for adversarial retarget tests. */
    beforeOpen?: (absolutePath: string) => void;
    /** Failure-injection seam for adversarial retarget tests. */
    afterOpen?: (absolutePath: string, fd: number) => void;
  }) {
    this.#root = resolve(opts.root);
    this.#maxBytes = opts.maxBytes ?? 512 * 1024;
    this.#canAcquire = opts.canAcquire ?? (() => true);
    this.#readText = opts.readText ?? boundedUtf8Read;
    this.#watchTree = opts.watchTree ?? ((root, callback) => watch(
      root,
      { recursive: true },
      (_event, filename) => callback(filename),
    ));
    this.#beforeOpen = opts.beforeOpen;
    this.#afterOpen = opts.afterOpen;
  }

  start(sink: EventSink): void {
    // Pin the consent boundary to its canonical directory. Every acquisition
    // is re-realpathed against this value, so symlink aliases and later
    // retargets cannot widen the selected workspace.
    this.#canonicalRoot = realpathSync.native(this.#root);
    if (!statSync(this.#canonicalRoot).isDirectory()) {
      throw new Error(`filesystem capture root is not a directory: ${this.#root}`);
    }
    this.#watcher = this.#watchTree(
      this.#root,
      (filename) => {
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
    if (!this.#canonicalRoot || isAbsolute(rel)) return;
    const abs = resolve(this.#root, rel);
    // Watch backends are not trusted to return a well-formed relative path.
    // Reject traversal before even consulting filesystem metadata.
    if (!isContained(this.#root, abs)) return;
    // Source-level privacy fence: excluded bytes are never statted, read, or
    // retained in #prev. The ingest policy remains a second independent fence.
    if (!this.#canAcquire(abs, rel)) return;
    let content: string;
    let bytes: number;
    let fd: number | undefined;
    try {
      // lstat rejects a final-component symlink before realpath. realpath then
      // fences symlinks in any parent component against the canonical root.
      const lexical = lstatSync(abs);
      if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.size > this.#maxBytes) return;
      const canonicalBefore = realpathSync.native(abs);
      if (!isContained(this.#canonicalRoot, canonicalBefore)) return;

      this.#beforeOpen?.(abs);
      // O_NOFOLLOW closes the final-component swap window. Opening the
      // canonical path plus the post-open identity check below closes parent
      // directory retargets before any bytes are acquired.
      fd = openSync(canonicalBefore, constants.O_RDONLY | constants.O_NOFOLLOW);
      this.#afterOpen?.(abs, fd);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > this.#maxBytes) return;

      const canonicalAfter = realpathSync.native(abs);
      if (
        canonicalAfter !== canonicalBefore ||
        !isContained(this.#canonicalRoot, canonicalAfter)
      ) return;
      const current = statSync(canonicalAfter);
      if (!sameIdentity(identityOf(opened), identityOf(current))) return;

      content = this.#readText(fd, this.#maxBytes);
      if (Buffer.byteLength(content, "utf8") > this.#maxBytes) return;
      // Confirm the selected directory entry still names the opened inode.
      // The descriptor pins the bytes, so changes after this point cannot make
      // the read follow a replacement path.
      const finalCanonical = realpathSync.native(abs);
      const final = statSync(finalCanonical);
      if (
        finalCanonical !== canonicalBefore ||
        !isContained(this.#canonicalRoot, finalCanonical) ||
        !sameIdentity(identityOf(opened), identityOf(final))
      ) return;
      bytes = Buffer.byteLength(content, "utf8");
    } catch {
      return; // deleted or unreadable
    } finally {
      if (fd !== undefined) closeSync(fd);
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
