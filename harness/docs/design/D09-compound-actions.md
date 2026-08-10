# D09 — Compound action menus (fusing verb + subject)

**Status: implemented** (all three open questions resolved yes:
compound default with `--actions split` arm, discard-phase selects
folded in, trigger fusion included) · From Dante's game-2 notes (#41/#42,
#45/#46, #49/#50, #112–#114): the two-layer verb→subject protocol makes
the model state its intent at the verb step and then repeat it at the
select step — ceremony, cost, and (game 1 #281) occasionally a trap.
With D05 previews the verb menu already CONTAINS the subjects, so the
fusion is finally safe to build.

## Game-2 numbers (measured)

78 API decisions = 53 command + 25 select. 19 of the 25 selects are the
fusable class (a non-forced select immediately following a non-forced
command) — ~24% of API calls eliminated. Fused menus stay small: mean
5.9 options, max 12 across game 2's 53 command menus. The 6 remaining
selects are deeper-chain or standalone decisions that STAY real (see
below).

## Mechanism (page layer; engine untouched)

The engine keeps its two-step protocol; the PAGE fuses the model's view:

1. At a CommandChoice, subject-taking options are EXPANDED using the
   D05 preview enumeration: `[gain, draw, install → Telework Contract,
   install → Conduit, play → Sure Gamble, run → HQ, run → R&D, ...]`.
   Each fused entry carries the command plus the full preview entry
   (card/server/ability — same describeOption rendering as ever).
2. The model picks ONE fused option. llmplayer answers the engine's
   CommandChoice with the verb, remembers the chosen subject, and when
   the engine's follow-up SelectChoice arrives, answers it WITHOUT an
   API call by matching the remembered subject against the actual menu
   (same equality the divergence checker uses).
3. **Mismatch = the D05 divergence case**: if the remembered subject
   isn't in the actual menu (or matches ambiguously), the select is
   asked FOR REAL — a normal API decision — and flagged
   `preview_divergence`. The fallback is the current behavior, so the
   fusion can never wedge a game.

Only the FIRST select after the verb is fused. Deeper chain steps —
the #112–#114 duplicate-install + MU-trash chain's "which program do
you trash?" — are genuine decisions and remain real API calls (that
chain is the design's acceptance test case: the fused step is
"install → DZMZ Optimizer", the trash choice stays with the model).

## Records (comparability preserved)

Both engine decisions are still recorded at their seqs: the command
record carries the model fields plus the FUSED menu it actually saw
(`compound: true`, options = fused entries, choice = fused index); the
auto-answered select is recorded like a forced record
(`compound_fulfilled: true`, no model fields, no transcript entry).
`llmDecisions` counts real API calls as always; the game record gains
`compoundFulfilled`. Formatter renders the fused decision once and
collapses the fulfillment step.

## Flag and default

`--actions compound|split`. Given the game-1 #219 evidence that
decomposition CHANGES decisions, this is an experimental variable:
proposal is **compound as default** (Dante's cost lean; the interface
argument — intent is stated once, where the information is) with
`split` as the preserved comparison arm, mirroring the auto-resolve
pattern. Reviewer's call.

## Interface guide change

The decision-types paragraph gains one sentence: command options that
carry a subject are complete actions ("install → X" installs X);
follow-up selects appear only for further choices (hosting, trashing
for memory, etc.). Neutral, factual, versioned as ever.

## Acceptance

Typecheck; mock double-run byte-identity; baseline check vs split mode
is NOT applicable (compound changes which decisions the model faces —
that is the point; the engine's own stream must still be untouched:
rules-vs-rules suites green); mock game: compoundFulfilled > 0, the
#112-class chain exercised (a fused install followed by a real select);
game-2 records untouched (schema is additive).

## Open questions (resolved)

1. Compound as default — agreed, with split as the arm?  **Yes.**
2. Subjectless verbs in the same menu (gain/draw) render as today —
   any desire to also fold the discard-phase select? (Proposal: yes —
   discard previews exist and it is the same shape.)  **Yes.**
3. Trigger abilities: fused the same way ("trigger → Take 3[c] from
   Telework Contract") — agreed?  **Yes.**

## Verification (implemented)

- Typecheck clean; golden 10/10; invariant 17,032 serializations zero
  leaks; conservation audit green — the engine's own stream untouched.
- Mock (seed 5, threshold 40K): PASS. 752 decisions, 67 API / 296
  forced / **25 fulfilled**, previews followed 64 / diverged 0,
  46 compactions, retry forensics both patterns present. Double run
  byte-identical after normalizing game_id/latency. Split-mode arm
  (`--actions split`) also PASS on the same seed.
- The #112-class chain confirmed in records: seq 107 fused command
  chose "play Jailbreak" → seq 108 select fulfilled silently
  (`compound_fulfilled`, no API call) → seq 109 the *server* choice
  arrived as a REAL 2-option select answered by the model. Deeper
  chains degrade gracefully exactly as designed.
- Fused entry shape in records: subjectless verbs stay `{command,
  description}`; fused entries carry `command + description` plus the
  full subject fields (`label`, `card`/`server`), so the model sees
  e.g. "play — Play an event / Mutual Favor" as one numbered entry.
- Formatter: fused entries render as "run Archives", "play Jailbreak"
  (subject appended to verb); fulfillment records collapse in report
  view, badge `compound-fulfilled` in full view.

## Seed note (CI change required)

Under compound the mock's seeded choices shift, and seed 7's game now
ends in a turn-2 flatline (155 decisions, 15 API calls, transcript
peaking 44K just past the threshold with no later API call) — so the
compaction clause of the acceptance gate cannot fire. This is the mock
being unlucky, not a defect: seeds 3/5/11/13/21 all PASS. The CI mock
step moves to **seed 5**, the richest probe (752 decisions, corp wins
by agenda points — a different terminal condition than the flatline
seeds — 46 compactions, 25 fulfillments).
