import type { ProfileEntry } from "../memory/consolidate.ts";

/**
 * Render a consolidated Praxis profile as a portable, installable Agent Skill
 * (a `SKILL.md`). This is Layer 11 — "learner / agent transfer" — made real:
 * the learned model leaves the Praxis database as a self-contained artifact an
 * agent (Claude Code, or any SKILL.md-aware host) can load to operate the way
 * the user does.
 *
 * Inspired by dot-skill's layered persona, but distilled from AMBIENTLY observed
 * behavior rather than hand-supplied chat logs — so the skill can be regenerated
 * any time the model sharpens. Every rule keeps its evidence-episode count and
 * confidence; nothing here is asserted as ground truth.
 */

export interface SkillOptions {
  /** Frontmatter `name` / slug. Default "how-i-work". */
  name?: string;
  /** Human title for the H1. Default derived from name. */
  title?: string;
  /** Frontmatter `description`. Default auto-generated. */
  description?: string;
  /** Omit provisional (one-off) entries — emit only durable, recurring traits. */
  durableOnly?: boolean;
  /** ISO timestamp to stamp into provenance (pass nowIso() at the call site). */
  generatedTs: string;
}

export interface SkillStats {
  entries: number;
  durable: number;
  provisional: number;
  episodes: number;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "how-i-work"
  );
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** One markdown bullet for a profile entry, carrying its evidence + confidence. */
function ruleLine(p: ProfileEntry): string {
  const dot = p.tier === "durable" ? "●" : "○";
  const n = p.evidenceEpisodes.length;
  const folded = p.variants.length ? `, ${p.variants.length} variant${p.variants.length > 1 ? "s" : ""}` : "";
  const meta = `_(${dot} confidence ${p.confidence.toFixed(2)}, ${n} episode${n === 1 ? "" : "s"}${folded})_`;
  return `- ${cleanText(p.canonical)} ${meta}`;
}

