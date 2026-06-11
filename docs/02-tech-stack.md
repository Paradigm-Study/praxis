# 02 — Tech Stack

## Core thesis: root-layer capture, not per-app integration

The Granola insight: don't integrate with Zoom/Meet/Teams/Webex individually — sit *underneath* all of them at the Core Audio layer. One permission, universal coverage. We apply the same thinking to **workflow** capture and stop building per-app integrations entirely.

For audio, the system layer is Core Audio. For workflow there isn't one layer — there are six, composed. Each sits **below the app permission boundary**.

## The six root-layer taps (macOS)

| Tap | API | Permission | What you get | Granola-style? |
|---|---|---|---|---|
| **Screen** | `ScreenCaptureKit` (`SCStream`) | Screen Recording | Every pixel across every app | Yes — one perm, all apps |
| **System audio** | `CATapDescription` (14.4+) | Audio Capture | Speaker output + mic, no virtual device | This *is* the Granola trick |
| **Input** | `CGEventTap` | Accessibility | Every keystroke/click, every commit-moment (Enter/Cmd-S/Send) | Yes — system-wide |
| **Filesystem** | `FSEventStreamCreate` + Spotlight | None (user dirs) | Every save, git commit, download, screenshot, with content | No permission at all |
| **Clipboard** | `NSPasteboard` poll on `changeCount` | None | Every copy/paste — the cross-app workflow trace | No permission |
| **AI traffic** | Local proxy on `localhost:11435` as `OPENAI_API_BASE` | None | Every prompt+response across Cursor, Cody, Copilot, Claude.ai, ChatGPT | The biggest one, ignored by everyone |

These compose into a **single install ceremony of 3–4 permission prompts**. After that: complete coverage of every workflow surface. No Slack/Notion/Figma/Linear plugins ever.

## The killer move nobody else is doing: the local-LLM proxy

```
Expert opens Cursor / Claude.ai / ChatGPT / Cody
                ↓
Their API calls route to localhost:11435 (env var or system PAC)
                ↓
Praxis proxy logs (prompt, response) → forwards to the real API
                ↓
Expert edits / accepts / rejects the response in their tool
                ↓
Praxis observes the final shipped artifact via FSEvents / screen
                ↓
diff(response, shipped artifact) = pure taste signal, zero extra work
```

This is the shadow-draft framework **without having to generate the shadow draft** — the expert's own AI tool generated it; we observed both sides of the loop. Result: a labeled `(prompt, AI suggestion, human correction, final output)` tuple — the most valuable preference-pair format in existence — harvested ambient. Setup cost for the expert: one env var or PAC file.

## The composite stack

```
┌─────────────────────────────────────────────────────────┐
│              INSTALL CEREMONY (one-time)                 │
│  4 permission prompts: Screen Recording · Accessibility  │
│  · Audio Capture · Full Disk Access (AI proxy cert)      │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  ROOT-LAYER TAPS (always-on)             │
│  SCStream · CATapDescription · CGEventTap                │
│  FSEvents+Spotlight · NSPasteboard · Local proxy :11435  │
└─────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│        ON-DEVICE NORMALIZER (Rust core)                  │
│  Episode segmentation · PII redaction (Presidio+tiny VLM)│
│  Commit-moment correlation (Enter + AI call + save)      │
│  Expert-key-encrypted local store                        │
└─────────────────────────────────────────────────────────┘
                          ▼
              (only what the expert publishes)
                          ▼
                  Cloud distillation
```

Result: a **thinner** client with **more** coverage. Install <30MB, single binary, 3–4 prompts, zero per-app onboarding.

## Full stack picks

| Layer | Pick | Why |
|---|---|---|
| Capture client (macOS) | Swift shell + Rust core (`capture-core`) | Minimum native surface |
| On-device VLM (pixel parse) | Qwen3-VL / Apple foundation model | Pixels → structured events, free + private |
| On-device shadow draft | MLX + Qwen3-32B / Llama 4 Mini class | Sub-200ms, free, on-device |
| Cloud frontier inference | Claude 5.x / GPT-5.x, 10M ctx + prompt caching | Replaces vector DB at personal scale; invoked only at "final commit" |
| Episode storage | Postgres + S3, **expert-held keys** | Instant revocation; anti-Meta architecture |
| Cross-expert vector DB | Turbopuffer (later, at cohort scale) | Single-expert scale doesn't need it |
| Aggregate analytics | ClickHouse | Cohort taste profiles, judge training |
| Distillation pipeline | Temporal + Modal (LoRA training) | Durable, traceable |
| Per-expert adapters | LoRA on Llama 4 base, served via vLLM | Hours to train, cheap to serve, swappable |
| Judge models | Fine-tuned 8B per domain | The product labs/tutors pay for |
| Real-time shadow agent | Anthropic Computer Use API class | Mimics expert; diff = richer signal |
| Adversarial robustness | Cross-expert consistency + anti-distill classifier + reputation scoring | Anti-distill is a real adversary now |
| Auth | WorkOS (enterprise SSO) | Bank/legal/medical requirement |
| Billing / payouts | Stripe + Metronome (usage) · Tipalti (intl royalties) | Multi-currency, tax-form handling |
| Compliance | Vanta · SOC 2 · EU AI Act risk register · BAAs | Enforcement Aug 2026 — non-optional |

