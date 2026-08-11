# D11 — Audit-tooling selftest (do the checkers actually check?)

**Status: awaiting review** · From Dante's observation before game 3:
the audit tools themselves have never been reviewed against a test.
Every checker in the harness has only ever run on games we believed
were good — and a checker that silently passes everything produces
output indistinguishable from a working one. One planted-leak test was
already run ad hoc during D02 (it caught the invariant checker sharing
a predicate with the filter it audits — a tautology fixed at the time,
and the reason serializer.js now carries independent
`PRIVATE_LOG_PATTERNS`). D11 turns that one-off into a permanent,
CI-runnable discipline: **fault injection — every checker must catch a
planted defect of every class it claims to detect, and must stay quiet
on the clean original.**

## Principles

1. **Injections corrupt copies of artifacts, never checkers.** A
   checker is validated against doctored *inputs* (an in-memory log
   copy, a synthetic record, a planted state field). No checker gains
   a test mode that changes its detection path — the code path
   exercised by the selftest is byte-for-byte the code path production
   runs. (The one exception, the page-side plant, corrupts the
   *serializer output* before the checker reads it — the checker still
   runs unmodified.)
2. **Every mutation must be caught AND localized.** Detection alone is
   weak — the assertion includes that the reported line/seq/title
   points at the planted defect, not merely that "issues > 0".
3. **Clean baseline first.** Each suite first runs its checker on the
   unmutated input and asserts a pass — a selftest that never sees the
   clean input can't distinguish "catches the plant" from "fails
   everything".

## CLI

```sh
tsx src/cli.ts selftest            # all suites
tsx src/cli.ts selftest --suite audit|validator|invariant|golden
```

Exit 0 iff every suite passes. Output: one line per mutation class —
`planted <class> → caught at <location>: OK` — reviewable directly.

## Suites and mutation classes

### 1. Conservation audit (`auditGameLog` — pure function, in-process)

Input: a golden fixture's log (already on disk, deterministic). Clean
pass asserted, then each mutation applied to a fresh copy:

| class | mutation | must report |
|---|---|---|
| credit-drift | "gains N credits" line: N → N+1 | checkpoint mismatch at that line's checkpoint |
| swallowed-spend | delete one "spent one click" line | click count mismatch for that turn |
| checkpoint-lie | "(N credits)" checkpoint: N → N−1 | mismatch at exactly that line |
| phantom-line | insert a spend line the checkpoints contradict | mismatch localized to the insertion region |

### 2. Record validator (`validateDecisionRecord` — pure, in-process)

Start from a real record out of a mock game's JSONL (not a hand-built
fixture — schema drift in the source would silently weaken hand-built
ones). Clean pass asserted, then one field broken per class:

| class | mutation |
|---|---|
| bad-choice | `choice = options.length` (off the end) |
| empty-menu | `options = []` |
| silent-model | `model = null` on a non-forced, non-fulfilled runner record |
| stateless-runner | `state = null` on a runner record |
| fat-forced | `forced: true` with a 2-option menu |
| bad-seat / bad-type | `seat: "observer"`, `decision_type: "hover"` |

Each must produce ≥1 problem naming the broken field, and ONLY
problems about the broken field (no collateral noise — that would mean
the clean-baseline record wasn't actually clean).

### 3. No-cheating invariant (page-side, planted leak end-to-end)

The checker lives in serializer.js and runs inside live games — the
selftest validates the deployed path, not an extraction of it. New
URL param `&plant=<class>` (harness page layer, engine untouched)
corrupts the serialized state AFTER the serializer builds it and
BEFORE `checkViewer` scans it:

| class | plant | must fire |
|---|---|---|
| hidden-title | insert the title of a card the viewer provably cannot see (drawn from the checker's own `hiddenTitles` minus `visibleTitles` census, so the plant is hidden by construction) into a state field | `hidden-title-in-state` naming that title |
| private-log | append a `SPOILER: ...` line to the state's log tail | `private-log-line` naming that line |

Runner: one short rules-vs-rules game per class with `&invariant=1
&plant=...`, asserting `invariantViolations` contains the planted kind
and NOTHING ELSE fires on the unplanted control game (the existing
invariant suite is the control — it already runs 5 seeds clean).
Records from plant games are throwaway (`out/selftest-*`, gitignored).

### 4. Golden determinism (comparator on doctored copy)

The golden comparator is a normalized-log equality; the selftest
doctors one line of a fixture copy in memory and runs the same
comparison function against the fresh replay of that game. Caught =
diff reported at the doctored line. (Cheapest suite — one replay; it
shares the game with the clean golden run when executed in the same
process.) If the comparator isn't currently exported as a pure
function, it becomes one — a refactor of plumbing, not behavior.

### 5. What is deliberately NOT in scope

- The D10 retry clauses and D09 fulfillment clause self-test by
  construction (the mock injects the very faults they detect — that IS
  fault injection, already in CI).
- Double-run byte-identity needs no injection: it is a diff, and it
  has already caught a real defect in the wild (the JSONL write race).
- The formatter is presentation, not a checker; format drift is caught
  by review, not selftest.

## Manual-review assist (Dante's offer)

Fault injection proves the checkers can detect; it does not prove the
checkers' MODEL of the rules is right (a credit-conservation rule that
is itself wrong passes selftest and audits games wrongly). That is
what human review is for, and it can be made cheap:

```sh
tsx src/cli.ts audit --file out/<game>.json --review-sample 12
```

writes `<game>-audit-sample.md`: 12 randomly-sampled (seeded)
checkpoints, each showing the log excerpt since the previous
checkpoint, the auditor's arithmetic (starting credits ± each parsed
line → expected), and the checkpoint's actual value. Hand-verifying 12
of these validates the auditor's parsing and arithmetic against the
rulebook in ~10 minutes, without re-deriving a whole game. The same
flag pattern can later extend to the invariant checker (sampled
hidden-card entries next to ground truth) if this proves useful.

## Acceptance

- `selftest`: every mutation class caught and localized; clean
  baselines pass; suite green in CI (keyless — mock/golden/rules
  games only).
- Control: full existing suite (golden, invariant, audit, mock gate)
  unchanged and green — selftest additions must not perturb any
  existing artifact.
- One `--review-sample` packet generated from game 3 and reviewed by
  Dante — the human calibration pass that selftest cannot replace.

## Non-goals

Property-based/fuzz testing of the engine itself (engine is
quarantined ground truth), mutation testing of harness code coverage
(this validates checkers' detection claims, not code coverage), and
any rules-correctness re-derivation beyond the sampled manual packet.
