# Praxis Architecture

```
Native: screens ×N, ───┐
  audio, AX, input     │
clipboard / fs / git ──┤
terminal / ai-proxy ───┼─▶ ingest ─▶ raw event ledger ─▶ action reconstructor
browser / synthetic ───┘   (Layer 1)      (Layer 2)            (Layer 3)
                                                                   │
                                                                   ▼
   learner/agent  ◀─ transfer ◀─ expert memory graph ◀─ episode fuser
     (Layer 11)                      (Layer 6)             (Layer 4)
                                          ▲                     │
                          agent loop ─────┘   multimodal observer (Layer 5)
                           (Layer 7)               consumes bounded bundles
                                          Praxis Studio (Layer 8) reads all of it
```

## The one invariant: facts vs. interpretations

The whole design turns on a single distinction, encoded in the types
([`src/core/types.ts`](src/core/types.ts)):

- **`RawEvent`** is a *fact*. It has no confidence. It asserts only that a tap
  observed something at a time. It is content-hashed and immutable. Big payloads
  (frames, logs, snapshots) live in the content-addressed blob store; only hashes
  ride inline.
- **`ActionEvent`, `Episode`, `Observation`, `Claim`** are *interpretations*.
  Each carries `confidence` and `evidence[]` — ids that trace back to the facts
  that justify it. A model may *propose* these; it may never overwrite the ledger.

`Correction` closes the loop: a human verdict on an interpretation, which feeds
back into the graph (a rejection becomes a `contradicted_by_correction` edge; a
confirmation raises confidence).

## Layer → module map

| Layer | Design-doc role | Modules |
|------:|-----------------|---------|
| 1 | Universal Capture | [`capture/ingest.ts`](src/capture/ingest.ts), [`capture/sources/*`](src/capture/sources), [`native/PraxisCapture`](native/PraxisCapture) |
| 2 | Storage | [`storage/db.ts`](src/storage/db.ts), [`storage/schema.sql`](src/storage/schema.sql), `storage/*Store.ts`, [`storage/analytics.ts`](src/storage/analytics.ts) |
| 3 | Action Reconstructor | [`reconstructor/reconstructor.ts`](src/reconstructor/reconstructor.ts), [`reconstructor/rules/*`](src/reconstructor/rules), [`reconstructor/confidence.ts`](src/reconstructor/confidence.ts) |
| 4 | Context Episode Fuser | [`fuser/fuser.ts`](src/fuser/fuser.ts), [`fuser/boundaries.ts`](src/fuser/boundaries.ts) |
| 5 | Multimodal Observer | [`observer/bundle.ts`](src/observer/bundle.ts), [`observer/observer.ts`](src/observer/observer.ts) |
| 6 | Expert Memory Graph | [`memory/claims.ts`](src/memory/claims.ts), [`memory/graph.ts`](src/memory/graph.ts) |
| 7 | Agent Loop | [`agent/loop.ts`](src/agent/loop.ts), [`agent/policy.ts`](src/agent/policy.ts) |
| 8 | Studio UI | [`studio/server.ts`](src/studio/server.ts), [`studio/web/*`](src/studio/web) |
| 11 | Learner/Agent Transfer | [`transfer/transfer.ts`](src/transfer/transfer.ts) |

## Layer 1 — Capture

Every source implements `CaptureSource` and emits `RawEventInput` into a single
normalizing `ingest()` funnel, which assigns the id + timestamp, offloads inline
blobs to the content-addressed store, computes the content hash, appends to the
ledger, and notifies live subscribers. Sources never touch the DB directly.

The native client speaks **NDJSON over stdout**; `nativeBridge.ts` parses it,
reads any `blobFiles` the Swift process wrote, offloads them, and feeds the
funnel. Wire format and permissions are documented in the
[native README](native/PraxisCapture/README.md).

**Screens:** every display is captured each tick (multi-monitor desks are fully
visible) with per-display **content-hash change detection** — an unchanged
screen skips OCR and emission entirely (30s heartbeat reuses cached OCR text).
Vision OCR auto-detects language (English + Simplified/Traditional Chinese).
The universal **AX conversation scrape** baselines any chat UI and emits only
newly-appeared bubbles — ChatGPT, Claude, Discord, iMessage, with zero per-app
code.

