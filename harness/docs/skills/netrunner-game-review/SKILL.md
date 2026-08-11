---
name: netrunner-game-review
description: Behavioral/strategic review of a netrunner-benchmark game run — machinery health, gameplay analysis, ground-truth verification of the model's claims, and adjudication of human review notes. Use when asked to review a run, analyze a game, take a look at the latest run, check whether a run is healthy, or adjudicate manual notes on a game report. Distinct from netrunner-game-audit (rules conformance). Requires the netrunner-benchmark repo folder connected.
---

# Netrunner game review (behavioral analysis)

You are reviewing one recorded game from the netrunner-benchmark
harness for what it says about the MODEL — decision quality, epistemic
honesty, failure patterns — and about the HARNESS — whether every
instrument behaved. Rules conformance is the sibling skill
(`netrunner-game-audit`); do not duplicate it.

## Calibrate first (mandatory)

Before writing anything, read the accumulated exemplars — the review
corpus grows and your output must extend it, not reset it:

- `harness/docs/GAME1_REVIEW.md`, `GAME2_REVIEW.md`,
  `OPUS_GAME_REVIEW.md`, and any newer `*_REVIEW.md`
- any human notes files the user provides or that sit alongside a
  report (`*Notes.md`) — these are the ground truth for what the
  human reviewer cares about and for the expected adjudication style
- `harness/docs/DECISION_LOG.md` — the record schema and its
  documented traps (seq gaps, mock quirks, game-1 degradation)

Match the established voice: claims verified against records, wrong
notes respectfully corrected with evidence, findings classified, and a
"queue deltas" section at the end.

## Inputs

- `harness/out/<game_id>.json` — game record (counters, usage, full log)
- `harness/out/<game_id>.jsonl` — per-decision records, both seats
- `harness/out/<game_id>-debrief.json` — postgame self-report (v2+:
  `final_events` catch-up + verdict)
- optionally: the human's manual notes on the formatted report

## Pass 1 — machinery health (always, before any gameplay analysis)

Read the game record and check every instrument. A finding here
outranks any gameplay observation.

- `status`, `errors[]`, `invalidRecords` — anything nonzero/nonempty
  is a lead
- retries and fallbacks: pull `failed_attempts` from the JSONL and
  CLASSIFY each (`unparseable` / `missing-option` / `out-of-range`).
  Known signature: haiku leaks `</invoke>` pseudo-XML after an
  otherwise-complete JSON — a model quirk, not a harness bug; count it,
  don't re-diagnose it
- compaction health: `compactions`, `compactionsSuppressed` (>0 =
  threshold below viable floor — config error), any
  `summary_truncated` compaction records; read the summaries — they
  are the model's strategy memos and often the best analysis material
- compound machinery: `compoundFulfilled`, `orderFolded`,
  `largeFusedMenus` (>0: inspect those menus), `previewDivergences`
  (>0: pull and adjudicate each — they are rare by design)
- cost: compute from `usage` at current per-MTok prices (check
  `src/prices.ts` if present; note cache read/write dominance)

## Pass 2 — outcome and trajectory

- Result line: winner, reason, AP, turns, decisions (API/forced/
  fulfilled/folded split)
- Terminal analysis: last log lines; for flatlines do the damage
  arithmetic explicitly (grip vs damage, advancement counters) and
  check what the model's final reasoning believed at commitment time
- Same-seed comparison: place this game against every prior run at
  the same seed (the corpus so far is seed-7-heavy; the advanced
  Urtica in Remote 0 is the standing discriminator — who reads the
  trap, who repeats it)

## Pass 3 — ground-truth verification techniques

The records allow adjudication most benchmarks can't do. Use these:

- **What did the model know?** The `state` on that very record —
  hidden info shows as `{"hidden":true}` (counters on hidden entries
  are public and visible). Never infer knowledge; read it.
- **What was actually true?** `SPOILER:` lines in the game record's
  full log give corp hand/credits at each runner turn start. Align by
  turn number, not log_index (indices differ between captured and
  recorded logs).
- **Probability-claim audits**: when the model states odds ("~20%
  shot at the winning agenda"), check the SPOILER ground truth —
  distinguish a defensible blind prior from confabulated knowledge,
  and say which it was.
- **Access surfacing**: after a forced/folded access, confirm the
  "X accessed" line arrived in the NEXT API decision's `state.log`
  tail — then check whether later reasoning ever USED it. "Available
  but unused" is a model finding; "never delivered" is a harness bug
  (30-line tail scroll — check gap length before claiming it).
- **Reasoning at the hinge**: for every pivotal decision, quote the
  actual `reasoning` field, not a paraphrase.

## Findings taxonomy (check each; extend when the corpus grows)

- Ambush/risk arithmetic: does reasoning compute damage-vs-grip
  before committing? ("unrezzed ice = safe" is the recurring fallacy)
- In-context learning: does behavior change after evidence within the
  game? (cite the seq arc, e.g. opus #197→#199→#298→#347)
- Access memory: does the model condition on what it has already seen
  in HQ/R&D/Archives, or re-run blind priors?
- Blind-prior-as-knowledge: stated probabilities without basis
- Rulebook/decklist reliance: reasoning that names matchup-specific
  guidance (generalization risk — flag, don't judge)
- Interface friction: debrief Q5 answers — translate each into either
  a design-queue candidate or an explicit "decline: this is judgment
  the benchmark measures"
- Terminal epistemics: does the debrief's account match ground truth
  (v2+ should; discrepancies are findings)

## jq recipes

```sh
J=harness/out/<game>.jsonl
jq -c 'select(.model != null) | {seq, turn, r: .reasoning}' $J   # every real decision
jq -c 'select(.retries > 0) | {seq, failed_attempts}' $J          # retry forensics
jq -c 'select(.record_type=="compaction") | {id: .compaction_id, dropped: .dropped_turns, summary}' $J
jq -c 'select(.compound==true) | .options[.choice]' $J            # what fused entries were chosen
jq -c 'select(.order_folded==true) | {seq, opts: [.options[].label]}' $J
jq -r 'select(.seq==N) | .state.log[]' $J                         # exactly what seq N saw
jq -r '.log[]' harness/out/<game>.json | grep "SPOILER: Corp has" # hidden-hand ground truth
```

## Output

A review doc in the corpus style (`harness/docs/<GAME>_REVIEW.md`
naming when asked to produce a file; otherwise structured chat):
machinery health first, adjudications with evidence, same-seed
comparison table when useful, then **queue deltas** — every finding
lands as either a design candidate, a Phase-2 parked item, a
documentation note, or an explicit no-action with reason. When
adjudicating human notes, address every note by its anchor (#seq),
and never soften a correction: ground truth wins, whoever wrote the
note.
