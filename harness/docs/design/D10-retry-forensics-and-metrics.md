# D10 — Retry forensics

**Status: approved — IMPLEMENTED** (results: mock CI now asserts the
transient-bad decision records one `out-of-range` failed attempt and the
persistent-garbage decision three `unparseable` attempts — both verified;
double-run record identity holds; suites green; game-3 records will
carry `failed_attempts` wherever retries occur, closing the `</invoke>`
question with data.) · Original rev-2 header:
**(rev 2 — descoped per review)** · Rev 1
bundled a decision-metrics command (state-echo fidelity, decklist
reference rate, breaker discipline, debrief fidelity). Dante's call:
that is ANALYSIS tooling beyond the Phase-1 harness mandate, and scope
does not grow while Phase-1 items are open. Deferred to the Phase-2
notes below — losing nothing, since the calibration data (games 1–2
records + Dante's hand reviews) is durable. This design is now Part A
only: close the retry mystery with data instead of hypotheses.

## The change — record failed retry attempts

Game 2: 28 retries, all on substantive decisions, best hypothesis the
`</invoke>` tool-syntax leak — unverifiable because only the ACCEPTED
attempt's raw is recorded. Change:

- `BridgeResult` gains `attempts: [{raw, problem}]` for FAILED attempts
  (problem ∈ `unparseable` / `missing-option` / `out-of-range`;
  the accepted attempt stays in `raw_response` as today).
- `DecisionRecord` gains `failed_attempts` (null when none — the
  overwhelming majority; game-1/2 records remain valid, readers
  tolerant as ever).
- Mock CI: the injected transient-bad decision must now carry ONE
  failed attempt with `out-of-range`; the injected persistent-garbage
  decision three with `unparseable`/`missing-option`.

Also noted in the review: a retry's corrective message may act as an
accidental "think again" on exactly the hardest decisions — a confound.
Understanding the cause (this instrument) precedes any mitigation;
no behavior change in this design.

## Deferred (post-Phase-1): decision metrics

The rev-1 Part B — a `metrics` command computing state-echo fidelity,
decklist-reference rate, breaker-type discipline, and debrief fidelity
from existing records — moves to the Phase-2 queue. Design content
preserved in git history; validation plan unchanged when revived:
calibrate against the two hand-reviewed games (the metric must find
#264/#433, score game-2 decklist references 0, and NOT count #190's
"would exceed capacity" as a state echo).

## Acceptance

Typecheck; mock CI extended (transient-bad decision carries one failed
attempt with `out-of-range`; persistent-garbage carries its
`unparseable`/`missing-option` attempts); double-run byte-identity;
suites green.
