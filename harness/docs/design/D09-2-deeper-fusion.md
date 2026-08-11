# D09 rev 2 — Deeper fusion (three condensation classes)

**Status: implemented** (review resolutions: cross-products UNBOUNDED
with an alert at ≥40 entries — `large_menu` on the decision record,
`largeFusedMenus` on the game record, stdout warning; option-0 folding;
Q5 riders bundled) · From Dante's opus-game notes (#285/287,
#449/451, #566–570, #582/584): compound mode still leaves three
recurring chain shapes as multi-step API decisions. Opus spent roughly
15–20 of its 100 API decisions on them.

## Governing rule (from the ambush-arc finding)

Fusion may only span decisions within a SINGLE information state. The
#197→#347 learning arc worked because continue/jack windows let the
model re-decide as information arrived (rez choices, approach state).
Classes (a) and (b) below satisfy this — the fused choice commits
nothing the model couldn't already see at the verb step. Run
continuation windows stay unfused, permanently.

## Class (a): play-card → server (Jailbreak, Overclock, ...)

Today "play Jailbreak" fuses verb+card, but Jailbreak's own "which
central?" arrives as a real select. Rev 2 nests the enumeration one
level: when a fused entry's card carries a follow-up choice that is
itself enumerable at fuse time, emit cross-product entries —
"play Jailbreak → run HQ", "play Jailbreak → run R&D". Fulfillment
extends to the second select via the same subject-matching machinery
(pendingCompound becomes a queue of two subjects).

**Menu-size guard**: cross-products multiply. If the fused menu would
exceed a cap (proposed: 24 entries), fall back to one-level fusion for
that verb. In the observed games the expansion is small (2 copies × 2–4
servers).

## Class (b): break → which-subroutine

Same shape at ice encounters: the break command's subroutine list is
enumerable at the verb step (D05 previews already show it). Fuse to
"Break subroutine: 'The Runner loses 3[c]'" entries. Encounters with
multiple breakable subs and multiple breakers stay within the cap
guard.

## Class (c): access-order folds (guarded auto-resolve)

Archives (and Jailbreak/Conduit multi-access) order selects are
strategically null — every card gets accessed, steals are mandatory —
UNLESS an accessed card's steal trigger can alter the remainder of the
sequence. This is not a menu fusion but a page-side auto-resolve:
answer order selects with option 0, full record, no API call.

**The guard** (pool-audited): fold iff the accessed server's root
contains no unrezzed installed card. Audit method (recorded so it can
be re-run on any pool change): static hook scan of every card in both
precons for `responseOnAccess` / `responseOnStolen` /
`automaticOnAccess`. Current pool result — the only order-dependent
line is Send a Message (steal-trigger fires from any zone: corp rezzes
any card free) rezzing an AMAZE Amusements installed unrezzed in the
accessed server's root, which tags subsequent steals in the same
access. Urtica Cipher's ambush is installed-only (empirically
confirmed in games 3–5); Orbital Superiority triggers on SCORE only —
stealing it is inert. The guard is structural (visible state only) and
degrades to real selects exactly when the dangerous configuration
exists. **Re-audit is mandatory per pool expansion** — steal COSTS
(Obokata-class, future pools) break order-irrelevance with no root
involvement; the audit lands in the D11 selftest suite as a checked
claim.

**Recording**: folded order selects get `order_folded: true` (model
fields null, like forced/fulfilled); the game record counts them
(`orderFolded`). Distinct from `forced` (menu had one option) and
`compound_fulfilled` (answered from a fused choice) so analysis can
separate the three silences.

## Riders (from the opus debrief Q5, reviewed as part of this doc)

1. **Run-position annotation**: decision messages' run context gains
   "encountering ice N of M (position 0 = innermost)". Public
   information; interface-guide version bump.
2. **Counters-visibility sentence**: one interface-guide line naming
   the `counters` field on hidden root entries ("advancement counters
   on facedown cards are visible in the counters field"). No state
   schema change — the data is already there; the model under-attends
   it.

## Flag surface

All three classes ride the existing `--actions compound` default;
`--actions split` disables fusion AND folds (the games-1/2 arm stays
pure). No new flags.

## Acceptance

Standard ladder (typecheck, golden, invariant, audit, mock double-run
identity) plus: mock game exercises ≥1 class-(a) cross-product fusion
and ≥1 class-(c) fold (seed chosen accordingly); a record-level replay
of the opus game's #449/#451 and #566–570 chains confirming what WOULD
have fused/folded; baseline-equality check that the engine stream is
untouched (enumeration dry-runs only — same RNG-guard discipline as
D05). DECISION_LOG documents the new field.

## Open questions (resolved)

1. Cross-product cap — **unbounded**, with the alert machinery above;
   cap-as-knob deferred to a later phase with a literature pass.
2. Class-(c) folds pick **option 0**.
3. Q5 interface riders — **bundled** with this build.

## Verification (implemented)

- Second-level enumeration runs inside the same RNG guard as D05;
  engine stream untouched (golden 10/10, invariant 17,032
  serializations zero leaks, audit green after the change).
- Fusability guard discovered in verification: a second level whose
  entries are hidden or duplicated (Mutual Favor's stack search
  previews as N identical "hidden card" entries) must NOT fuse —
  first-match fulfillment would commit an arbitrary card. Such
  follow-ups stay real selects; the guard requires every second-level
  entry visible and distinct.
- Mock evidence (seed 3): "play Jailbreak → R&D" chosen at one command
  decision, both follow-up selects (card, then server) fulfilled
  silently — the #449/#451 chain eliminated. Order folds fired on
  breach access menus (multi-access from R&D/HQ and archives),
  `order_folded` records with model fields null. Seeds 3/5/11/13/21
  all PASS; double-run byte-identical; split arm PASS.
- Acceptance gate extended: compound mode now also requires
  `orderFolded >= 1` — the CI mock seed moves to 3 (exercises every
  clause including folds; seed 5's new trajectory has none).

## Live fire (opus game 2, post-implementation)

First real-model game under D09-2 (opus, seed 7): runner win 7–3 in 15
turns — opus is 2/2 at this seed by entirely different paths. Every
class fired in the wild: 65 fulfillments; chosen `then` entries
including "trigger Carmen → Do 2 net damage" (class b) and "trigger
Red Team → HQ" (class a semantics on an ABILITY's server choice — a
shape the design didn't explicitly anticipate but the pure-Enumerate
rule covers); 4 order folds, the largest a 10-card Archives breach
containing two Urtica Ciphers — accessed silently and harmlessly,
exactly as the pool audit certified. Zero retries, fallbacks, invalid
records, preview divergences, large-menu alerts, or truncated
summaries.

**Cost regression found and mitigated**: fused menus fatten each
decision message, so the transcript grows faster per API decision and
the kept-window floor creeps up — at a 150K threshold this drove 7
compactions (epochs decaying to ~7–10 API decisions) and ~$19.80 total
vs ~$12.20 for the pre-fusion opus game. Mitigation shipped with this
addendum: opus models default to `--compact-threshold 300000`
(cli.ts), and PROMPTING.md documents the floor-inflation mechanism.
The fusion's API-call savings are real; they must not be spent on
compaction churn.
