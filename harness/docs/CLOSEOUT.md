# Close-out: project status, what is left, and how to maintain it

_October 2026._ The harness is feature-complete. Everything on the
roadmap is built, tested in CI without API keys, and documented. What
remains is analysis: running the benchmark and writing up results.

## The roadmap, closed

| roadmap item | what was built | design |
|---|---|---|
| A model plays the Corp | `llm-game --seat corp`: Corp prompts to the Runner's standard, Corp-perspective labels and log, the full option-menu invariant | [D14](design/D14-corp-seat-and-model-vs-model.md) |
| Model against model | `--seat both` with per-seat models, transcripts, thresholds, debriefs and costs; seat-aware records, corpus, formatter and viewer | [D14](design/D14-corp-seat-and-model-vs-model.md) |
| A larger card pool | 71 precons playable: on-demand set loading (`&sets=`), a qualification run that refuses decks hitting engine defects, a keyless pool smoke test | [D16](design/D16-card-pool.md) |
| A real-time, better-looking viewer | Engine-free board viewer with three perspectives, timeline and the model's reasoning; live mode over SSE (one game or a whole match); exact re-simulation of every recorded game | [D15](design/D15-board-viewer-and-live.md) |
| Documentation and a project page | Rewritten READMEs, this document, and a GitHub Pages site generated from the corpus | [D17](design/D17-project-site.md) |
| Clean-up and close-out | `run-match` for the measured runs, the checker selftest, CI covering every seat mode, design-doc statuses brought current | [D06 §1](design/D06-match-runner-and-inspect.md), [D11](design/D11-audit-selftest.md) |

### Found and fixed along the way

- **Rules-AI shortcuts were deciding for the model.** Card scripts carry
  branches for the engine's own AI that run whenever a seat has an AI
  object, pruning menus to the rules AI's pick. The model's seat had one
  (the delegation shell), so some menus were silently narrowed, in
  every era before D14. Card code now treats model seats as human
  players. That change starts **interface era 4**; earlier games are
  not comparable with later ones, and the corpus report keeps them
  apart.
- **Breach menus could name hidden cards.** The extended option-menu
  invariant found access labels carrying the title of a card the
  player could not see. Checking every recorded era-3 menu showed none
  of these ever reached a model. Labels are now masked at the source.
