# Reading the decision log

Every LLM game writes `out/<game_id>.jsonl` — one JSON record per decision,
**both seats interleaved in game order**. This is the primary research
artifact: win rates come from the game record, but everything about *how*
a model played comes from here.

Since D01, the stream carries two record types, distinguished by
`record_type`: `"decision"` (the overwhelming majority; absent in game-1
records, which predate the field) and `"compaction"` (conversational mode
only — see below).

## The two decision layers

The engine asks players two kinds of questions, and they arrive as chains:

1. `command` — "what do you want to do?" The options are engine command
   names (`gain`, `draw`, `install`, `run`, `n`, ...), each with the
   engine's own tooltip where one exists.
2. `select` — "with what / where?" The follow-up parameter choice: which
   card to install, which server to run, which subroutine to let fire.

So a single in-game action usually spans two records: `command: run` at
seq N, then `select: HQ/R&D/...` at seq N+1. Response windows produce many
one-option or `n`-heavy command decisions — that's the engine offering the
chance to react, and "n" declining it.

## An annotated record (Runner seat)

```jsonc
{
  "game_id": "llm-mock-s7-...",   // one id per game; filename stem
  "seq": 150,                      // global decision counter, BOTH seats —
                                   //   seq is game order, not per-seat order
  "turn": {"side": "runner", "number": 4},
  "phase": {"identifier": "Runner 1.3", "title": "Take Action"},
                                   // identifier = NSG rulebook step encoded
                                   //   in the engine's phase machine
  "seat": "runner",
  "decision_type": "select",
  "state": { ... },                // EXACTLY what the model saw: the
                                   //   serializer's runner view (hidden
                                   //   cards as {"hidden":true}, public log
                                   //   tail with turn markers). null on
                                   //   corp records.
  "options": [                     // the numbered menu, as shown
    {"index": 0, "label": "HQ", "server": "HQ"},
    {"index": 1, "label": "R&D", "server": "R&D"},
    {"index": 2, "label": "Archives", "server": "Archives"},
    {"index": 3, "label": "Remote 0", "server": "Remote 0"}
  ],
                                   // D04/D05: command options that lead
                                   //   to a follow-up choice carry
                                   //   "choices": a preview of that menu
                                   //   (entries as the real menu renders
                                   //   them, minus index) — the same
                                   //   enumeration the engine performs if
                                   //   the command is chosen. Subjectless
                                   //   commands (gain, draw...) carry none.
  "choice": 1,                     // index actually executed
  "reasoning": "R&D pressure ...", // the model's stated reasoning (logged,
                                   //   never shown to the opponent)
  "raw_response": "{\"option\":1,...}", // exact pre-parse model output
  "retries": 0,                    // corrective round-trips this decision
  "fallback": false,               // true = model never produced a valid
                                   //   choice; option 0 was forced
  "model": "claude-...",
  "tokens_in": 2900, "tokens_out": 85, "cache_read": 11200,
  "latency_ms": 1840,
  "reproduction_code": "...",      // executable engine state string —
                                   //   paste into the debug console (or the
                                   //   future `inspect` command) to rebuild
                                   //   this exact position
  "transcript_tokens": 41200,      // D01: observed request size (system +
                                   //   conversation + decision) for this
                                   //   call. null on corp records and in
                                   //   --context stateless
  "compaction_id": 0,              // D01: compaction epoch (0 = before the
                                   //   first compaction). null if stateless
  "preview_divergence": null       // D05: on a SELECT decision, set to
                                   //   {command, previewed_at_seq, preview}
                                   //   when this menu differs from the
                                   //   preview shown on the chosen command
                                   //   — the "preview, not promise" cases,
                                   //   surfaced for analysis (⚠️ in both
                                   //   formatter views, counted in the
                                   //   game record, never shown to the
                                   //   model)
}
```

## Compaction records (D01, conversational mode)

When the transcript nears the threshold, the model writes a summary for
its future self and the conversation restarts as [its summary] + the last
K exchanges verbatim. Each such event is a first-class record in the same
stream:

```jsonc
{
  "record_type": "compaction",
  "compaction_id": 1,              // 1-based epoch this event STARTED
  "seq_before": 428,               // decision whose arrival triggered it
  "log_index": 293,                // same anchoring as decisions
  "transcript_tokens_before": 150505,
  "dropped_turns": 209,            // exchanges now living ONLY in the summary
  "kept_turns": 20,
  "summary": "...",                // the model's own words — its entire
                                   //   memory of the dropped past. When a
                                   //   later confabulation needs tracing,
                                   //   start here.
  "model": "...", "tokens_in": ..., "tokens_out": ..., "latency_ms": ...
}
```

## Corp (rules-AI) records

The opponent's decisions land in the same stream so per-game analysis has
both sides, with three differences: `state` is null (the corp AI reads live
globals; snapshotting its view every decision would double file size for
data we don't analyze yet), `model`/`reasoning`/token fields are null, and
`options` are described from the **corp's own view** — they can contain
corp-private information (its hand, unrezzed ice identities). That is
correct and safe: the JSONL is host-side analysis data and is never shown
to the LLM. Do not paste corp records into a live LLM's context mid-game.

## Things that trip people up

- **seq gaps per seat are normal.** seq counts both seats' decisions, so
  the runner's records jump (5, 7, 11, ...) wherever corp decisions
  interleave. Mulligan-phase records have `"turn": null` (turn tracking
  starts at Corp turn 1).
- **Most decisions are tiny.** Response windows and subroutine ordering
  produce hundreds of low-stakes records; the strategically interesting
  ones are usually `command` decisions with 4+ options and `select`
  decisions choosing servers/cards. Filter before reading.
- **The mock's records look odd on purpose.** `reasoning: "mock: seeded
  random legal choice"`, plus one injected bad-index record (retries: 1)
  and one persistent-garbage record (fallback: true) — those exist to
  prove the retry/fallback machinery; they are not model behavior. Mock
  token counts are synthetic (~chars/4) so compaction exercises keylessly.
- **Game-1 records are schema-degraded — root-caused and fixed.** The
  engine's utility.js replaces the global `JSON.stringify` with a
  log-readability version that collapses any object bearing a `.title` to
  its title string (and null → `"null"`). Game-1 states/options passed
  through it: grip entries and identities became bare title strings, phase
  objects became titles, and ALL cardEntry detail (counters, strength,
  rezzed, subroutines, hosted) was silently dropped from records and
  prompts alike. harness.html now captures the pristine `JSON.stringify`
  before the engine loads and the page bridge uses that, so records from
  game 2 onward carry the full documented schema. Analysis code stays
  tolerant of both shapes.
- **`state` is the ground truth for "what did it know?"** Any claim like
  "the model ran into a known Urtica" is checkable: the state in that very
  record either shows the information or shows `{"hidden":true}`.

## Quick recipes (jq)

```sh
jq -c 'select(.seat=="runner" and .decision_type=="command")
       | {seq, turn, choice: .options[.choice].command, r: .reasoning}' game.jsonl

jq -c 'select(.fallback==true or .retries>0)' game.jsonl     # incident scan

jq -r 'select(.seat=="runner") | .tokens_in' game.jsonl \
  | awk '{s+=$1} END {print s " input tokens"}'              # spend check

jq -r 'select(.seq==150) | .reproduction_code' game.jsonl    # grab a position
```
