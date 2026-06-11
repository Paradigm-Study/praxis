/** Minimal leveled logger — no dependencies, writes to stderr. */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold: Level =
  (process.env.PRAXIS_LOG_LEVEL as Level | undefined) ?? "info";

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const tag = `[${level}] ${scope}:`;
  if (extra !== undefined) {
    process.stderr.write(`${tag} ${msg} ${safe(extra)}\n`);
  } else {
    process.stderr.write(`${tag} ${msg}\n`);
  }
}

function safe(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
  };
}
