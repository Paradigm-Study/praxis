# 03 — Competitive Landscape (as of May 2026)

## Paperboy (paperboy.com)

Closest philosophical sibling. Validates the "minimal interaction, ambient capture" thesis — and notably does **not** use screen recording.

- **Team/funding:** John Yang (21, CEO), Jett Chen (19, CMU, founding engineer). 12 people, 10 engineers. $4.7M raised. Reportedly declined a Devin/Cognition acquisition offer.
- **Product:** ambient macOS desktop assistant; continuous presence, not session-based.
- **Capture stack:** macOS **accessibility + automation APIs** (structured events, not pixels); local inference for sub-200ms intent.
- **Architecture (neural-net metaphor for a personal AI):**
  - Knowledge graph = weight matrix (reasoning patterns, voice, values)
  - User corrections = backpropagation ("that's not how I'd say it")
  - Attention = dynamic per-query context retrieval
  - Memory gates = input/forget/output over the knowledge graph
  - Mixture-of-experts = per-surface agents (Slack/code/email) + a central **"gardener"** that cross-pollinates
- **Five operating speeds:** Reflex (<1s) → Glance (1–2s) → Think (seconds) → Work (generated UIs) → Background (continuous).
- **Five training signals:** Accuracy, Latency, Autonomy, **Taste** (char-level diff between AI draft and what the user sent), **Absence** (counterfactual: what should've been noticed).
- **Thesis:** *"Context accumulates with linear storage costs and can't be copied"* — the moat is accumulated personal context, not the models.
- **Source video:** 十字路口 / Koji杨远骋 podcast, May 20 2026 — "the best way for humans and AI agents to work together hasn't been invented yet."

**What we take:** the shadow-draft "Taste" signal; the latency-tiered UX. **Where we differ:** Paperboy is single-player (assistant for the expert). Praxis adds the publishing/royalty/teaching layer and the dual-sided flywheel.

## AirJelly / MineContext lineage

- Commit-moment capture (Enter/Send/Save as semantic anchors) — the keeper insight we adopt.
- MineContext (Apache-licensed, ByteDance-adjacent) is a viable fork base: continuous screenshots, ChromaDB, VLM parsing. Fork to reach "10 experts capturing" in weeks, not months.
- **Gap vs. us:** no shadow-draft diff; capture-for-self, not publish-for-others.

## Meta — Model Capability Initiative (MCI) — the dystopian playbook

- **Announced April 2026; 8,000 layoffs followed in May.**
- Captures mouse, clicks, keystrokes, periodic screenshots across Google Workspace, MS apps, **VS Code**, etc.
- All US employees, **no opt-out**. EU exempt (GDPR + AI Act).
- Run by **Alexandr Wang** (ex-Scale AI) at Meta Superintelligence Labs. Spokesperson: *"our models need real examples of how we actually use [computers]."*
- Internal target: 65% of engineers writing 75%+ of code via AI.
- **Worker response:** "Employee Data Extraction Factory" flyers across offices; leaked Zuckerberg audio; UK unionization.

**This is the brand we must NOT be.** It is the case study of the wrong way.

## China — Colleague Skill / OpenClaw wave

- **Colleague Skill** (GitHub `titanwings`, 18k+ stars): "Dual-track Personality Distillation" → `work.md` (technical norms, CR standards, decision patterns) + `persona.md` (5-layer communication style, blame-deflection habits, culture quirks) → executable `SKILL.md` for Claude Code / OpenClaw.
- **Data sources:** auto-import from **Lark (Feishu)** + **DingTalk** (OAuth `im:message`/`im:chat` or browser scrape), email, file upload.
- Framed as preserving a departing colleague ("Digital Life 1.0"); created as a spoof, then bosses started pressuring workers to use it.
- ByteDance/Tencent/Alibaba: 60–90% of new hires into AI; OpenClaw + Claude Code a "national craze."

## The worker counter-movement (the part most miss)

| Resistance | What it does | Scale |
|---|---|---|
| **Anti-distill skill** (Koki Xu) | Sanitization layer — output looks complete but core knowledge hollowed | 5M+ likes |
| **Poison Fountain** | Coordinated insider data-poisoning campaign | 250 clean-label docs can compromise any-size model |
| **Performative skills** | Expertise encoded with dependencies only the author understands | Spreading on GitHub |
| **Anthropic ANTI_DISTILLATION_CC** | Decoy tool defs injected into Claude Code traffic | Shipped |

Implication: involuntary capture produces *poisoned* data. The expert must be the willing party — which is also our brand.

## Interloom (enterprise tacit knowledge)

- Munich; $16.5M Series A (DN Capital), March 2026; founder Fabian Jakobi (ex-Boxplot → Hyperscience).
- Ingests millions of operational records (support emails, tickets, call transcripts, work orders) → a **"context graph"** (Google-Maps analogy) of how experts solve problems.
- Customers: Commerzbank (knowledge gaps 50%→5%), VW, Zurich Insurance.
- **Opposite extreme from us:** ingest the existing operational data warehouse (works for B2B with a CRM to pipe in); doesn't work for consumer/prosumer or for the *workflow* signal.

## Personal-memory / capture tools

| Tool | Bet | Status |
|---|---|---|
| **Screenpipe** (YC S26) | Open-source local screen+audio, "Pipes" = scheduled agents | The closest to universal-screen-recording |
| **Rewind AI** | Local 24/7 screen memory | **Acquired by Meta Dec 2025; capture sunset** |
| **Limitless** | Pivoted to Pendant wearable + cloud (ambient audio) | Different bet (audio, not screen) |
| **Granola** | Meeting notes via system-audio tap + live chat | Proves narrow-vertical deep-capture works; source of our root-layer thesis |
| **Microsoft Recall** | OS-level screen capture | Near-killed for privacy 2024; relaunched local/opt-in/encrypted |
| **Mem 2.0 / Personal AI / Saner / Lindy** | Note/memory/assistant variants | Adjacent, not tacit-capture |

## Positioning summary

| | Meta MCI | Colleague Skill | Surge/Scale | Paperboy | **Praxis** |
|---|---|---|---|---|---|
| Who decides capture | Employer | Coworker/mgr | Worker (task) | Expert (self) | **Expert (self)** |
| Consent | Forced | Pressured | Per-task | Self | **Voluntary, granular** |
| Data ownership | Meta | Operator | Buyer | Expert | **Expert** |
| Expert paid | No | No | Per-task | n/a | **Royalties + equity** |
| Output | Internal AI | Replacement AI | Labels | Self-assistant | **Teach humans + opt-in lab licensing** |
| EU-legal | No | No | Partial | Partial | **Yes (built to AI Act)** |
