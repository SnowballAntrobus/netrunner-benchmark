# D03 — Auto-resolve single-option decisions

**Status: approved — IMPLEMENTED** (all three questions resolved in
review; results at bottom). · Deferred from the game-1 batch at Dante's
direction ("careful re single-option removal"); rev 2 incorporated the
review discussion (the two kinds of forced decision) and the D05
sequencing that resolved open question 3.

## Rev 2: what D05 changes

Game 1's 601 forced decisions split into two kinds: **584 contentless
confirmations** (the option is literally `{"index": 0}` — response
windows with nothing to decide) and **17 content-bearing spectator
moments** (a single option that DOES something: the forced Overclock
play of #281, single-candidate breach/access resolutions, the Mutual
Favor tutor completing). The care Dante asked for concerned the second
kind.

D05 dissolves the concern for the influenceable subset: the trap-class
forced selects (Overclock) are consequences of a blind verb choice, and
the verb option now carries a `choices` preview — the model sees
"play → [Overclock]" BEFORE committing, at a real decision it keeps.
The remaining spectator moments (single-candidate access/breach) were
never influenceable at any decision; their content reaches the model
through the next real decision's log tail and state, with D01 memory
carrying its reaction forward. Auto-resolving all 601 therefore loses
no information and no agency, and the binary rule stays crisp:
`optionList.length === 1`.

Integration note (from D05): the auto-resolve path must still run the
full option description + preview-divergence check before resolving —
a forced select following a previewed command (play → forced Overclock)
is exactly where a divergence would be most interesting, and the forced
record must carry `preview_divergence` like any other.

## The data (game 1, verified against the records)

- 601 of 768 runner decisions (78%) had exactly ONE legal option —
  response windows, phase-boundary confirms, chained follow-ups with a
  single candidate. They consumed 755K of 983K input tokens (77%): ~$3 of
  the game's ~$4.25.
- 18 of the game's 25 retries occurred ON single-option decisions (the
  model repeatedly stumbles answering a menu with nothing to decide —
  plausibly ordinal/index confusion: "option 1" of a 1-option list).
  Auto-resolve removes that entire retry class; the numeric-string
  coercion (implemented alongside this doc) defends the remainder.
- The confusion notes from Dante's review (#39 discard-phase guess,
  #47/#71 "my turn must be over" confabulations) were all elicited by
  windows that offered nothing to decide.

## Why D01 makes this urgent

Under conversational/full, every forced exchange would enter the
PERMANENT transcript: ~600 exchanges × (~2.5–4K user turn) — the
transcript would be ~78% forced boilerplate, compaction would trigger
~4x sooner, and the model's finite context would be spent remembering
"only one option → proceed" six hundred times. Auto-resolve shrinks a
game's transcript to real decisions (~170/game): compactions drop from
~6–12 to ~1–3, cost drops roughly 3–5x, and the history the model
carries is all signal.

## Proposed mechanism (page layer, llmplayer.js)

In `decide()`: if `optionList.length === 1`, skip the host API round-trip
entirely — resolve 0 after logging a full decision record flagged
`forced: true` (state, options, log_index, reproduction code all captured
as usual; `model`/`reasoning`/token fields null; no API call, no
transcript entry). Host-side: `validateDecisionRecord` accepts
forced records without model fields; `LLMGameRecord` gains
`forcedDecisions`; mock CI asserts `forcedDecisions >= 1`.

Properties:

- **Choice-identical.** Index 0 of a 1-option list is the only possible
  outcome; the game tree is untouched. Determinism, goldens, invariant
  all unaffected (rules-vs-rules games never pass through this path).
- **The model still "sees" everything.** The next real decision's state
  and public log tail narrate whatever happened during forced windows —
  the model loses only the empty question, not the information. `seq`
  stays globally continuous (forced records keep their numbers), so
  decision numbers visibly jump — truthful, and the log tail explains
  the gap.
- **Formatter unchanged.** Forced records with null reasoning already
  collapse into the "· N forced decisions ·" counters in the report view
  and render bare in the full view.
- **Instrumented, not hardcoded.** `--auto-resolve on|off` (proposed
  default: on), recorded in the game record. `off` preserves the game-1
  interface exactly — the comparison arm for whether forced windows
  change model behavior.

## The counter-consideration (why this was deferred for care)

In game 1, some of the best run-phase reasoning surfaced on forced
decisions (the formatter grew boilerplate-aware collapsing precisely
because of this). Removing forced calls removes those thinking
opportunities. Two mitigations: (1) under D01 the model now reasons with
MEMORY — thinking that used to be re-derived on forced windows persists
across real decisions instead of being lost; (2) the `off` arm exists to
measure exactly this effect. Recommendation stands: on by default.

## Open questions — resolved in review

1. Default on — **agreed**.
2. Forced records keep capturing full state — **agreed**.
3. Third mode (auto-resolve only pure "n"-windows, keep content-bearing
   forced selects) — resolved by sequencing D05 first (see "Rev 2"
   above): with verb-level previews in place, the binary rule loses
   nothing; the flag space stays `--auto-resolve on|off`.

## Acceptance — results

- Implementation: the page sets `forced: true` on 1-option requests
  (`&autoresolve=0` disables; `--auto-resolve on|off`, default on); the
  host answers `{option: 0}` itself, writing a full decision record
  (state, options, `preview_divergence`, `forced: true`, model fields
  null) with no API call and no transcript entry. The page-side flow —
  option description, divergence check, preview noting — is identical
  for forced and real decisions.
- Mock game (seed 7): 166 forced vs 49 API decisions (77% forced,
  matching game 1's ratio); transcript peak fell from ~151K to ~75K
  tokens; retry/fallback paths still exercised; zero invalid records;
  double-run: full record sequence and logs byte-identical. Full suite
  green.
- NOTE for cross-run comparisons: the MOCK's game differs from the
  pre-D03 mock game because the mock client's internal LCG advances once
  per API call (fewer calls → different stream). The ENGINE's seeded
  stream is untouched — auto-resolve is choice-identical by
  construction; for a real model the game line is unchanged wherever the
  model would have picked the only option.
- CI: the keyless mock now exercises retry + fallback + forced +
  compaction in one game; the workflow's mock step passes
  `--compact-threshold 40000` because auto-resolve shrinks the
  transcript so much that the production 150K is never crossed keylessly
  (the shrinkage being the point).
- Engine-choice-identity means no real-game smoke is required before
  game 2.