- **A checker false positive** (hosted cards outside every zone, such
  as Detente's) fixed in the census, not by loosening the check.
- **Replay fidelity proven.** All 11 corpus games re-simulate decision
  by decision from their recorded choices, with no API calls.
- **Viewer frames at rules-AI decisions were captured late.** The
  opponent's decisions don't pause the game, and their board snapshots
  were taken by the host after the fact, so some frames showed a later
  board. Comparing two re-simulations exposed it. The page now takes
  those snapshots at decision time, frames reproduce byte for byte, and
  CI checks it.
- **Engine defects in the extended pool**, found by qualification and
  left in the quarantined engine (see below).

## What is left: analysis

These are the author's, and the tooling for each exists.

1. **The 10-game run** ([D12](design/D12-ten-game-run.md)), the first
   era-4 data and the M5 milestone, with the within-seed arm:

   ```sh
   npx tsx src/cli.ts run-match --games 10 --seed 1 --model claude-haiku-4-5 --label m5-haiku
   npx tsx src/cli.ts run-match --seeds 7 --repeat 3 --model claude-haiku-4-5 --label m5-var-s7
   npx tsx src/cli.ts corpus --promote out/match-m5-haiku/<game_id> ...
   ```

   D12 projects about $14 for the haiku run.
2. **Re-baseline the shakedown cohort in era 4**, since the 11 corpus
   games predate D14.
3. **First Corp-seat and model-versus-model games**, and matchups beyond
   the Gateway decks (`pool` lists qualified decks).
4. **Ablation arms** that justify the defaults: `--actions split`,
   `--context stateless`, `--history lean`, `--auto-resolve off`, and
   `--ai-branches rules` (an era-3 interface inside era-4 tooling).
5. **The D11 human calibration pass:** hand-check one
   `audit --review-sample 12` packet.
6. **The results discussion** on the project page: the placeholder
   under the results table in `site/index.html`.

## Parked: designed or discussed, deliberately not built

| item | where it was discussed | why it waits |
|---|---|---|
| Counterfactual model-swap replay (ask model B at model A's position) | D12 non-goals | the context-transplant question needs a design first |
| Decision-quality metrics | D10 (Part B) | a Phase-2 instrument, designed with the counterfactuals |
| Batch-API broker | D12 | ~2× upside against ~3× downside when cache hits are lost; pilot first, and the stateless arm is its natural workload |
| Temperature and sampling ablations; k > 3 variance studies | D12 | Phase 2 |
| Harness ablation ladder (RunCalculator tool, scratchpad, beliefs) | PHASE1 parking lot | after the baseline exists |
| Pilot-notes ablation (deck-piloting guides in the prompt) | PHASE1 parking lot | after the baseline exists |
| Deckbuilding and drafting | PHASE1 parking lot | stretch goal |
| MCP wrapper; bring-your-own-key play in the browser | PHASE1 parking lot | distribution, not measurement |
| Node-direct engine (no browser) for throughput | PHASE1 design constraints | not needed at current scale |
| Fixing the engine defects behind refused decks | below | upstream work: the engine is quarantined here |

## Known engine defects (card-pool qualification)

`npx tsx src/cli.ts pool --qualify` plays every precon three times
against the Gateway reference opponent (rules AI on both sides, the
no-cheating invariant on, the conservation audit run), plus once with
the mock model in the deck's own seat. A deck qualifies only if every
game completes with no hard error, leak, audit finding or invalid
record. Refused decks, with the first problem seen:

| deck | side | sets | games failing (first) | first problem |
|---|---|---|---|---|
| Agency | Corp | elevation | 1 of 4 (rules game, seed 3) | LogError: TypeError: Cannot read properties of null (reading 'unique') |
| Fashion Lab | Corp | elevation | 1 of 4 (rules game, seed 1) | game stalled: LogError: TypeError: Cannot read properties of null (reading 'unique') |
| Economy, Chaos and FIxed Suit | Runner | coreset | 1 of 4 (rules game, seed 1) | game stalled: unhandledrejection: TypeError: Cannot read properties of undefined (reading 'length') |
| Professional Opportunities | Runner | elevation | 1 of 4 (rules game, seed 3) | LogError: preferred option not matched with the above optionList and preferred: |
| R&Devour | Runner | coreset | 1 of 4 (rules game, seed 3) | game stalled: unhandledrejection: TypeError: Cannot read properties of undefined (reading 'length') |

These are engine defects: each reproduces in rules-AI-only games with
no harness seat involved. `llm-game` and `run-match` refuse these decks
unless `--allow-unqualified` is passed; `smoke` skips them.

## Maintenance

- **Adding results.** Promote finished runs (`corpus --promote`), which
  regenerates `data/CORPUS.md`. Then run **Actions → Publish GitHub
  Pages** from `dev`. The site data is rebuilt from the corpus on every
  publish.
- **Merging upstream engine changes.** Follow
  [`ENGINE.md`](ENGINE.md). Any engine-affecting change must pass
  `golden check` (re-bless with `golden record` only when the change is
  intended), then re-run `pool --qualify`, `selftest`, and
  `frames --corpus` to confirm recorded games still replay.
- **New models.** Add a `THRESHOLD_DEFAULTS` entry in `src/cli.ts`
  (about 75% of the context window; see
  [`PROMPTING.md`](PROMPTING.md)) and a `src/prices.ts` entry when the
  provider does not report cost. Prices carry an as-of date; check it
  before quoting dollar figures.
- **Before trusting a new checker or audit rule**, add its plant to
  `src/selftest.ts`. A checker that has never caught a planted defect
  is indistinguishable from one that cannot.

## Repository map

```
harness.html, harness/inspect.html   engine loadouts (headless seat page; engine-board replay)
harness/page/                        in-page code: bootstrap, serializer + invariant,
                                     model seats (llmplayer.js), board snapshots
harness/src/                         host: cli, game/llmgame, llm clients, prompts,
                                     match, corpus, audit, selftest, resim, site, live
harness/data/                        tracked corpus (games/, CORPUS.md)
harness/fixtures/                    golden logs, pool.json
harness/rules/                       NSG rules snapshots given to the models
harness/docs/                        designs D01–D17, reviews, guides, this file
site/                                project page + board viewer (Pages)
precons/, sets/, *.js                the engine (quarantined; unmodified)
```
