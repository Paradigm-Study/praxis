# 01 — Product Spec

## Shape: two-sided platform, three customer segments

```
EXPERT (publisher)              LEARNER (apprentice)            BUYER (platform/lab)
───────────────────             ──────────────────              ─────────────────────
Installs macOS agent       →    Subscribes to mentor(s)    →    Licenses API access
Works normally                  Works in own tools              Embeds in their product
Builds Taste Profile            Gets inline shadow-draft        Pays per call / bulk
Chooses what to publish         mentor feedback during work     Always with consent
Earns royalties on every use ←──────────────────────────────────────────────────────
Owns export keys, can revoke
```

## For the expert (publisher)

- Native macOS client. Ambient capture, **fully expert-controlled**.
- A **Taste Profile** builds passively over time from: edit-in-place diffs, commit-moment anchors, reasoning traces, the discarded options, the 50ms "ugh no" reflexes.
- Owns the encryption keys. One-click export. One-click revoke (retroactive where technically possible).
- Publishes **selectively** — by skill, by domain, by context. Open mentorship / paid subscribers / enterprise / AI-lab licensing are **separate opt-ins**.
- Royalties flow from every commercial use, attributable per-expert.

## For the learner (apprentice)

- Subscribes to one or more mentors, consumed **inside their own workflow**.
- Inline shadow-draft mentorship during real work:
  - *"Adam would have flagged the null check on line 47."*
  - *"Liz softens external-client emails by leading with context, not the ask."*
  - *"Dr. Chen typically orders troponins earlier in this presentation."*
- Asynchronous, ambient, in-tool. No videos, no scheduled courses.
- Pricing: $30/mo individual, $200/mo pro, $500–1000/mo for high-value verticals (legal/medical).

## For the platform / lab buyer

- API: `praxis.complete(profile="senior_SRE", context=...)` — embeds in AI tutors (Khanmigo, Cursor), L&D platforms, succession-planning tools.
- Or **bulk dataset licensing** with full provenance manifest for AI foundation labs.
- Pricing: $0.001–0.01/call API tier; $5M–$50M annual labs tier.

## The five training signals (the loss function)

These fall out of natural work with ~zero extra expert effort:

1. **Taste diff** — character-level diff between an AI shadow draft and what the expert actually shipped. Highest density. (See the local-LLM proxy in `02-tech-stack.md` — we often don't even generate the shadow draft; the expert's own AI tool did.)
2. **Negative space** — options considered then discarded; AI suggestions ignored. Surfaces constraints the expert can't articulate.
3. **Dwell + revisit** — what they read carefully vs. skimmed; what they returned to. Surfaces what *matters*.
4. **Probe response** — rare, opt-in pairwise choices, rate-limited to ≤5/day, never during deep-work windows. Disambiguates when the model is unsure.
5. **Absence** — counterfactual: what the expert noticed that a naive AI missed. Hardest to extract, most valuable; mined by replaying past expert actions against shadow drafts.

## The four canonical revenue products

| Product | Buyer | Pricing |
|---|---|---|
| **Mentor subscription** | Learners (consumer/prosumer) | $30–$200/mo |
| **Enterprise expert-preservation** | Corporates (succession planning, attrition risk) | $50K–$500K per expert/year |
| **Platform API access** | AI tutors / editors / L&D tools | $0.001–0.01/call or rev-share |
| **Anonymized dataset license** | AI foundation labs | $5M–$50M/year, exclusivity tiers |

Expert revenue share: **60–70% to the expert**, 30–40% platform take. Transparent, contractual, per-use attributed.

## Three trace SKUs (what labs actually buy)

All three are byproducts of the same capture:

1. **Trajectory data** (pre-training style): `(state, action, result)` sequences — long-horizon, multi-app agent trajectories.
2. **Preference pairs** (RLHF/DPO style): `(prompt, chosen, rejected)` from edit-in-place diffs. `rejected` = AI shadow draft, `chosen` = what the expert shipped.
3. **Critique data** (self-critique training): `(output, expert_correction, corrected_output)` from the "absence" signal.

Different labs want different cuts — sell them as distinct contracts.

## Concrete usage scenarios

- **Junior engineer in Cursor** — Cursor calls `praxis` for `senior_SRE_pr_review`; inline comments appear in the expert's voice; junior pays Cursor, Cursor pays Praxis, Praxis pays the expert.
- **Bank preserving a retiring trader** — 18 months of ambient capture → internal "Marcus AI mentor" for new traders; bank pays $300K/yr, trader earns $80K/yr royalty.
- **Medical residency** — license 30 attendings' taste profiles; residents get inline EHR feedback; university pays $500K/yr, each physician earns $15K/yr.
- **Khan Academy** — Khanmigo embeds 100 expert profiles; sessions cite working scientists' actual reasoning, not textbook explanations.

All four run on the **same** capture + distillation infra. The product is one; the buyer surface is diverse.
