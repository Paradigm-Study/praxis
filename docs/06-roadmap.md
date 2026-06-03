# 06 — Roadmap

## Phasing

| Phase | Months | Goal | Revenue |
|---|---|---|---|
| **0. Design partners** | 0–3 | Pay 30 senior engineers $200/hr for explicit capture sessions. Build v1 capture + distillation. Prove the shadow-draft-diff signal extracts usable taste. | $0 (cost ~$300K) |
| **1. Vertical wedge** | 3–9 | Ship v1 in the "code-review mentor" wedge. 50 expert publishers, 500 learner subscribers, 1 enterprise design partner. Prove unit economics + that apprentice-mode works. | $1–2M ARR |
| **2. Platform API** | 9–18 | Open API for AI-tutor / editor partners (Cursor, Khanmigo, code tools). 2 platform deals. 5K experts. First (intentionally small) AI-lab licensing reference deal (~$500K). | $5–10M ARR |
| **3. Multi-vertical** | 18–36 | Expand: writing/PM → design → legal/medical. Series B. Become the rights-cleared tacit-knowledge content layer for the AI learning economy. | $30M+ ARR |

## The moat — ordered by depth

1. **Capture tech** — 18-month lead at best. Don't bet on it.
2. **Distillation pipeline** — 2-year lead, compounds with every expert. Real moat.
3. **Expert relationships + reputation** — Substack-effect; creators stay where they're paid and respected. **Deep moat.**
4. **Dataset with full provenance** — irreproducible without 2+ years of consented capture. **Deepest moat.**
5. **"Anti-Meta" brand** — in a post-MCI world, trust is the moat; unwinnable for anyone who didn't say no to the wrong customers early.

The middle/deep moats matter most. All require being the company experts and learners actively *choose*.

## First 60 days

1. **Publish the founding piece.** Founder essay laying out the eight non-negotiables, framed against Meta MCI and Colleague Skill. No product hype — just "the line we will not cross." Recruits aligned experts, investors, team.
2. **Recruit the first 5 design-partner experts** from the network (senior engineers). Pay well, explicit contracts matching the non-negotiables. They become the first published profiles AND the first case studies.
3. **Build the thin capture-client MVP.** Fork MineContext (Apache) for the runtime; write the macOS shell around the six root-layer taps. Ship in ~8 weeks. No per-app integrations. **Prioritize the local-LLM proxy** — it's the highest-signal, lowest-friction surface and nobody else has it.
4. **Land one platform conversation** with Cursor / Codeium / Anthropic — a design-partnership exploration, not a contract. They're starving for the data we're about to produce.
5. **Start compliance early.** File the EU AI Act conformity assessment; begin SOC 2 (6–9 months, blocking for Phase 2 customers).

## Open decisions (carry-forward)

- **First vertical:** software engineering is the default (network access, expert density, lab demand, constrained action surface that gets good with less data). Alternatives: writing/PM (higher per-expert value, smaller supply), legal/medical (huge willingness-to-pay, brutal compliance).
- **Lead side of the 3-sided market:** recommendation = **platform-led** via one design-partner deal (clear north-star → focused expert recruitment → tight feedback loop), with a small consumer cohort in parallel to prove the science.
- **Single-expert adapters vs. cohort aggregation:** start single-expert (specificity), aggregate into cohort "domain taste" later (that's the sellable SKU).
- **Exclusivity vs. multi-buyer** on the same dataset: offer both tiers; exclusivity is a moat against competitors for marquee experts.
- **Build vs. fork capture:** fork MineContext to reach "10 experts capturing" in weeks; replace incrementally.

## The one sentence to carry through every decision

> **"Would an expert proud of their craft hear how we're doing this and choose to participate?"**
