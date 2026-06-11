# Praxis

**A creator economy for tacit knowledge.** Experts capture their craft while they work, publish what they choose, and earn royalties every time a human — or an AI — learns from them. Substack for craft, not Surge for labels.

> *praxis (n.) — knowledge expressed through practice; the applied, embodied skill that an expert cannot fully put into words. Michael Polanyi: "We know more than we can tell."*

---

## The one-paragraph pitch

Every expert carries decades of judgment that dies when they retire — or gets extracted by their employer right before they're laid off. Praxis is the opposite. You capture your craft on your own terms, while you work. You publish what you choose. AI mentors trained on your taste teach the next generation, asynchronously, inside their own workflow. Every time someone learns from you, you get paid. We are the publishing platform for tacit knowledge.

## Why now (as of May 2026)

The tacit-knowledge-capture category just went mainstream — in its dystopian form:

- **Meta's Model Capability Initiative (MCI)** — forced keystroke/screen/mouse capture of all US employees to train AI agents, no opt-out, followed days later by 8,000 layoffs. Internal protests call it an "Employee Data Extraction Factory."
- **China's Colleague Skill** — viral (18k+ GitHub stars) "dual-track personality distillation" that turns a departing coworker into an AI replacement from their Lark/DingTalk history.
- **Worker counter-movement** — anti-distill skills, the Poison Fountain data-poisoning campaign, unionization. Workers are actively sabotaging involuntary capture.
- **EU AI Act** — enforcement August 2026; workplace-monitoring AI is high-risk, emotion tracking is banned outright, penalties up to 7% of global turnover.

The market is hot and the brand stakes are existential. The middleman that wins is the one experts **choose**, not the one their boss forces on them. Praxis is built to be the trusted, consensual, expert-owned alternative — which, not coincidentally, also produces *higher-quality, legally-saleable* data than any extraction approach.

## What this repo is

The founding documents — the source of truth for the narrative, product, tech approach, and non-negotiable principles — **plus the working prototype**: a zero-install macOS capture + reconstruction pipeline (multi-display screen/OCR, on-device audio transcription, universal app scraping → exact reconstructed actions → work episodes → an evidence-backed expert memory graph → a portable skill any agent can operate from). Every interpretation carries confidence and links back to raw evidence; raw audio and captured data never leave the machine. See [`PROTOTYPE.md`](PROTOTYPE.md) to run it.

## Repo map

| Doc | What's inside |
|---|---|
| [`docs/00-narrative.md`](docs/00-narrative.md) | The narrative, positioning, what we are and are not, the decision test |
| [`docs/01-product-spec.md`](docs/01-product-spec.md) | Two-sided platform (expert / learner / buyer), training signals, output products, pricing |
| [`docs/02-tech-stack.md`](docs/02-tech-stack.md) | Root-layer capture thesis, the six taps, the local-LLM proxy, full stack, model bets |
| [`docs/03-competitive-landscape.md`](docs/03-competitive-landscape.md) | Paperboy, AirJelly, Meta MCI, China/Colleague Skill, Interloom, Screenpipe, et al. |
| [`docs/04-data-moat.md`](docs/04-data-moat.md) | Do labs need it / does it accumulate / is it sparse; why consensual data is structurally better |
| [`docs/05-brand-principles.md`](docs/05-brand-principles.md) | The eight non-negotiables; the press answer |
| [`docs/06-roadmap.md`](docs/06-roadmap.md) | Phasing, the first 60 days, the moat layers |
| [`PROTOTYPE.md`](PROTOTYPE.md) | The working prototype: quick start, the pipeline, the menu-bar app, Studio |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the code is laid out — capture taps, reconstructor, fuser, observer, memory, transfer |

## The test that governs every decision

> **"Would an expert proud of their craft hear how we're doing this and choose to participate?"**

If yes, we're building Praxis. If "only if I had to," we're building Meta MCI under a friendlier logo.
