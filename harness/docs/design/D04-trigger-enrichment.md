# D04 — Enrich the `trigger` command with its actual abilities

**Status: approved — IMPLEMENTED** (ability text verbatim per review;
select step unchanged per review discussion). Verification results at
the bottom. · Game-1 #212: the model wanted Telework
Contract's credits for three turns running and never connected
`trigger` → "use Telework Contract". It may never have used a click
ability all game. The `trigger` option arrives as the bare string
"trigger" with the glossary line "Use a card ability" — the model cannot
see WHICH abilities exist without correlating its rig against decklist
text in the system prompt, a correlation game 1 shows it does not make.

## Parity argument (why this is interface, not help)

A human player sees their installed cards on the board with ability text
printed on them; the engine UI surfaces triggerable abilities as buttons.
The LLM sees `{title: "Telework Contract", counters: {credits: 9}}` — the
title only. Enumerating the abilities behind `trigger` restores parity
with what the engine already shows a human; it recommends nothing and
adds no evaluation. The emergence question ("will it discover click
abilities?") was answered by game 1: without the interface surfacing
them, the question measures the interface, not the model.

## Proposed mechanism (llmplayer.js, describeOption)

When a CommandChoice option is the string `"trigger"`, dry-run the exact
enumeration the engine will perform if the command is chosen —
`currentPhase.Enumerate["trigger"]()` (which is
`ChoicesTriggerableAbilities(player, limitTo)`) — and attach the result:

```jsonc
{ "index": 4, "command": "trigger",
  "description": "Use a card ability",
  "abilities": [
    { "card": { /* cardEntry — PlayerCanLook honesty as everywhere */ },
      "ability": "[click]: Take 3[c] from this resource." }
  ] }
```

**Naming note:** D05 unified this into the general `choices` preview
field (entries `{label, card}` exactly as the real follow-up menu
renders them) — the `abilities` name shipped briefly and appears in no
recorded game.

- Ability text is the card's own `ability.text` (already bracket-notation
  the interface guide defines). No costs computed, no ordering, no
  annotations beyond the engine's own text.
- Cards route through `__harness.cardEntry` (own active cards, plus corp
  cards exposing `runnerAbilities` — active/rezzed, hence visible; the
  choke point enforces it regardless).
- Guarded: wrapped in try/catch; enrichment failure degrades to today's
  bare option, never breaks a decision.

## Engine-read safety (the verification this needs)

`ChoicesTriggerableAbilities` → `ChoicesAbility` → each ability's
card-authored `Enumerate.call(card)`. These are the same functions the
engine itself calls every time it builds a human's command menu, so an
extra call is the same class of read the engine already performs
repeatedly; the globals it touches (`checkedClick`/`checkedAccess`) are
reset per-ability before each use.

**Correction (from D05):** the "a side-effecting Enumerate would be an
engine bug" reasoning was too optimistic, and the double mock-run
comparison alone is INSUFFICIENT — two enrichment-active runs perturb
identically, so on-vs-on passes even when enrichment changes the game.
D05's generalization found a real case: a card Enumerate consuming
seeded RNG in an AI-only branch. The trigger path here happened to be
clean (verified by outcome comparison against the pre-D04 game), and
D05 added a by-construction RNG guard around all dry-runs plus a
baseline-equality acceptance check (enrichment-on vs enrichment-off
games must be byte-identical), which is now the standard.

## Scope

`trigger` only. The identical dry-run mechanism generalizes to
`play`/`install`/`run` follow-up annotation (the #281 misplay guard —
"chose play intending Sure Gamble, got forced into Overclock") — that is
D05, reviewed separately per the one-by-one process.

## Open questions for review

1. Ability text verbatim (proposed) vs card-name-only (leaner, but
   reintroduces the correlate-with-decklist burden)?
2. Should the enrichment also appear on the SELECT decision that follows
   (the ability-choice menu)? Its options already carry label = ability
   text and the card object, so proposal: no change needed there.

## Acceptance — results

- Typecheck, determinism, golden (10/10), invariant (17,032 checks, zero
  leaks), audit: all green.
- Double mock-run comparison: game logs byte-identical AND the full JSONL
  record sequence (1,106 records incl. compactions) identical across two
  runs with enrichment active on every decision → the Enumerate.trigger
  dry-run is side-effect-free in practice, not just by code reading.
- Spot-check: 70 enriched trigger options in the mock game; e.g.
  `{"command":"trigger","abilities":[{"card":{"title":"Regolith Mining
  License",...,"counters":{"credits":15}},"ability":"Take 3[c] from this
  asset."}]}` — cardEntries honest (corp-record example shown from the
  corp's own view, host-side only, as ever).
- Mock game outcome unchanged vs pre-D04 (same winner/decision
  count/compactions/retries/fallbacks).

## Implementation notes

- One SIDE FIX surfaced by the double-run comparison: JSONL appends from
  concurrent bridge calls raced `appendFile`, landing adjacent corp
  records in nondeterministic file order (pre-existing, benign — tools
  anchor by seq/log_index — but it made record-level determinism checks
  noisy). Appends are now serialized through a promise chain in
  llmgame.ts; record order in the file is deterministic.
- INTERFACE_GUIDE gained a factual clause: `"trigger" = use a card
  ability (this option carries an "abilities" list showing each
  triggerable ability and its card)` — interface disclosure, recorded in
  the saved system prompt like every authored word.
