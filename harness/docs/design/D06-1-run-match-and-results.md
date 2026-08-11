# D06 §1 — `run-match`: batching, results table, price table

**Status: awaiting review** · Split out of D06 per review: batching
machinery is designed only now that a single-game pipeline (games 2–3,
D01–D10) has been shaken down. D06 §2 (inspect) is **superseded by D08**
— the replay viewer does everything inspect proposed and more, so §2
will not be built. This document is the whole of what remains of D06.

## Purpose

The M5 acceptance line is "10 complete games, zero crashes, results
table, at least one moment inspected visually." D08 satisfies the last
clause; this design is the vehicle for the first three. Beyond M5, this
is the shape every Phase-2 experiment takes: N games per configuration,
one table per configuration, tables compared across arms.

## CLI

```sh
tsx src/cli.ts run-match --games N [--seed S] [--label NAME] [every llm-game knob]
```

- Runs N **sequential** `runLLMGame`s on seeds `S..S+N-1` (default
  S=1). Sequential, not parallel: per-game determinism doesn't require
  it, but API rate limits, the shared out-dir write pattern, and
  debuggability all favor one game at a time. Parallelism is a Phase-2
  option if wall-clock ever matters.
- Every `llm-game` knob passes through unchanged (`--model`,
  `--actions`, `--context`, `--compact-threshold`, ...) and applies to
  ALL games in the match — a match is one point in config space,
  sampled N times. Comparing configurations = comparing matches.
- `--progress` is forwarded per game; `--watch` is refused with a
  message (N tail terminals is a mistake nobody wants).

## Match identity and layout

```
out/match-<label>/
  match.json          # config + per-game row data (machine-readable)
  match-summary.md    # the results table (human-readable)
  <gameId>.json       # per-game artifacts, exactly as llm-game writes
  <gameId>.jsonl      #   them today — format/audit/replay all work
  <gameId>-debrief.json
  <gameId>-system-prompt.txt
```

- `--label` names the match directory. Default:
  `s<S>x<N>-<model-short>-<epochms>` (e.g. `s1x10-haiku45-17864...`).
  This revives the label question D06 killed for single games, at the
  level where it is natural: a MATCH is an experiment run, the config
  is fixed within it, and the epoch suffix guarantees uniqueness. The
  label is a directory name, not an analysis key — `match.json` carries
  the full config for that.
- Per-game artifacts are unchanged and self-contained, so every
  existing tool (`format`, `audit --file`, `replay --file`, jq
  recipes) works on match games with no changes.

## Failure semantics

A crashed/stalled/timeout game is a **row, not an abort**: the match
continues with the next seed, the row records the status, and
`match.json` is rewritten after every game (an interrupted match is
readable up to its last completed game). "Zero crashes" is checked by
reading the table, not by the process surviving. A game that throws
before producing a record at all (browser launch failure, config
error) is also a row: status `failed`, error text captured, remaining
games still run.

## Results table (`match-summary.md`)

One row per game:

| game | seed | status | winner | reason | turns | AP | API dec. | forced | fulfilled | retries/fb | tokens in/out/cacheR | est. $ | compactions | max ctx | prev.div. | min |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

All columns except `est. $` read directly from `LLMGameRecord` fields
that already exist (D09/D10 added `compoundFulfilled` and the retry
detail; nothing new is recorded). `min` is wall-clock minutes.

Aggregate block under the table:

- games completed / crashed / stalled (the zero-crashes check, explicit)
- runner win rate over COMPLETED games (with the n it's computed from)
- flatline rate vs decked/AP-loss breakdown (reason histogram)
- means: turns, API decisions, forced, fulfilled, retries per API
  decision, compactions, transcript max
- totals: tokens in/out/cache-read, estimated $ for the match
- preview divergences total (with seq pointers into the offending
  games, carried from each game's record)

No decision-quality metrics — that whole axis stays in Phase 2 per the
D10 scope ruling. This table is accounting, not evaluation.

## Price table (`src/prices.ts`)

```ts
/** $/MTok. AS OF 2026-08-10 — verify against
 *  https://docs.claude.com/en/docs/about-claude/pricing before relying
 *  on the $ column for reporting. */
export const PRICES: { prefix: string; in: number; out: number;
                       cacheRead: number; cacheWrite: number }[] = [
  { prefix: "claude-haiku-4-5",  in: 1.00, out: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  { prefix: "claude-sonnet-5",   in: 2.00, out: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
  // sonnet-5 note: promotional rate through 2026-08-31; standard 3/15
];
```

- Longest-prefix match on the model id. Unknown model (including
  `mock`) → tokens shown, `est. $` dashed — **never guessed**.
- 5-minute cache-write rate (the API default our client uses). If we
  ever switch to 1-hour TTL the constant changes with the client, in
  one place.
- Estimated, and labeled as such in the table header: computed from
  our recorded usage fields, not from the billing console. The as-of
  date prints in the summary footer so a stale table is self-evident.

## Interaction with the acceptance ladder

`run-match --games 3 --model mock --seed 3 --compact-threshold 40000`
becomes a CI-runnable smoke for the batching layer itself (3/3
completed, table produced, $ dashed for mock, aggregates arithmetic
spot-checkable). The existing single-game mock gate is untouched — it
checks the pipeline, this checks the aggregator.

## Acceptance

- Mock match (3 games): 3/3 rows, statuses correct, table renders,
  aggregates match hand-computation, $ dashed.
- Injected-failure behavior: kill one game mid-match (or run a seed
  known to stall under a tiny timeout) → that row shows the status,
  the other games complete, aggregates count only completed games.
- Real match is M5 itself: `run-match --games 10 --seed 1 --model
  claude-haiku-4-5` — the 10-game run IS the first real match.
- Full suite green; no changes to any per-game artifact.

## Non-goals

Parallel execution, cross-match comparison tooling (Phase 2 reads
multiple match.json files; nothing here needs to anticipate it),
per-decision metrics, cost tracking against the real billing API.
