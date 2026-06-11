import { readFileSync } from "node:fs";

/**
 * Minimal .env loader (zero deps). Loads KEY=value lines into process.env
 * without overriding variables that are already set, so the shell always wins.
 * Praxis loads `<project>/.env` at CLI startup — that's where the Anthropic key
 * lives for the model-backed observer.
 */
export function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env — fine
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(m[1]! in process.env)) process.env[m[1]!] = value;
  }
}
