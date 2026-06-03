# 04 — The Data Moat

The end game is a data game. Three questions decide whether this is real.

## 1. Do labs actually need this data?

**Eaten / commodity (near-zero marginal value):** web crawl, books, code repos, standard RLHF pairs (Surge/Scale on tap), synthetic CoT/math, instruction-following.

**Starving for, can't get:**

| Data type | Why they want it | Who has it today |
|---|---|---|
| Expert workflow traces in natural environment | Train agentic models on real trajectories, not synthetic sandboxes | Nobody at scale |
| Edit-in-place diffs (AI draft vs. shipped) | Cleanest domain-specific preference signal | Nobody systematically |
| Failure-recovery traces | Train agents to detect their own mistakes | Nobody |
| Cross-app context (Slack → code → email) | Agents that understand work as a continuous narrative | Nobody — even MS can't unify it |
| "Absence" signal (what expert caught, AI missed) | Counterfactual training data — the grail | Nobody |
| Long-horizon multi-step tool use w/ expert ground truth | The current bottleneck for Operator/Claude Agent/Gemini | Anthropic (synthetic envs only) |

**Agentic trace data is the new bottleneck** — labs have said so publicly through 2026. They generate it synthetically and via beta telemetry; neither scales to the fidelity needed.

## 2. Does it accumulate? Three compounding axes

- **Per-expert (linear → superlinear):** 100h surfaces style; 500h domain judgment; 2,000h rare-event judgment; 5,000h+ the genuinely tacit ("I'd never approve this but can't say why").
- **Per-cohort (superlinear):** the invariants across 5 senior Stripe SREs are worth more than 5× one SRE — you learn what the *domain* agrees on vs. personal taste. This is what labs actually buy.
- **Per-pipeline (compounding indirect):** every new expert improves segmentation, redaction, preference extraction, judge quality — and re-mines old data. Scale/Surge labels are one-shot; **our captures are re-distillable.**

## 3. Is it sparse enough that labs aren't already capturing it?

| Player | Has | Critical gap |
|---|---|---|
| Anthropic | claude.ai chats, Computer-Use telemetry (synthetic), MCP logs | No ambient expert-workflow capture; ToS-limited on API logs |
| OpenAI | ChatGPT chats, Operator (early), o-series traces | Same; opt-out-by-default |
| Google | Workspace + Search (huge, ToS/privacy-locked) | Can't repurpose Workspace without backlash |
| **Microsoft** | GitHub + Office + Recall + Copilot — *best raw position* | Brand-burned by Recall; structurally can't be the neutral middleman; can't sell to itself |
| Meta | Rewind (acq.), Llama data, MCI | MCI data isn't externally licensable (employees', legal, would sue) |
| Scale / Surge | Labels, RLHF prefs | Task-dispatch muscle, not ambient capture |

**The gap:** no neutral middleman is harvesting expert workflows ambiently, with consent, and selling clean datasets to multiple labs. This is the exact gap Surge filled for *labels* in 2018. Different data type, same market structure.

## Why consensual data is structurally *better* (not just safer)

This is the crux. Consent isn't optics — it changes the product's quality and saleability:

1. **Quality.** No sabotage (anti-distill is already poisoning involuntary capture), no Hawthorne contamination, long-term continuity (capture for years; can't extract someone after they quit), better selection (the proud-of-craft experts opt in).
2. **Legal saleability.** Post-NYT-v-OpenAI and under the EU AI Act, labs cannot train production models on shaky-provenance data. A $20M dataset is worth $20M (vs $2M) precisely because of the **clean chain of consent + attribution**.
3. **Defensibility.** Meta can't externalize MCI data; Colleague Skill output has no provenance; Surge can't pivot to ambient capture without rebuilding. The consensual middleman is the only legal path at scale.

> **The most valuable tacit-knowledge corpus in the world will be the one collected consensually with attribution and revocation rights. The extracted versions will be poisoned, illegal, or both.**

## The honest two-layer business

- **Layer 1 (front of house):** experts publish, learners subscribe, royalties flow. Real, standalone business.
- **Layer 2 (back of house):** AI-lab licensing is the largest single revenue line by year 2–3. Also real. **Not hidden** — it's a contract term with explicit per-expert opt-in and per-dollar attribution.

We don't pretend Layer 2 doesn't exist (that's how you get exposed later). We make it transparent and fairly shared — the Substack posture: creators know the platform monetizes, stay because the deal is fair.

## Pricing intuitions (calibrated to market)

- Reddit→Google ~$60M/yr; NYT→OpenAI ~$250M; Scale ~$1B+ rev (2024); Surge ~$1B+ (2025, profitable).
- A lab's agentic-data budget 2026–27: est. $200M–$1B/yr, little of which has a home.
- Defensible ask: 1,000 expert contributors, high-value domain, 12 months agentic + preference data — **$10–50M exclusive, $3–15M non-exclusive per lab/year.**
- Closes a $50–200M ARR business at 3,000–10,000 experts.

## Risks to price in

- Synthetic agentic data gets good enough (bounded — expert taste is the hardest synthetic gap).
- Microsoft goes aggressive (but can't sell externally — actually makes us the only option for everyone else).
- Scale/Surge pivots (real threat; they'd rebuild the client stack from zero — outrun them).
- EU/state privacy crackdown (mitigate: on-device-only inference, granular consent, customer-managed keys).
- Expert refusal at scale (mitigate: ownership, fair share, exports, no cross-use without opt-in).