**Audio** ([`AudioCapture.swift`](native/PraxisCapture/Sources/PraxisCaptureKit/AudioCapture.swift)):
two opt-in channels, both OFF by default. System output rides the existing
Screen Recording grant via SCStream `capturesAudio` (no extra prompt); the mic
is a separate opt-in with its own TCC. A VAD-gated chunker accumulates sound and
flushes on sustained silence into **on-device** speech recognition — each chunk
races every installed-language recognizer and the most confident reading wins,
so code-switching works and segments carry their `lang`. The privacy stance is
structural: transcripts and coarse `playback_state` transitions are emitted;
**raw audio never touches disk**.

The **`ai_proxy`** source is a real forwarding HTTP proxy
([`aiProxyServer.ts`](src/capture/sources/aiProxyServer.ts)): a routed AI tool
points its API base URL at it; the proxy extracts the model + prompt (Anthropic
and OpenAI shapes), records an `ai_request`, forwards upstream, records the
`ai_response` from the result, and returns it verbatim. Those prompt/response
events are first-class evidence — an `ai_request` next to an Enter keypress is
what lifts `submitted_message` confidence.

## Layer 2 — Storage

`node:sqlite` in WAL mode (so Studio can read while capture writes) plus a
content-addressed blob directory sharded by hash prefix. One `Store` facade
([`storage/index.ts`](src/storage/index.ts)) exposes a typed store per table.
Analytics rollups run over SQLite today and auto-accelerate if `duckdb` is
installed.

## Layer 3 — Action Reconstructor

Deterministic rules correlate raw events into `user_action`s. Confidence is a
**noisy-OR over independent corroborating signals**
([`confidence.ts`](src/reconstructor/confidence.ts)): an Enter keypress alone is
weak, but Enter + a draft + a new conversation bubble + a matching AI request
combine to ~0.98. Weak evidence yields a low-confidence action with an explicit
`uncertainty[]` (e.g. `possibly_reading_discord` at 0.55, "focus and screen
agree, but no AX text available"). Rules are grouped by domain under
[`rules/`](src/reconstructor/rules) and cover all 23 supported action types —
including the audio pairings: interleaved mic + system speech reconstructs an
`attended_meeting`, system speech alone `listened_audio`, lone mic speech
`spoke_aloud` (kept deliberately uncertain).

## Layer 4 — Episode Fuser

Boundaries are **weighed, not applied blindly** ([`boundaries.ts`](src/fuser/boundaries.ts)):
a commit closes an episode, a long pause splits one, an app switch splits only
after a real gap — so an edit→test→fix→edit→test cycle that hops across Cursor
and iTerm stays one coherent episode. The fuser's summary is *factual* (counts +
notable actions); the interpretive "why" is the Observer's job, kept separate so
the model never overwrites ledger-derived facts.

## Layer 5 — Multimodal Observer

The observer only ever sees a **bounded bundle** (last ~30–120s of
frames/AX/input/focus/terminal/diffs + reconstructed actions), never the
unbounded ledger. It emits intent / task / decision / accepted+rejected options /
preference / uncertainty / a suggested question — always attached to evidence.
Ships an offline deterministic `MockObserver` and a real `AnthropicObserver`
(used automatically when `ANTHROPIC_API_KEY` is set) behind one interface.

**Vision is real.** Screen frames are OCR'd at capture time by the native client
via the macOS **Vision framework** (`VNRecognizeTextRequest`, on-device, no
deps) — the recognized text rides in the frame event's `ocrText`. That text (a)
strengthens reconstruction: a `submitted_message` whose draft actually appears in
the frame's OCR scores higher (`screen_ocr_match`) than one with a bare frame,
and (b) flows into the bundle as `frameText`. When the observer
`wantsImages`, the bundle also carries base64 `frameImages`, and the
`AnthropicObserver` sends them as real **image content blocks** — genuinely
multimodal, not text-only.

## Layer 6 — Expert Memory Graph

Claims are extracted per-episode ([`claims.ts`](src/memory/claims.ts)) then
**merged across episodes** by `(kind, text)`: pooled evidence episodes, confidence
combined via noisy-OR. A stable workflow label recurring on a second day raises
its confidence and earns `reused_across_days` edges. Nodes are claims; typed
edges connect them to the episodes that evidence them, caused file changes,
followed failing/passing tests, were taught, or were contradicted by a
correction.

