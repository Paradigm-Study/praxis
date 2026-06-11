/** Tiny ANSI styling helpers (honor NO_COLOR), no dependencies. */

const ON = !process.env.NO_COLOR && process.stdout.isTTY !== false;

const wrap = (code: string) => (s: string | number) =>
  ON ? `\x1b[${code}m${s}\x1b[0m` : String(s);

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const magenta = wrap("35");
export const cyan = wrap("36");
export const gray = wrap("90");

/** A section header rule. */
export function header(title: string): string {
  const line = "─".repeat(Math.max(0, 64 - title.length));
  return `\n${bold(cyan(`▸ ${title}`))} ${gray(line)}`;
}

/** Color a 0..1 confidence value. */
export function conf(c: number): string {
  const s = c.toFixed(2);
  if (c >= 0.85) return green(s);
  if (c >= 0.6) return yellow(s);
  return red(s);
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function bullet(s: string): string {
  return `  ${gray("•")} ${s}`;
}