## Cross-platform parity (Phase 2)

| Tap | macOS | Windows | Linux |
|---|---|---|---|
| Screen | ScreenCaptureKit | DXGI Desktop Duplication / WGC | PipeWire |
| System audio | CATapDescription | WASAPI loopback (easier than mac) | PipeWire monitor |
| Input | CGEventTap | Raw Input + low-level kbd hook | evdev / libinput |
| Filesystem | FSEvents | ReadDirectoryChangesW / USN journal | inotify / fanotify |
| Clipboard | NSPasteboard | OpenClipboard | Wayland / X11 selections |
| AI proxy | localhost env var | same (provider-agnostic) | same |

## Deeper-root options (NOT for v1)

Heavy taps to reserve for enterprise on-prem (where MDM enrollment grants headroom):
- **Network Extension** (`NETransparentProxyProvider`) — route all HTTPS traffic; see every web-app API call. Needs a TLS cert install.
- **Endpoint Security Framework** — kernel-level process/file/network events. Needs a gated Apple entitlement.
- **Custom IME** — keystrokes before any app sees them. Permission-light, very root, reputationally sketchy (Grammarly-style).

The composite tap stack gets ~95% of the value at ~10% of the install friction and 100% of the legal cleanliness. Save the heavy taps for on-prem.

## Forward bet on model capability (6 months out, ~Q4 2026)

Decisions are made against where models are *going*, not where they are:

| Trend | Direction by Q4 2026 | Implication for us |
|---|---|---|
| Frontier VLM on arbitrary UI | Reliable enough to replace accessibility APIs | **Pixels-first capture is viable** |
| VLM cost / image | ~$0.0005–0.002, near-free at thumbnail | 300 commits/day ≈ $0.30/expert — trivial |
| On-device model class | 32B fast + good on M-series | Shadow drafts move on-device → free |
| Context window | 10M standard, cached re-reads near-free | **Vector DBs unnecessary for personal AI** |
| Real-time multimodal | Voice+screen+audio as one stream | Meeting capture is an SDK feature, not a product |
| Computer-use agents | Production-grade for repetitive tasks | Shadow *agent* (not just drafter) becomes feasible |

**Stop building** (will be commodity): per-app integrations, custom embeddings, OCR, single-user vector DBs, custom redaction LLMs.
**The moat is** the distillation pipeline + expert relationships + judge models + the consented dataset — not the capture plumbing.

---

## Status — what the prototype implements (June 2026)

The thesis above is now running code (see [`PROTOTYPE.md`](../PROTOTYPE.md) and [`ARCHITECTURE.md`](../ARCHITECTURE.md)). Tap-by-tap:

| Tap (thesis) | Shipped as | Status |
|---|---|---|
| Screen (`SCStream`) | `SCScreenshotManager` per display, every display each tick, Vision OCR (EN + 中文) at capture time, per-display change detection | ✅ verified live on a 3-display desk |
| System audio (`CATapDescription`) | **Deviation:** `SCStream capturesAudio` instead — rides the *existing* Screen Recording grant, so no fourth permission prompt. VAD-chunked **on-device** transcription (Apple Speech, multi-locale race); transcripts only, raw audio never written | ✅ verified e2e |
| Input (`CGEventTap`) | As designed; control keys + click coordinates only, never raw typed text (drafts come from AX) | ✅ |
| Filesystem (FSEvents) | Polling watcher + git source, opt-in via `--watch`/`PRAXIS_WATCH` | ✅ |
| Clipboard (`NSPasteboard`) | As designed | ✅ |
| AI traffic (local proxy) | Forwarding proxy on :4318, Anthropic + OpenAI shapes, records `(prompt, response)` pairs verbatim | ✅ — plus a **universal AX conversation scrape** that captures any chat UI (Claude desktop, ChatGPT web, Discord…) with zero per-app code, covering tools the proxy can't reach |
| On-device normalizer (Rust) | **Deviation:** TypeScript (Node ≥23.6, zero runtime deps) + Swift capture client. Episode segmentation, commit-moment correlation, and the evidence-linked claim graph are all implemented; PII redaction is not yet | ⚙️ partial |

Beyond the thesis, the prototype also ships: deterministic action reconstruction with noisy-OR confidence, episode fusion, a throttled multimodal observer, non-destructive claim consolidation with correction feedback, proactive expert questions (unsuppressible panel + notifications), a live evidence-first Studio, and `praxis export-skill` — the learned profile as a portable SKILL.md. One install ceremony, two prompts in practice (Screen Recording covers audio; Accessibility covers input/AX; mic is a separate opt-in).
