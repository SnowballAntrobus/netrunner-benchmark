# D12 — The 10-game run (M5 acceptance experiment)

**Status: awaiting review** · Per Dante: the 10-game run deserves its
own design — it is the first thing we produce that looks like a
benchmark RESULT rather than a pipeline artifact, so its cost model,
variance structure, and reporting deserve the same scrutiny the
harness got.

## What it is

The M5 acceptance line: 10 complete games, zero crashes, results
table, ≥1 moment visually inspected (D08 satisfies). One point in
config space, sampled across seeds — executed as a single `run-match`
(D06 §1), which this design depends on.

```sh
tsx src/cli.ts run-match --games 10 --seed 1 --model claude-haiku-4-5 \
    --label m5-haiku45
```

All knobs at defaults (compound, conversational/full, auto-resolve,
150K threshold, debrief on) — the defaults ARE the benchmark
configuration; the ablation arms exist to justify them later, not to
run here.

**Pre-run gates**: D06 §1 implemented (the vehicle), D11 selftest
green (we trust the checkers before trusting 10 games' worth of their
output), D08 review closed (the inspection tool is signed off), game 3
reviewed (no new finding-response designs pending).

## Cost model (from game 2 actuals, not estimates)

Game 2's ledger (record on disk): 136,666 uncached input + 13,856 out
+ 8,452,517 cache-read + 271,316 cache-write = **$1.39**. The
structure matters: **98.4% of input tokens were cache reads** at
$0.10/MTok — prompt caching is already carrying the cost. Compound
(D09) cuts API decisions further (game 3 will give the new baseline).
Projection: **≤ ~$14 for the 10-game run**, likely less under
compound.

## Batch API: analyzed, and rejected for this run

The Message Batches API gives 50% off all token prices, stacking with
caching — but batch cache hits are explicitly best-effort (documented
30–98% hit rates), and each request in a batch is independent: there
is no chaining. Our games are inherently sequential (decision N+1
depends on N), so batching can only work as a **lockstep broker**:
collect the pending decision from each of ~10 concurrent games,
submit as a batch, wait (typically minutes, up to 1h per batch),
distribute, repeat ~100+ rounds — with 10 live browser sessions held
open throughout and stall detection rewritten around batch latency.

The arithmetic on game 2's ledger:

| scenario | effective cost/game |
|---|---|
| interactive + caching (actual) | $1.39 |
| batch, cache hits hold (~98%) | ≈ $0.70 |
| batch, cache hits lost | ≈ $4.33 — **3× worse** |

Because our cost is 98% cache reads, the batch discount's upside is
capped at ~2× while its downside (losing cache locality to async
scheduling) is ~3× the other way — and batch rounds spaced anywhere
near the 5-minute cache TTL make the bad case the likely one. For a
~$14 run, the best case saves ~$7 against a substantial orchestration
inversion. **Recommendation: interactive for M5.** Batch becomes
interesting in Phase 2 at fleet scale (100s of games, stateless-arm
experiments whose requests are genuinely independent — the stateless
ablation is actually the PERFECT batch workload), and any batch
adoption starts with a pilot that measures the real cache-hit rate.

## Variance: across-seed and within-seed

Two different questions hide in "how good is haiku at netrunner":

- **Across-seed variance** (the 10 seeds): how much outcome varies
  with the game dealt — decks, draws, matchup texture. This is the
  benchmark's question-to-question variance.
- **Within-seed variance** (rerunning ONE seed): how much outcome
  varies with nothing changed but sampling. The engine is fully
  deterministic under our seed; the model is not. Anthropic's API has
  **no sampling-seed parameter** (OpenAI and Gemini expose best-effort
  ones), and temperature=0 would not deliver determinism anyway
  (greedy decoding still rides on nondeterministic serving
  infrastructure) — moreover we deliberately run at the API default
  temperature, because the benchmark should measure the model as it
  is actually used. So within-seed variance is irreducible: it must
  be measured, not assumed away.

This maps exactly onto the eval-statistics literature: Miller,
*Adding Error Bars to Evals* (arXiv 2411.00640) — seeds are clusters,
reruns are samples within a cluster, and the headline win rate should
carry a clustered standard error. Ten games without a variance
estimate is a point with invisible error bars.

**Proposal — fold a minimal within-seed arm into the milestone**: after
the 10-seed match, rerun ONE seed 3× (`run-match --games 3 --seed 7
--label m5-var-s7` runs seed 7,8,9 — so instead: three single
`llm-game --seed 7` invocations, or a `--repeat` flag on run-match;
implementation detail for review). Cost ≈ $4. Beyond outcomes, our
records enable a measurement most benchmarks can't make: same seed =
identical opening, so the **first-divergence seq** (first decision
where two runs' choices differ, found by diffing JSONL streams) tells
us WHERE stochasticity enters — turn-1 experimentation vs late-game
coin-flips are very different stories about reliability. The full
variance study (per-model, temperature as a knob, k>3) is Phase 2;
this arm just ensures M5's headline number ships with honest error
structure and the tooling to compute it exists.

## Reporting

`match-summary.md` from D06 §1, plus a short M5-REVIEW.md (game-2
review style, but match-level): win rate with n and the within-seed
read, reason histogram, retry/fallback incidence, preview
divergences (all of them adjudicated — game 2 had zero; 10 games is
the real test), compaction behavior across games (game 2 never
compacted; longer games will), and the D11 `--review-sample` packet
from one game of the match as the human calibration pass.

## Acceptance

- 10/10 completed, zero crashes (read from the table).
- Conservation audit green on all 10; invariant suite green
  (rules-vs-rules, unchanged); D11 selftest green BEFORE the run.
- Within-seed arm: 3 reruns of one seed completed, first-divergence
  seq computed for each pair.
- Results table + M5-REVIEW.md delivered for Dante's review.

## Non-goals (parked, with pointers)

- **Counterfactual model-swap replay** (Dante's other item): setting a
  recorded position and asking a DIFFERENT model to respond. The
  mechanics are nearly free — every record carries state, options, and
  reproduction_code — but the methodology isn't: a conversational-mode
  decision was made with a transcript behind it, and a swapped-in
  model has either model A's transcript (contaminated by A's
  reasoning style and choices) or no transcript (comparable only to
  the stateless arm, not to the original decision). Doing this
  honestly means designing the context-transplant question first —
  that is a Phase-2 evaluation instrument, designed alongside the
  decision-metrics work (D10 Part B), not before it.
- Batch-broker orchestration (Phase-2 cost lever; pilot first).
- Temperature/sampling ablations; k>3 variance studies; per-decision
  quality metrics (Phase 2, per the D10 scope ruling).
