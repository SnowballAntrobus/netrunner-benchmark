# D06 §1 rev 2 — The corpus: durable data, progressive report, then batching

**Status: §§1–3 implemented** (nested run folders per the review
amendment — `out/<game_id>/` with canonical names, `src/paths.ts`
resolving both layouts, all tools accepting folders; `corpus
--promote/--report` + `src/prices.ts` live; first CORPUS.md generated
from the three era-3 games. §4 run-match remains to build, as the D12
vehicle.) · Original scope
(match runner first) inverted by Dante's directive: every run costs
money, so analysis must be CUMULATIVE over everything already in
`out/`, with the data itself versioned on GitHub and a report that
updates as games accumulate — and that names the holes where the next
dollar should go. The match runner (§4) survives as the M5 vehicle but
builds on the corpus machinery instead of preceding it.

## §1 The era taxonomy (what is comparable to what)

Games are comparable only within an interface era. The corpus so far:

| era | stack | games | disposition |
|---|---|---|---|
| 0 | stateless, pre-D01, schema-degraded records (stringify override) | game 1 (`…026568900`), old mock (`…026098553`) | **archive** — historically reviewed (GAME1_REVIEW), not comparable, schema broken |
| 1 | conversational + D02–D07, split actions | game 2 (`…391370459`) | keep — the split-arm reference game |
| 2 | compound D09-1 | games 3–4 (haiku), sonnet ×2, opus 1, killed sonnet run (jsonl only) | keep — reviewed era; killed run kept for the thrash/12-turn evidence |
| 3 | **compound D09-2 (current)** | haiku (`…421853374`), sonnet (`…421978797`), opus 2 (`…422381592`) | the growing comparable corpus — all new runs land here until the next interface change |

"Archive" = moved out of the corpus dirs (kept in `_to_delete/` for
Dante's final call), never silently deleted. The era of a game is
DERIVED from its record fields (presence of `record_type`,
`compound`, `order_folded`, `actions`, `contextMode`) — no manual
tagging, so the report can never mislabel a run.

## §2 Data on GitHub — and one folder per run (review amendment)

Every run's artifacts live in ONE nested folder, in both scratch and
corpus (Dante's amendment: `out/` was becoming an unmanageable flat
pile of stems):

```
harness/out/<game_id>/           # scratch (gitignored)
  record.json                    # game record
  decisions.jsonl                # decision log
  debrief.json                   # when present
  system-prompt.txt
  full.md                        # regenerable narrative

harness/data/
  games/<game_id>/               # tracked corpus — CURRENT ERA ONLY,
    record.json ...              #   INCLUDING full.md (review amendment:
                                 #   the narrative rides with the data;
                                 #   promote regenerates it)
  CORPUS.md                      # the progressive report (§3)

harness/local/games/<game_id>/  # gitignored — prior-era games parked
                                 #   for the eventual research write-up;
                                 #   NOT in the corpus or CORPUS.md
                                 #   (review amendment: prior eras were
                                 #   bloating both)
```

Inside a folder the names are canonical (`record.json`, not
`<game_id>.json`) — the folder carries the identity. Tools accept
either the folder or its `record.json`, and sibling resolution
(decisions/debrief lookup in format, replay, watch) is folder-based.
**Flat-layout tolerance**: existing flat games in `out/` keep working
(stem-sibling fallback), and `corpus --promote` NORMALIZES a flat
game into the nested shape on its way into `data/` — promotion is the
migration.

- `harness/out/` stays scratch (gitignored); `harness/data/` is
  tracked. Total current corpus ≈ 25MB of JSONL — plain git, no LFS.
- Promotion is explicit: `npx tsx src/cli.ts corpus --promote
  out/<game>.json` copies the game's artifact set into `data/games/`
  (refusing incomplete sets unless `--partial`, for the killed-run
  class) and regenerates CORPUS.md. Nothing lands in the corpus as a
  side effect of running a game — a bad run never pollutes the data.
- full.md narratives are NOT promoted (regenerable from the data:
  `format --file data/games/<id>.json`). The abbreviated report.md
  view is retired entirely (removed from format.ts — review practice
  settled on full.md + the replay viewer).

## §3 The progressive report — `corpus --report` → `data/CORPUS.md`

Regenerated from `data/games/*` on every promote (or standalone).
Committed with the data, so its history IS the benchmark's history.

1. **Current-era results table** — one row per era-3 game: model,
   seed, config knobs, outcome (winner/reason/AP/turns), decision
   split (API/forced/fulfilled/folded), incidents (retries, fallbacks,
   invalid, divergences, suppressed/truncated compactions, large
   menus), est. $ (prices.ts), duration.
2. **Per-model aggregates** (era 3 only): games, runner win rate with
   n, flatline rate, mean turns survived, mean API decisions, mean $.
   With n this small the table prints n everywhere and no standard
   errors — honesty over dressing.
3. **Prior-era appendix**: same table per era, collapsed, labeled
   non-comparable.
4. **Machinery health rollup**: any nonzero incident anywhere in the
   corpus, linked by game id + seq.
5. **Coverage holes** — the "where should the next dollar go" section,
   computed, not curated: the model × seed matrix (today: everything
   is seed 7); arms with zero current-era games (split, stateless,
   lean history); per-cell n < 3 for any variance claim; models with
   no long-horizon game (compaction never exercised); decks (single
   matchup so far); missing debriefs.
6. **Compaction-summary appendix**: each game's summaries quoted —
   the strategy-memo record.

## §4 `run-match` (unchanged semantics, demoted to follow the corpus)

As previously designed — N sequential seeds, one config, crash = row
not abort, `--label`, watch refused — with one change: on completion
each game is OFFERED for promotion (`--promote-all` flag) rather than
auto-promoted. The M5 10-game run (D12) uses this. The
system-prompt-cache observation stands: back-to-back same-config games
reuse the system-prompt cache entry within the 5-minute TTL
(~$0.19/game at opus rates, free from sequential design).

## Pricing

`src/prices.ts` as designed (as-of dated, longest-prefix, dashes for
unknown). For OpenRouter models (D13) the report prefers the
PROVIDER-REPORTED per-call cost recorded in the game record over any
local table.

## Acceptance

- `corpus --promote` on the three era-3 games + `--report`: CORPUS.md
  renders all six sections; era derivation matches the table above;
  totals reconcile with the game records; holes section flags at
  minimum: single seed, no split/stateless era-3 arms, n=1 per model.
- Promote refuses a half-missing artifact set without `--partial`.
- Repo: `out/` gitignored, `data/` tracked, CORPUS.md committed.
- Existing tools (format, audit, replay) work unchanged against
  `data/games/` paths.

## Non-goals

Decision-quality metrics (Phase 2), cross-era statistical comparison,
auto-promotion, dashboards (CORPUS.md is markdown in the repo; a D08
graphical analog can come later if reviewing outgrows it).