function cleanText(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** durable-first, then confidence. */
function ranked(items: ProfileEntry[]): ProfileEntry[] {
  return [...items].sort(
    (a, b) =>
      Number(b.tier === "durable") - Number(a.tier === "durable") ||
      b.confidence - a.confidence,
  );
}

export function skillStats(profile: ProfileEntry[]): SkillStats {
  const episodes = new Set<string>();
  for (const p of profile) for (const e of p.evidenceEpisodes) episodes.add(e);
  return {
    entries: profile.length,
    durable: profile.filter((p) => p.tier === "durable").length,
    provisional: profile.filter((p) => p.tier === "provisional").length,
    episodes: episodes.size,
  };
}

export function renderSkill(profile: ProfileEntry[], opts: SkillOptions): string {
  const name = slugify(opts.name ?? "how-i-work");
  const title = opts.title ?? titleCase(name);
  const view = opts.durableOnly ? profile.filter((p) => p.tier === "durable") : profile;
  const stats = skillStats(view);

  const is = (...kinds: string[]) => (p: ProfileEntry) => kinds.includes(p.kind);
  // Hard constraints (an explicit correction, or a durable high-confidence
  // decision) come first, at any tier. Everything else is split DURABLE vs
  // provisional: the durable traits form the operable skill (Layers 1-2); the
  // provisional one-offs are quarantined into a clearly-labelled, capped "soft
  // signals" layer so episode-narration noise can't masquerade as a real rule.
  const hard = view.filter((p) => p.priority === "hard");
  const hardSet = new Set(hard);
  const rest = view.filter((p) => !hardSet.has(p));
  const durable = rest.filter((p) => p.tier === "durable");

  const strongPrefs = durable.filter(is("decision_rule", "decision_heuristic", "taste_rule"));
  const workflow = durable.filter(is("workflow_pattern"));
  const knowHow = durable.filter(is("know_how", "teaching_move"));
  const questions = rest.filter(is("unresolved_question"));
  const soft = rest.filter(
    (p) => p.tier === "provisional" && !is("unresolved_question")(p),
  );
  const SOFT_CAP = 15;

  const description =
    opts.description ??
    `How I work, distilled by Praxis from ${stats.episodes} observed episode${stats.episodes === 1 ? "" : "s"}. ` +
      `Load this to reason, decide, and work the way I do. Each rule is evidence-backed, not ground truth.`;

  const out: string[] = [];

  // YAML frontmatter — the Agent Skills entrypoint contract.
  out.push("---");
  out.push(`name: ${name}`);
  out.push(`description: ${yamlScalar(description)}`);
  out.push("user-invocable: true");
  out.push("allowed-tools: Read, Write, Edit, Bash");
  out.push("---");
  out.push("");
  out.push(`# ${title}`);
  out.push("");
  out.push(
    `This skill encodes how I work, distilled by **Praxis** from **${stats.episodes} observed ` +
      `episode${stats.episodes === 1 ? "" : "s"}** (${stats.durable} durable, ${stats.provisional} provisional traits). ` +
      `Apply it when acting on my behalf.`,
  );
  out.push("");
  out.push(
    "**How to read this:** layers are ordered by authority — honor a higher layer " +
      "over a lower one when they conflict. `●` = durable (seen across multiple " +
      "episodes); `○` = provisional (one-off, treat as a weak default). Every rule " +
      "is an evidence-backed interpretation, **not** ground truth — if one is wrong, " +
      "tell me so I can correct it and re-export.",
  );
  out.push("");

  section(out, "Layer 0 — Hard constraints (never violate)", hard, {
    empty: "_None learned yet — no rule has reached hard-constraint confidence._",
  });
  section(out, "Layer 1 — Decision rules & strong preferences", strongPrefs);

  // Layer 2 splits into an ordered workflow and a know-how list.
  if (workflow.length || knowHow.length) {
    out.push("## Layer 2 — Workflow & know-how");
    out.push("");
    if (workflow.length) {
      out.push("### Workflow");
      out.push("");
      for (const w of ranked(workflow)) {
        const steps = cleanText(w.canonical)
          .replace(/^Workflow:\s*/i, "")
          .split("→")
          .map((s) => s.trim())
          .filter(Boolean);
        if (steps.length > 1) {
          const n = w.evidenceEpisodes.length;
          out.push(
            `_(${w.tier === "durable" ? "●" : "○"} confidence ${w.confidence.toFixed(2)}, ${n} episode${n === 1 ? "" : "s"})_`,
          );
          steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
        } else {
          out.push(ruleLine(w));
        }
        out.push("");
      }
    }
    if (knowHow.length) {
      out.push("### Know-how");
      out.push("");
      for (const k of ranked(knowHow)) out.push(ruleLine(k));
      out.push("");
    }
  }

  // Layer 3 — the quarantined provisional flood: honestly labelled, capped, and
  // with the dropped count surfaced (never silently truncated).
  if (soft.length) {
    out.push("## Layer 3 — Soft signals (one-off — may be noise, low weight)");
    out.push("");
    out.push(
      "_Seen only once, not yet corroborated across episodes. Treat as weak hints, " +
        "not rules — most will be confirmed or fade as more is observed._",
    );
    out.push("");
    for (const p of ranked(soft).slice(0, SOFT_CAP)) out.push(ruleLine(p));
    if (soft.length > SOFT_CAP) {
      out.push("");
      out.push(
        `_… +${soft.length - SOFT_CAP} more provisional signal${soft.length - SOFT_CAP === 1 ? "" : "s"} ` +
          "(`praxis profile --all` to see them, or re-export with `--durable-only` to omit this layer)._",
      );
    }
    out.push("");
  }

  section(out, "Layer 4 — Open questions (ask me; don't assume)", questions, {
    bare: true,
  });

  out.push("---");
  out.push("");
  out.push(
    `_Generated ${opts.generatedTs} by Praxis from ${stats.entries} consolidated ` +
      `trait${stats.entries === 1 ? "" : "s"} across ${stats.episodes} episode${stats.episodes === 1 ? "" : "s"}. ` +
      `Regenerate with \`praxis export-skill\` as the model sharpens._`,
  );
  out.push("");
  return out.join("\n");
}

function section(
  out: string[],
  heading: string,
  items: ProfileEntry[],
  opts: { empty?: string; bare?: boolean } = {},
): void {
  if (!items.length && !opts.empty) return;
  out.push(`## ${heading}`);
  out.push("");
  if (!items.length) {
    out.push(opts.empty!);
    out.push("");
    return;
  }
  for (const p of ranked(items)) {
    out.push(opts.bare ? `- ${cleanText(p.canonical)}` : ruleLine(p));
  }
  out.push("");
}

/** Quote a YAML scalar only if it needs it (keeps simple descriptions clean). */
function yamlScalar(s: string): string {
  const v = cleanText(s);
  return /[:#]|^[\s>|@`"'%&*!?{}\[\],]/.test(v) ? JSON.stringify(v) : v;
}
