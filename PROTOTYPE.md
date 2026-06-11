# Praxis — Context Firehose + Action Reconstructor

An agent that observes a user's whole computer context, **reconstructs exactly
what they did** from a high-fidelity event ledger, fuses those actions into work
episodes, draws connections across them, and builds an **evidence-backed expert
memory graph** of workflow, know-how, taste, and decision logic — which it can
later teach or operate from.

> **The key design principle**
> Raw taps prove *what* happened. The model explains *why* it mattered.
> A model is never the source of truth for user actions. It consumes a
> high-fidelity event ledger and produces interpretations **with evidence links**.

Every interpretation in the system — a reconstructed action, an episode, an
observation, a claim — carries `confidence` and an `evidence[]` list that traces
back to raw ledger events. Raw events have neither; they just *are*.

---

## Quick start (zero install)

Praxis runs on **Node ≥ 23.6** with no `npm install` — it uses Node's built-in
TypeScript stripping, `node:sqlite`, `node:test`, and `node:http`.

```sh
cd praxis
npm run demo        # full pipeline on a synthetic session, explained end-to-end
npm run studio      # then open http://localhost:4319
npm test            # 64 tests, ~300ms
```

`npm run demo` ingests a realistic ~5-minute Codex session (ask → edit → test →
fail → fix → pass → commit, plus a corrected agent and a weak "possibly reading"
detour), then prints the reconstructed action timeline, fused episodes, the
memory graph, an observation, the agent's decision, the transfer playbook, and an
answer to every Definition-of-Success question — each with evidence.

`npm install` is only needed for `npm run typecheck` (it pulls `@types/node` +
`typescript`); running and testing need nothing.

### Capture your real activity (menu bar app)

For live capture on your own Mac, the easiest path is the **PraxisBar menu-bar
app** — start/stop capture, open the Studio, run the proxy, and grant the
Screen-Recording + Accessibility permissions, all from a few buttons:

```sh
npm run bar          # dev: an ◉ icon appears in your menu bar

# or the packaged app (stable permission identity + starts at login):
npm run app:package && npm run app:install
```

See [native/PraxisBar/README.md](native/PraxisBar/README.md). Under the hood it
just launches the same `praxis` CLI commands below.

---

## Commands

| Command | What it does |
|---------|--------------|
| `npm run demo` | Run the whole pipeline on synthetic fixtures and explain it |
| `npm run studio` | Launch Praxis Studio (web UI) over `./data` |
| `npm run capture -- --native --agent` | Live capture (spawns the Swift client) + agent loop |
| `npm run capture -- --synthetic` | Replay the fixtures in real time into `./data` |
| `npm test` | Run the `node:test` suite |
| `npm run capture:check` | Run the real (non-synthetic) fs+git+terminal capture path on a throwaway repo and reconstruct |
| `npm run observer:check` | Verify the model-backed observer + proxy against the live Anthropic API (two small calls) |
| `npm run typecheck` | `tsc --noEmit` (needs `npm install`) |
| `npm run native:build` | `swift build` the native macOS capture client |
| `node src/cli/praxis.ts profile` | Your consolidated profile: durable vs provisional traits, corrections applied, no signal lost |
| `node src/cli/praxis.ts export-skill` | Distill the profile into a portable `SKILL.md` any agent can operate from (`--out --name --durable-only`) |
| `node src/cli/praxis.ts hook` | Print the zsh hook for terminal-command capture |

