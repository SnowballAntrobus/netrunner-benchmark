# Reading game records

Every model game writes a folder, `out/<game_id>/`. Every tool accepts the folder or any file in it.

| file | contents |
|---|---|
| `record.json` | the result, the configuration (seats, models, decks, seed, every knob), per-seat counters, token usage and cost |
| `decisions.jsonl` | one record per decision, both seats interleaved in game order, plus compaction records |
| `frames.jsonl` | an omniscient board snapshot before each decision and at the end, for the board viewer only; no model ever sees it |
| `system-prompt.txt` | the full system prompt; two-model games have one per seat (`system-prompt.corp.txt`, `system-prompt.runner.txt`) |
| `debrief.json` | each model seat's answers to the postgame questions |
| `full.md` | a readable narrative of the game, written by `format` |

## The game record

`status` is `completed`, `timeout`, `stalled` (no progress for too long), `crashed` or, for a chat player who concedes, `resigned`. `winner`, `reason` and the agenda points give the result. `llmSeat` names the model seats (`runner`, `corp` or `both`), and `seats.corp` and `seats.runner` hold each model seat's counters:

- `llmDecisions`: decisions the model answered. The rest were answered by the page: `forcedDecisions` (one option), `compoundFulfilled` (the second step of a fused action) and `orderFolded` (an access order that cannot matter).
- `retriesTotal`, `fallbacks`: malformed answers corrected, and decisions where the model never gave a valid one and option 0 was taken.
- `compactions`, `compactionsSuppressed`, `transcriptTokensMax`: the conversation's memory events and peak size.
- `usage` and `reportedCostUsd`: tokens, and the provider-billed cost when the provider reports it.
- `driver` and `client`: `api` for the harness calling the model, `mcp` for a chat app, whose MCP name and version are kept in `client`. For an MCP seat, `model` is whatever the player called itself.

Top-level counters sum over model seats. `invalidRecords` counts decision records that failed validation and must be 0, and `previewDivergences` counts follow-up menus that differed from the preview shown with their command.

## A decision record

```jsonc
{
  "record_type": "decision",
  "seq": 150,                          // decision counter across both seats: game order
  "turn": {"side": "runner", "number": 4},   // null during mulligans
  "phase": {"identifier": "Runner 1.3", "title": "Take Action"},
  "seat": "runner",
  "decision_type": "command",          // "command": what to do; "select": with what or where
  "state": { ... },                    // exactly what the seat saw; null for rules-AI seats
  "options": [ ... ],                  // the menu as shown; "choice" indexes it
  "choice": 1,
  "reasoning": "...",                  // the model's reasoning, never shown to the opponent
  "raw_response": "...",               // the model's exact output before parsing
  "retries": 0, "fallback": false,
  "failed_attempts": null,             // [{raw, problem}] for each rejected answer
  "model": "claude-...",               // null when nothing was asked (forced, fulfilled, folded, rules AI)
  "tokens_in": 2900, "tokens_out": 85, "cache_read": 11200, "latency_ms": 1840,
  "transcript_tokens": 41200,          // request size for this call
  "compaction_id": 0,                  // how many compactions came before
  "forced": false, "compound": true, "compound_fulfilled": false, "order_folded": false,
  "multi_select": null,                // {slot, of, chosen} when cards are picked one at a time
  "preview_divergence": null,          // on a select whose menu differs from the preview
  "reproduction_code": "..."           // the engine's code to rebuild this exact position
}
```

Options are complete actions in the default compound mode: `{"command": "install", "card": {...}, "server": "new server"}`, sometimes with a `then` field for a committed second step. In split mode a command option may carry `choices`, a preview of the follow-up menu.

A rules-AI seat's records have no `state` and describe options from that seat's own view, so they can name its hidden cards. The stream is analysis data. Do not paste the opponent's records into a model's context.

## Compaction records

```jsonc
{
  "record_type": "compaction",
  "seat": "runner",
  "compaction_id": 1,
  "seq_before": 428,                   // the decision whose arrival triggered it
  "transcript_tokens_before": 150505,
  "dropped_turns": 209,                // exchanges that now live only in the summary
  "kept_turns": 20,
  "summary": "...",                    // the model's own words: all it keeps of the dropped past
  "summary_truncated": false           // true if the summary hit the response cap
}
```

When a model later misremembers something, start from the summary of that compaction epoch.

## Things that trip people up

- A seat's `seq` values have gaps, because the other seat's decisions interleave.
- Most decisions are small: response windows and orderings. The informative ones are usually commands with several options, and selects that pick a server or a card. Filter before reading.
- The mock's records look odd on purpose: its reasoning is "mock: seeded random legal choice", and one injected bad answer and one persistent failure exercise retries and fallback.
- `state` settles "what did it know?" The record either shows the card or shows `{"hidden": true}`.

## Recipes

```sh
jq -c 'select(.seat=="runner" and .model and .decision_type=="command")
       | {seq, turn, choice: .options[.choice], why: .reasoning}' decisions.jsonl
jq -c 'select(.fallback==true or .retries>0)' decisions.jsonl          # incidents
jq -r 'select(.seq==150) | .reproduction_code' decisions.jsonl          # one position
jq -r 'select(.record_type=="compaction") | .summary' decisions.jsonl   # the model's memos
```
