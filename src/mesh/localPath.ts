import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

/**
 * Canonicalize an absolute local path without requiring the final file to
 * exist. Existing ancestors are realpathed so symlink aliases cannot cross a
 * consent boundary; a missing suffix is then resolved below that real path.
 */
export function canonicalizeLocalPath(path: string): string | undefined {
  const value = path.trim();
  if (!isAbsolute(value) || value.includes("\0")) return undefined;

  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    // Capture records can outlive files. Resolve the deepest existing ancestor
    // rather than weakening the symlink fence for a missing leaf.
  }

  const suffix: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }

  try {
    return resolve(realpathSync.native(cursor), ...suffix);
  } catch {
    return undefined;
  }
}

/** True for the root itself or a descendant, never for a lexical prefix peer. */
export function pathIsInside(path: string, root: string): boolean {
  const within = relative(root, path);
  return within === ""
    || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within));
}