CLI also exposes `reconstruct`, `fuse`, `graph`, `observe`, `status`, `reset`,
and `proxy` (the AI recording proxy — point a tool's API base URL at it).

**API key:** the CLI auto-loads `praxis/.env` (gitignored). With
`ANTHROPIC_API_KEY` set, one-shot `praxis observe` uses the real multimodal
model. Continuous capture (`capture --agent`) stays on the offline mock unless
you opt in with `--observer=anthropic` — it ticks constantly, and surprise API
spend is worse than a weaker observer. `PRAXIS_OBSERVER=mock|anthropic` and
`PRAXIS_OBSERVER_MODEL=…` override the defaults.

---

## What runs today vs. what needs entitlements

This is a **full-breadth scaffold**: every layer is a real module. The
deterministic core runs and is tested with zero setup; the OS-native parts are
real code that needs macOS permissions to produce live data.

| Layer | Status |
|-------|--------|
| 1 — Capture (filesystem, git, terminal) | ✅ runs; **verified on real activity** end-to-end via `npm run capture:check` (real file edit + commands + commit → reconstructed actions) |
| 1 — Capture (synthetic, clipboard, browser) | ✅ runs |
| 1 — `ai_proxy` recording proxy | ✅ real forwarding HTTP proxy — records prompts/responses, returns upstream verbatim (tested against a mock upstream) |
| 1 — Native taps (ScreenCaptureKit / CGEventTap / Accessibility / **Vision OCR**) | ✅ **verified live**: captures ALL displays (per-display change detection skips OCR on static screens), OCR auto-detects EN + 中文, universal AX conversation scrape for any chat app |
| 1 — **Audio** (system output + opt-in mic) | ✅ **verified e2e**: SCStream system tap rides the existing Screen Recording grant; VAD-chunked **on-device** transcription (multi-locale race — EN now, 中文 once the dictation model is installed); transcripts only, raw audio never touches disk |
| 2 — Storage (SQLite WAL + content-addressed blobs) | ✅ runs |
| 2 — DuckDB analytics | ⚙️ SQLite-backed today; DuckDB auto-detected if installed |
| 3 — Action Reconstructor | ✅ runs + tested |
| 4 — Episode Fuser | ✅ runs + tested |
| 5 — Multimodal Observer | ✅ offline mock runs; ✅ Anthropic-backed **verified against the live API**; bundles lead with the newest frame of **every display** + audio transcripts; frames are magic-byte sniffed so only genuine images reach the model |
| 6 — Expert Memory Graph | ✅ runs + tested; **non-destructive consolidation** (durable/provisional tiers, evidence-coverage proven, 0 episodes lost) + correction feedback suppresses rejected claims |
| 7 — Agent Loop | ✅ runs + tested; **proactive questions** with candidate answers via an unsuppressible floating glass panel + notification actions + Studio cards — answers write back as corrections and stop re-asks |
| 8 — Praxis Studio UI | ✅ runs; **Live Feed streams in real time via SSE**; dark-glass design; evidence drill-down to the exact frame behind any claim |
| 11 — Learner/Agent Transfer | ✅ runs + tested; **`praxis export-skill`** emits a portable SKILL.md of the learned profile, installable for any agent |

Nothing is faked: the demo's numbers come from running code, and the native
client really did emit a live `app_focused` event for the frontmost app during
development — it's just gated on the permissions it can't grant itself.

---

## Layout

```
praxis/
  src/
    core/         shared types (the fact/interpretation contract), ids, hashing, time, diff
    storage/      SQLite WAL + content-addressed blobs + per-table stores (Layer 2)
    capture/      ingest funnel + sources (Layer 1) + native bridge + manager
    reconstructor/ deterministic rules + confidence scoring (Layer 3)
    fuser/        episode boundary detection + synthesis (Layer 4)
    observer/     bounded bundles + mock/Anthropic observers (Layer 5)
    memory/       claim extraction + expert memory graph (Layer 6)
    agent/        observe→reconstruct→fuse→update→decide loop + policy (Layer 7)
    transfer/     playbook + critique from the learned graph (Layer 11)
    studio/       JSON API + zero-dep web UI (Layer 8)
    fixtures/     the synthetic Codex sessions that drive the demo + tests
    cli/          praxis CLI + demo runner
  native/PraxisCapture/   Swift capture client: screens ×N, audio, AX, input (SwiftPM)
  native/PraxisBar/       Swift menu-bar app: runs capture in-process, audio toggles, question panel
  scripts/        packaging, signing (stable TCC identity), launchd install
  test/           node:test suites
```

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the layer-by-layer design and the
data-flow diagram, and **[native/PraxisCapture/README.md](native/PraxisCapture/README.md)**
for the native client + permissions.

---

## Definition of Success

Praxis answers all of these from the ledger, with evidence (asserted in
[`test/pipeline.test.ts`](test/pipeline.test.ts)):

what did the user do · in what order · in which app/tool/artifact · what changed ·
what did they reject · what did they accept · what did they correct · what pattern
does this reveal · **what evidence supports that claim**.
