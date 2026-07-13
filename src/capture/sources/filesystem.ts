import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
import type { Stats } from "node:fs";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CaptureSource, EventSink } from "../source.ts";
import { sha256 } from "../../core/hash.ts";
import { lineDiff } from "../../core/diff.ts";
import { logger } from "../../core/log.ts";

const log = logger("filesystem");

const GENERATED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".build",
  ".cache",
  ".next",
  ".output",
  ".praxis",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "out",
  "release",
  "target",
]);

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

/** Segment-aware filtering: `distribution.ts` is source; `dist/app.js` is not. */
export function ignoredFilesystemPath(relativePath: string): boolean {
  if (isAbsolute(relativePath) || IGNORE_EXT.test(relativePath)) return true;
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => GENERATED_DIRECTORIES.has(part))) return true;
  return parts.some((part, index) => part === "data" && parts[index + 1] === "blobs");
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
  #prevBytes = 0;
  #debounce = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Paths changed while acquisition was denied. The next permitted callback
   * silently establishes a new baseline, and the path remains tainted so a
   * later event cannot persist the blocked full-file body or removed lines.
   */
  #privacyTainted = new Set<string>();
  /** Paths whose first permitted notification must be consumed silently. */
  #privacyBaselinePending = new Set<string>();
  #maxBytes: number;
  #maxSnapshots: number;
  #maxSnapshotBytes: number;
  #canAcquire: (absolutePath: string, relativePath: string) => boolean;
  #readText: (fd: number, maxBytes: number) => string;
  #watchTree: (root: string, callback: WatchCallback) => WatchHandle;
  #canonicalRoot: string | undefined;
  #beforeOpen?: (absolutePath: string) => void;
  #afterOpen?: (absolutePath: string, fd: number) => void;

  constructor(opts: {
    root: string;
    maxBytes?: number;
    /** Maximum prior file bodies retained for diffing. Default 10,000. */
    maxSnapshots?: number;
    /** Maximum aggregate prior-body memory retained for diffing. Default 64 MiB. */
    maxSnapshotBytes?: number;
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
    this.#maxSnapshots = Math.max(1, opts.maxSnapshots ?? 10_000);
    this.#maxSnapshotBytes = Math.max(
      this.#maxBytes,
      opts.maxSnapshotBytes ?? 64 * 1024 * 1024,
    );
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
    this.stop();
    this.#prev.clear();
    this.#prevBytes = 0;
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
        if (ignoredFilesystemPath(rel)) return;
        const existing = this.#debounce.get(rel);
        if (existing) clearTimeout(existing);
        // Sample policy at notification time, before the debounce. Otherwise
        // a change made while paused could be read after the user resumes but
        // before this delayed callback fires.
        if (!this.#acquisitionAllowed(rel)) {
          this.#debounce.delete(rel);
          this.#privacyTainted.add(rel);
          this.#privacyBaselinePending.add(rel);
          return;
        }
        this.#debounce.set(
          rel,
          setTimeout(() => {
            this.#debounce.delete(rel);
            this.#onChange(rel, sink);
          }, 120),
        );
      },
    );
    // Establish existing files as a silent baseline. fs.watch reports changes,
    // not opens; treating the first callback as `file_opened` created thousands
    // of false actions after every restart. Starting the watcher first closes
    // the scan race: a change during the baseline is queued and compared after.
    const baseline = this.#baseline();
    log.info(`watching ${this.#root} (${baseline} file baseline)`);
  }

  /** Privacy/policy preflight. This never stats, opens, or reads the path. */
  #acquisitionAllowed(rel: string): boolean {
    if (!this.#canonicalRoot || isAbsolute(rel) || ignoredFilesystemPath(rel)) return false;
    const abs = resolve(this.#root, rel);
    if (!isContained(this.#root, abs)) return false;
    try {
      return this.#canAcquire(abs, rel);
    } catch {
      return false;
    }
  }

  #readSnapshot(
    rel: string,
    useFailureHooks: boolean,
  ): { content: string; bytes: number } | undefined {
    if (!this.#canonicalRoot || ignoredFilesystemPath(rel)) return;
    const abs = resolve(this.#root, rel);
    // Watch backends are not trusted to return a well-formed relative path.
    // Reject traversal before even consulting filesystem metadata.
    if (!isContained(this.#root, abs)) return;
    // Source-level privacy fence: excluded bytes are never statted, read, or
    // retained in #prev. The ingest policy remains a second independent fence.
    if (!this.#acquisitionAllowed(rel)) {
      this.#privacyTainted.add(rel);
      this.#privacyBaselinePending.add(rel);
      return;
    }
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

      if (useFailureHooks) this.#beforeOpen?.(abs);
      // O_NOFOLLOW closes the final-component swap window. Opening the
      // canonical path plus the post-open identity check below closes parent
      // directory retargets before any bytes are acquired.
      fd = openSync(canonicalBefore, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (useFailureHooks) this.#afterOpen?.(abs, fd);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > this.#maxBytes) return;

      const canonicalAfter = realpathSync.native(abs);
      if (
        canonicalAfter !== canonicalBefore ||
        !isContained(this.#canonicalRoot, canonicalAfter)
      ) return;
      const current = statSync(canonicalAfter);
      if (!sameIdentity(identityOf(opened), identityOf(current))) return;

      content = useFailureHooks
        ? this.#readText(fd, this.#maxBytes)
        : boundedUtf8Read(fd, this.#maxBytes);
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
    return { content, bytes };
  }

  #baseline(): number {
    let count = 0;
    let bytes = 0;
    const walk = (directory: string): boolean => {
      if (count >= this.#maxSnapshots || bytes >= this.#maxSnapshotBytes) return false;
      let entries: Dirent<string>[];
      try {
        entries = readdirSync(resolve(this.#root, directory), { withFileTypes: true });
      } catch {
        return true;
      }
      for (const entry of entries) {
        if (count >= this.#maxSnapshots || bytes >= this.#maxSnapshotBytes) return false;
        const rel = join(directory, entry.name);
        if (ignoredFilesystemPath(rel) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!walk(rel)) return false;
          continue;
        }
        if (!entry.isFile()) continue;
        const snapshot = this.#readSnapshot(rel, false);
        if (!snapshot) continue;
        if (count > 0 && bytes + snapshot.bytes > this.#maxSnapshotBytes) return false;
        this.#remember(rel, snapshot.content);
        count += 1;
        bytes += snapshot.bytes;
      }
      return true;
    };
    walk("");
    return count;
  }

  /** LRU-ish bounded prior bodies: Map insertion order is the eviction order. */
  #remember(rel: string, content: string): void {
    const previous = this.#prev.get(rel);
    if (previous !== undefined) {
      this.#prevBytes -= Buffer.byteLength(previous, "utf8");
      this.#prev.delete(rel);
    }
    this.#prev.set(rel, content);
    this.#prevBytes += Buffer.byteLength(content, "utf8");
    while (
      this.#prev.size > this.#maxSnapshots
      || this.#prevBytes > this.#maxSnapshotBytes
    ) {
      const oldest = this.#prev.entries().next().value as [string, string] | undefined;
      if (!oldest) break;
      this.#prev.delete(oldest[0]);
      this.#prevBytes -= Buffer.byteLength(oldest[1], "utf8");
    }
  }

  #onChange(rel: string, sink: EventSink): void {
    const needsPrivacyBaseline = this.#privacyBaselinePending.has(rel);
    const snapshot = this.#readSnapshot(rel, true);
    if (!snapshot) return;
    const { content, bytes } = snapshot;
    if (needsPrivacyBaseline) {
      // The permission-denied interval is intentionally a gap in the ledger.
      // Never diff it against the pre-pause body or emit its current contents.
      this.#remember(rel, content);
      this.#privacyBaselinePending.delete(rel);
      if (content.length === 0) this.#privacyTainted.delete(rel);
      return;
    }
    const abs = resolve(this.#root, rel);
    const hashAfter = `sha256:${sha256(content)}`;
    const before = this.#prev.get(rel);
    if (before === content) return;
    const tainted = this.#privacyTainted.has(rel);
    if (tainted && before === undefined) {
      // A bounded snapshot cache may evict the post-privacy baseline. Without
      // this guard, diffing from an empty string would reclassify every blocked
      // line as a new allowed addition. Re-baseline silently instead.
      this.#remember(rel, content);
      return;
    }
    const rawDiff = lineDiff(before ?? "", content);
    // A normal unified diff includes deleted lines, which could quote bytes
    // written during the blocked interval. For a tainted path, retain only
    // post-resume additions and never attach the full file body.
    const diff = tainted
      ? rawDiff.split("\n").filter((line) => line.startsWith("+ ")).join("\n")
      : rawDiff;
    this.#remember(rel, content);

    sink({
      source: "filesystem",
      app: "filesystem",
      window: relative(process.cwd(), abs),
      type: "file_changed",
      payload: {
        path: rel,
        workspaceRoot: this.#root,
        hashAfter,
        bytes,
        changeKind: before === undefined ? "created" : "modified",
      },
      blobs: [
        ...(!tainted ? [{ kind: "file" as const, data: content }] : []),
        ...(diff ? [{ kind: "diff" as const, data: diff }] : []),
      ],
    });
    // Once an allowed edit has reduced the file to empty, no blocked body can
    // survive into a future full-file attachment.
    if (tainted && content.length === 0) this.#privacyTainted.delete(rel);
  }

  stop(): void {
    this.#watcher?.close();
    for (const t of this.#debounce.values()) clearTimeout(t);
    this.#debounce.clear();
    this.#privacyTainted.clear();
    this.#privacyBaselinePending.clear();
    this.#prev.clear();
    this.#prevBytes = 0;
    this.#canonicalRoot = undefined;
  }
}
