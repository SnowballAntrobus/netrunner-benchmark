# D05 — Command options preview their follow-up choices

**Status: approved — IMPLEMENTED** (unified `choices` field per review;
divergence surfacing per Dante's requirement; one significant safety
find during implementation — see "Engine-read safety", rewritten with
what actually happened). · The #281 guard, generalizing D04's
mechanism; sequenced BEFORE D03 per review discussion — once verb
options show what they lead to, auto-resolving forced follow-ups is
lossless (everything a forced select would have shown was visible at the
verb step).

## The failure this fixes (game-1 #281)

The model chose `play` intending Sure Gamble, but the follow-up select
offered only the affordable events — Overclock — and the model was
railroaded into an unintended run ("committed to this run now"). The
two-layer verb→subject protocol makes the verb choice a commitment made
blind: the model cannot see the engine's legality/affordability
filtering until it has already spent the choice. Dante's review also
flagged (#219) that decomposition can CHANGE decisions — so the fix is
to inform the verb choice, not to fuse the layers (fusing is a bigger
interface change, parked).

## Proposed mechanism (llmplayer.js, generalizing D04)

For every CommandChoice string option, if `currentPhase.Enumerate[cmd]`
exists, dry-run it — the exact call the engine makes if the command is
chosen — and attach the resulting choices as a preview, each entry
described by the SAME `describeOption` used for real select menus
(minus the index), so the preview and the eventual follow-up menu are
rendered identically:

```jsonc
{"index": 3, "command": "play", "description": "[click]: Play an event",
 "choices": [
   {"label": "Overclock", "card": {"title": "Overclock", "cardType": "event", ...}},
   {"label": "Creative Commission", "card": {"title": "Creative Commission", ...}}]},
{"index": 4, "command": "run", "description": "[click]: Make a run",
 "choices": [
   {"label": "HQ", "server": "HQ"}, {"label": "R&D", "server": "R&D"},
   {"label": "Archives", "server": "Archives"}, {"label": "Remote 1", "server": "Remote 1"}]}
```

- **Content-only rule**: commands whose enumeration returns bare `[{}]`
  (gain, draw, remove — no subject to choose) get NO preview; nothing is
  attached. This falls out mechanically — an empty described entry
  carries no fields — so there is no per-command list to maintain, and
  the rule "every command shows the choices it leads to, when there are
  any" is uniform.
- **Unify with D04**: trigger's `abilities` field becomes the same
  `choices` field (entries carry `card` + `label` = ability text, as the
  real trigger select does). No recorded game uses the `abilities` name
  yet, so renaming now costs nothing and leaves ONE uniform annotation
  in the schema. The interface-guide sentence generalizes to: command
  options may carry a `choices` list previewing the follow-up menu.
  Reviewer's call if keeping `abilities` separate is preferred.
- **Preview, not promise**: the preview is computed at command-decision
  time; in rare cases the eventual menu could differ (a response window
  between the two steps changing affordability). The actual select
  decision remains authoritative; the doc's phrasing in the interface
  guide says "previews".
- Guarded try/catch per command, as in D04: enrichment failure degrades
  to the bare option.

## Parity argument

Same as D04: the engine UI shows a human which cards light up as
playable/installable and which servers are runnable; the LLM currently
reconstructs affordability from grip + credits + decklist costs — #281
shows it fails at exactly that reconstruction. The preview surfaces the
engine's own legality computation, recommends nothing, and orders
nothing (engine enumeration order preserved).

## Cost note

Action-phase command menus grow by the preview entries (~0–8 cards +
3–5 servers ≈ 100–500 tokens on action-phase decisions only). Under
conversational/full these persist in the transcript; still small
against the forced-window spam D03 then removes.

## Engine-read safety — what actually happened (important)

The design's original claim ("same read-only menu builders the engine
calls for human play") turned out to be WRONG in one specific way, and
the D04-style double-run check could not have caught it: running
enrichment twice produces two identically-perturbed games, so on-vs-on
comparison passes even when enrichment changes the game. The first
mock run with play-enumeration active produced a DIFFERENT game than
the no-enrichment baseline (663 vs 1100 decisions).

Root cause (found by command bisect + RNG stack instrumentation):
card-authored `Enumerate` implementations may contain AI-only branches
that consume seeded randomness — concretely, the fast-advance operation
(set 30040) `Shuffle`s its advance-target list when `corp.AI != null`
("make the advance target unpredictable"). Three such draws shifted the
seeded stream and changed which card an HQ access hit. D04's
trigger-only path happened to be clean; the general mechanism is not
guaranteed to be.

Fix (by construction, not by card audit): during a dry-run,
`Math.random` is swapped for a local fixed-seed LCG and restored in a
`finally` — the seeded game stream is untouched no matter what card
code does, and previews stay run-to-run deterministic. Preview CONTENT
is unaffected (the shuffle only ordered a card's internal target list,
which the phase-level preview discards).

Strengthened acceptance, now the standard for any engine-touching
enrichment: (1) **baseline equality** — the mock game with enrichment
active must be byte-identical (normalized log) to the no-enrichment
baseline game; (2) double-run record-level byte comparison; (3) full
suite. The D04 doc's weaker verification claim is corrected in place.

## Divergence surfacing (per review)

Every followed preview is compared against the actual follow-up menu at
the page layer (`previewChecks` counts comparisons): on mismatch the
select's decision record carries
`preview_divergence: {command, previewed_at_seq, preview}` — the model
is never shown the marker (it sees the authoritative actual menu). The
game record carries `previewChecks`/`previewDivergences`, the CLI
prints them with an inspect pointer, and the formatter renders a ⚠️
line in BOTH views (divergent selects are never collapsed into the
forced-decision counter). The divergent branch has not yet fired in any
mock game (87/87 previews matched); it is a straight stringify
comparison, flagged for first-fire inspection in real games.

## Acceptance — results

- Baseline equality: enrichment-active mock game byte-identical
  (normalized) to the no-enrichment baseline — same 1100 decisions,
  17c/16r turns, winner, retries/fallbacks/compactions.
- Double run: full 1,106-record JSONL sequence identical.
- Typecheck, determinism, golden 10/10, invariant (17,032 checks, zero
  leaks), audit: green.
- Spot-checks: `play`/`install`/`run`/`trigger` previews present with
  honest cardEntries; 87 previews followed, 0 divergences.

## Noted, out of scope

The engine exposes `Cancel.run` (a back-out for the run command) —
the remedy ladder's step (b) from the game-1 review. Surfacing cancels
is its own design conversation; not touched here.

## Open questions for review

1. Unify D04's `abilities` into the uniform `choices` field (proposed) —
   or keep trigger's annotation separately named?
2. Any command to EXCLUDE from previews? (Proposal: none — uniform rule,
   content-only filter handles the subjectless commands mechanically.)

## Acceptance (after approval)

Typecheck; full suite; double mock-run byte-comparison; spot-check mock
records show `choices` previews on play/install/run/trigger with honest
cardEntries; mock outcome unchanged. Then D03 proceeds on top.
