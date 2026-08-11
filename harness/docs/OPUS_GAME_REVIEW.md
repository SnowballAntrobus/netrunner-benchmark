# Opus game review — llm-claude-opus-5-s7-1786414095246

Dante's manual notes adjudicated against the records, with ground-truth
verification where the claim was checkable. Game: **first runner win in
the corpus** — 7–3 on agenda points over 15 turns, 1,192 decisions (100
API / 497 forced / 44 fulfilled), 0 retries, 0 fallbacks, 3 compactions
(all healthy, 0 suppressed, no truncated summaries), ~$12.20 at Opus-5
rates. The debrief correctly narrates the arc (early remote pressure →
attrition race on HQ through Tithe → winning steal on the last access).

## Access surfacing under auto-resolve (#128, #141, #307, #1007, #1020)

**Verified working — the gap is attentional, not informational.** The
#128-area access resolved as forced selects (no API call), but
"Manegarm Skunkworks accessed" arrived in the very next API decision's
log tail (#141, 14 lines later), and conversational history retains
every delivered tail permanently. The failure mode Dante detected is
real but belongs to the model: #141's own reasoning runs HQ again for
"decent agenda chance" without conditioning on the non-agenda it just
saw; #307 estimates odds without using it either.

**Documented edge**: the log tail is the last ~30 public lines. If more
than that passes between two API decisions (an opponent turn that is
entirely forced/rules-handled), an access line can scroll out of the
arriving tail — it survives only if some earlier API decision saw it.
Rare in practice (measured gaps this game: all < 30), catastrophic in
principle only for the stateless arm, which has no history at all.
Noted in DECISION_LOG reading guidance rather than "fixed": widening
the tail trades prompt size for a guarantee the conversational
transcript already mostly provides.

## The ambush learning arc (#197 → #199 → #298 → #347)

**Verified exactly as noted.** #197 runs an undefended remote with zero
ambush consideration; #199 (the continue window, same run) does the
flatline arithmetic correctly — "2 net damage would empty grip but not
flatline (damage must exceed cards)" — and proceeds on correct math;
#298 identifies mid-run that a 2-advancement Urtica would now BE lethal
and jacks out (Dante: right call, shouldn't have run — agreed, and the
jack-out wasted Tread-Lightly-class resources per #307's own
admission); #347 declines to run a 4-advancement remote at all, citing
the exact kill arithmetic. This is in-context learning across ~40
minutes of game time, and it is the strongest single-game behavioral
finding so far: contrast haiku, which walked into the same trap twice
in two games at the identical decision shape.

**Design counterweight recorded**: the two-step run structure (initiate
→ continue/jack windows) is what gave #199 and #298 their recovery
points. Deeper compounding must never fuse across windows where new
information (rez decisions, approach state) arrives — D09 rev 2 keeps
fusion within single information states.

## Condensation opportunities (#285/287, #449/451, #566–570, #582/584)

Three distinct classes, specced in `design/D09-2-deeper-fusion.md`:

- **(a) play-card → server** (#449/451 Jailbreak, #582/584 Overclock):
  the D09 fusion stopped at the card; the card's own server choice
  arrived as a real select. Fusable by nested enumeration
  (cross-product entries: "play Jailbreak → run R&D").
- **(b) break → which-subroutine** (#285/287): same shape — the break
  command's subroutine choice is enumerable at the verb step.
- **(c) access-order selects** (#566/568/570): condensable ONLY where
  order provably cannot matter. Pool audit (full hook scan of the corp
  precon, method recorded in the design doc): the single
  order-dependent line in the current pool is **Send a Message stolen
  mid-access while an unrezzed AMAZE Amusements sits installed in the
  accessed server's root** (steal SaM → corp rezzes AMAZE → subsequent
  steals that access give 2 tags). Urtica is installed-only
  (empirically confirmed); Orbital Superiority's trigger is
  score-only — stealing it is inert. Hence the structural guard: fold
  access-order iff the accessed server's root contains no unrezzed
  installed card. Sound for this pool; MUST be re-audited on any pool
  expansion (future sets add steal costs — Obokata-class — that break
  order-irrelevance with no root involvement).

## Probability and threat-model spot checks (#861, #939, #440/#504)

- **#861 — worse than suspected.** Ground truth (SPOILER lines, runner
  turn 12): HQ held [Seamless Launch, Public Trail, Government Subsidy,
  Manegarm Skunkworks, Retribution] — **zero agendas**. The model's
  "multiple ~20% shots at the winning agenda" was a blind 1-in-5 prior
  presented as knowledge; the winning Superconducting Hub only reached
  HQ around turn 14. The turn-12 HQ runs were guaranteed whiffs.
- **#939 — half-right threat model.** The genuine kill path in this
  deck is Public Trail (tag) → Orbital Superiority (4 meat on score...
  n.b. on SCORE — so the actual runner-facing risk was tag-enabled
  plays generally); the model named "Public Trail/Retribution", but
  Retribution trashes a program/hardware — it does no damage. Right
  conclusion (pad grip before running), imprecise mechanism.
- **#440/#504/#269/Compaction #1 — rulebook reliance confirmed.** The
  model demonstrably leans on the matchup-specific card explanations
  (naming exact economy targets in its compaction summary). Whether
  play quality survives without that scaffolding is a Phase-2
  ablation: withhold the matchup guidance, re-measure.

## Compactions as strategy windows (Compaction #1, #3)

Agreed — the three summaries read as strategy memos and are the
cheapest insight into planning we have. The M5 match review (D12) will
quote each game's compaction summaries alongside outcomes.

## Debrief Q5 — interface friction (queued as small design items)

1. **Per-server advancement summary**: the information is already
   serialized (`{"hidden": true, "counters": {...}}` on the root
   entry); the ask is presentation/attention, not data. Candidate
   response: an interface-guide sentence naming the counters field
   explicitly (versioned prompt change), NOT a state-schema change.
2. **Run-position annotation**: "encountering ice N of M (position 0 =
   innermost)" in the run-context line of decision messages. Public
   information, small, honest; rides with D09 rev 2 review.

## Queue deltas from this review

- D09 rev 2 (classes a/b/c + guard + run-position annotation +
  interface-guide counters sentence) — design review, then build.
- DECISION_LOG note on the 30-line tail edge (documentation only).
- Phase 2 (parked): rulebook-reliance ablation; access-memory probing
  (does the model ever condition on its own access history?).

---

# Addendum — Opus game 2 (D09-2 stack), llm-claude-opus-5-s7-1786422381592

Second opus game at seed 7, first under deeper fusion: **runner win
7–3 in 15 turns again**, by an entirely different path — breaker suite
+ drip economy, early remote steals, then a corp counterattack
(Public Trail tag → Retribution kills Carmen → click-trash removes Red
Team), a multi-turn rebuild, and the winning Send a Message off R&D on
turn 15. The debrief narrates all of it accurately.

**Machinery: perfect game.** 114 API / 474 forced / 65 fulfilled / 4
folded; 0 retries, fallbacks, invalid records, preview divergences,
large-menu alerts, truncated summaries, suppressed compactions. All
three D09-2 classes fired live, including a 10-card Archives fold
containing two Urtica Ciphers (inert, as pool-audited) and `then`
chains on ability server-choices (Red Team → HQ) the design's
pure-Enumerate rule covered without anticipating.

**Cost regression (the game's one finding)**: 7 compactions at the
150K threshold (`dropped_turns` 27→7 — floor creep accelerated by
fatter fused messages), ~$19.80 vs ~$12.20 for opus game 1. Mitigated
same-day: opus models default to a 300K threshold; mechanism
documented in PROMPTING.md; D12 cost model updated.

**Corpus tally at seed 7**: opus 2/2 wins (different paths), sonnet 1
survival in 3 tries (both deaths near-identical turn-2 trap walks),
haiku 0/4 (three near-identical turn-3 trap walks; best attempt stole
2 AP first). The advanced-Urtica read remains the sharpest single
discriminator the benchmark has produced.