**Consolidation** ([`consolidate.ts`](src/memory/consolidate.ts)) derives a
tight profile from raw claims **without losing signal**: merging happens only
within a kind, similarity is conservative (the safe failure mode is
under-merging), evidence unions monotonically, and `evidenceCoverage()` proves
no episode's signal was dropped. Entries carry a **durable / provisional** tier
(recurrence across ≥2 episodes promotes) and a priority level. **Corrections
feed back**: claims the user rejected are suppressed from the profile view —
non-destructively, since raw claims are never mutated. `praxis profile` renders
it; `praxis export-skill` ships it.

## Layer 7 — Agent Loop

`observe → reconstruct → fuse → update graph → decide`. The policy
([`policy.ts`](src/agent/policy.ts)) is **role-agnostic** — the same code runs for
a maintainer, a designer, or a founder; only the learned graph differs. It
chooses among keep-observing, ask-expert (the "I think you did X because Y —
correct?" card), intervene (in learner mode, when actions diverge from the
learned playbook), summarize-pattern, or mark-uncertainty. Runs as a debounced
live loop or a single `tick()`. Each decision is **persisted** (`decisions`
table) so the Studio can surface the agent's live questions — `capture --agent`
feeds the loop straight from the capture stream.

**The ask path is engineered for delivery.** Questions ship with the observer's
candidate answers, throttled (≤1 per 5 min, never re-asked once answered), to
`data/notifications.ndjson`. The menu-bar app tails it and surfaces each
question **twice**: a system notification with option buttons + a text-input
action, and a floating **glass question panel** that macOS cannot mute — built
after Focus/DND and screen-sharing silently swallowed notifications twice in
one day. Answers from any surface (panel, notification, Studio card) POST to
`/api/answer`, become corrections, retract the question everywhere, and feed
the consolidation layer as the highest-grade evidence there is.

## Layer 8 — Praxis Studio

A `node:http` JSON API over the stores plus a zero-dependency vanilla-JS SPA.
Eight views: Live Feed, Action Timeline, Episode Timeline, Connections, Memory
Graph (SVG), Questions, Corrections, Transfer. The **Live Feed is real-time** —
`/api/stream` is a Server-Sent-Events endpoint that tails new ledger rows by
rowid (so it works even when a *separate* capture process is the writer, via the
WAL DB) and pushes them to the browser, which prepends them live. The same stream
carries **live agent decisions** (`event: decision`) — an `ask_expert` question
pops up as a toast and lands in the Questions view in real time. The centerpiece
is the **correction card** — every uncertain interpretation rendered as "I think you did X because Y.
Evidence: A, B, C. Correct?" with clickable evidence chips (drill into the raw
event / blob) and Correct / Wrong / Edit buttons that `POST` a correction back to
the ledger.

## Layer 11 — Transfer

`buildPlaybook()` distills the graph into an operable model (workflow, decision
rules, know-how, taste, open questions — each with evidence). `critique()` checks
a learner/agent's actions against it (e.g. "committed without running tests
first") — conformance-checking, never invention. This is what the agent loop uses
to intervene.

**`praxis export-skill`** renders the consolidated, correction-filtered profile
as a portable `SKILL.md` (priority-tiered rules, evidence episode counts,
durable-first) that installs into any agent's skill directory — the learned
model of the expert, made operable outside Praxis.

## Operational hardening (learned in production)

- **TCC identity**: capture runs **in-process inside the signed menu-bar app**
  (a child helper does not inherit the grant), signed with a stable local cert
  so permissions survive rebuilds ([`scripts/setup-signing.sh`](scripts/setup-signing.sh)).
- **Orphan-proof lifecycle**: the capture pipeline's stdin is a pipe from the
  bar — EOF on it shuts the pipeline down no matter how the bar died; the bar
  handles SIGTERM with the same cleanup as Quit, refuses to start twice, and
  the Studio defers (exit 0) to a healthy Studio already on its port.
- **Bounded everything**: the observer sees only bounded bundles, the Studio
  API ships only the newest slice of large tables, OCR runs only on changed
  frames, and the recognizer runs only when sound is present.

## Toolchain notes

- **No build step.** Source is `.ts` run directly by Node ≥ 23.6 type-stripping,
  so relative imports keep their `.ts` extension and nothing is emitted. `tsc` is
  used only for typechecking.
- **Zero runtime dependencies.** SQLite (`node:sqlite`), tests (`node:test`),
  HTTP (`node:http`), hashing (`node:crypto`) are all built in.
- **Determinism.** Tests/demo use a seeded id generator; the reconstructor and
  fuser are pure functions over event lists, so output is reproducible.
