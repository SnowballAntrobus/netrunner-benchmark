---
name: netrunner-game-audit
description: Qualitative rules-conformance audit of a netrunner-benchmark game. Use when asked to audit a game, review a game log or decision log for rules correctness, spot-check the engine, or generate a game audit report. Requires the netrunner-benchmark repo folder connected.
---

# Netrunner game audit (judge tier two)

You are auditing one recorded game from the netrunner-benchmark harness
for rules conformance — a qualitative complement to the deterministic
conservation auditor (`npm run audit`, judge tier one). Your output is a
written report; you spend no game-API credit.

## Inputs

- A game record: `harness/out/<game_id>.json` (or a golden fixture
  `harness/fixtures/golden/g*.json`). Contains the full log.
- For LLM games, the decision log `harness/out/<game_id>.jsonl` — one
  record per decision, both seats; Runner records carry the exact state
  the model saw and a `reproduction_code` for replaying the position.
- Rules ground truth, in order of authority for rulings:
  1. `harness/rules/comprehensive-rules.txt` — the pinned NSG
     Comprehensive Rules snapshot (fetched by `npm run fetch-rules`).
     Cite rule numbers (e.g. "CR 10.4.x") in every finding.
  2. `harness/rules/learn-to-play-*.txt` and `run-guide.txt` — what the
     LLM player was actually shown; use these to judge whether the MODEL
     had the information, distinct from what the RULES require.
  If the comprehensive-rules snapshot is missing, ask the user to run
  `npm run fetch-rules` (fallback: https://rules.nullsignal.games/, and
  note in the report that an unpinned source was used).

## Procedure

1. **Tier one first.** If shell access is available, run
   `npm run audit -- --file <game.json>` in `harness/` and include its
   verdict. If it fails, that finding leads the report.
2. **Sample windows.** From the log, select: the first two turns (setup,
   mulligans, opening economy); two mid-game turns that contain runs; every
   sequence involving damage, traces, tags, or agenda scoring/stealing; and
   the final turn. For each window, quote the log lines audited (with line
   numbers).
3. **Check each window against the rules text.** Non-exhaustive checklist:
   - Turn structure: mandatory Corp draw; click counts (Corp 3 / Runner 4
     plus stated modifiers); discard to maximum hand size at turn end.
   - Runs: ice approached outermost-first; rez window before each
     encounter; unbroken subroutines fire in printed order; "End the run"
     actually ends it; jack-out timing (not before the first ice).
   - Breach/access: correct access counts per server (R&D top card(s), HQ
     random, Archives all), including multi-access modifiers; agendas
     stolen on access; trash costs paid correctly; ambush/on-access
     abilities resolving as printed.
   - Costs: install/play/rez/advance costs match printed values plus
     stated modifiers; abilities' costs paid before effects.
   - Damage/tags: correct count discarded at random; flatline only when
     damage exceeds cards in grip; tag consequences only while tagged.
4. **For LLM games, audit the interface too.** For 3–5 Runner decision
   records: does the serialized state match the log context? Do the
   options offered correspond to legal actions in that state? Did the
   executed choice (`choice` index) match what the following log lines
   show happening? Flag any state/log inconsistency — that is a harness
   bug, distinct from an engine bug.
5. **Classify findings.** For each: severity (`engine-bug` /
   `harness-bug` / `rules-ambiguity` / `cosmetic`), the log line numbers,
   the Comprehensive Rules citation (rule number from the pinned
   snapshot), and
   the `reproduction_code` of the nearest decision record so the position
   can be replayed. Be conservative: before claiming an engine bug from
   one ambiguous line, check whether the same pattern appears in the
   golden fixtures corpus (it usually reveals intended behavior).

## Report

Write `harness/audits/<game_id>-report.md` containing: a one-paragraph
verdict (including tier-one result); the windows audited with line
ranges; a findings table (or "no findings" per window); and a short
"coverage honestly stated" note listing what was NOT audited. Offer the
report for review — do not commit it yourself unless asked.

## Cautions

- Corp decision records legitimately contain Corp-private information;
  fine for offline audit, never for pasting into a live game's context.
- The engine's known vernacular ("n" = continue, SPOILER lines as
  omniscient debug output) is documented in `harness/docs/` — read
  DECISION_LOG.md before your first audit.
- Absence of findings in sampled windows is evidence, not proof; say so.
