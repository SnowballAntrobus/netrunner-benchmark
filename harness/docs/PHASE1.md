# Phase 1 — Headless Bridge

*Planning document, v1. Project working name TBD (placeholder: "the harness"). Base: fork of [drbo6/chiriboga](https://github.com/drbo6/chiriboga).*

## Objective

At the end of phase 1 we can run a complete game of Netrunner, unattended and headless, with a frontier model (Claude, Runner seat) playing against the rules-based Corp AI — with the model provably seeing only information a human Runner could see, every decision logged in a replayable form, and a small regression suite that makes later engine work safe. Ten clean games with a win rate, cost, and decision count is the finish line. Everything in the broader project (model-vs-model, harness ablations, Corp seat, MCP, RL) builds on this substrate; nothing in it is throwaway.

## Locked decisions

| Decision | Choice | Rationale (short) |
|---|---|---|
| Repo shape | Fork drbo6/chiriboga; all new code under `harness/`; engine untouched | Upstream is active; deletions are permanent merge conflicts; unused code costs nothing if never loaded |
| Strip-down strategy | Quarantine, don't delete — our own entry point loads only what a headless game needs | Same clean surface, zero merge debt; real pruning deferred until golden logs exist |
| Harness language | TypeScript end to end; JSONL decision logs are the contract for later Python analysis | In-page code is JS regardless; one toolchain now, analysis ecosystem when there's data |
| First seat | Runner (LLM) vs rules Corp AI | Minimal honest state view; stronger benchmark opponent; blunders legible in logs |
| Model interface | Direct API bridge — we own the agent loop | Controlled comparisons require owning prompt, context, and sampling; MCP is a later distribution wrapper over the same tool definitions |
| Card pool | Start with System Gateway precons only; expand to SU21, then Elevation | Progressive release keeps early debugging on the smallest fully-AI-supported pool |

## Architecture

```
┌─────────────────────────────  Node (TypeScript)  ─────────────────────────────┐
│  runner CLI ── orchestrator ── Playwright ──┐        model client (Anthropic)  │
│      │              │                       │              ▲                   │
│  decision log   golden-log        ┌─────────▼─────────┐    │ tool defs         │
│  (JSONL)        fixtures          │  Chromium (page)  │    │ (shared w/ future │
│                                   │  harness.html     │    │  MCP wrapper)     │
│                                   │  ┌─────────────┐  │    │                   │
│                                   │  │ engine (as- │  │    │                   │
│                                   │  │ is, minimal │  │  page.exposeFunction   │
│                                   │  │ loadout)    │  │    │                   │
│                                   │  ├─────────────┤  │    │                   │
│                                   │  │ serializer  │──┼────┘                   │
│                                   │  │ LLMPlayer   │  │                        │
│                                   │  │ GameBridge  │  │                        │
│                                   │  └─────────────┘  │                        │
│                                   └───────────────────┘                        │
└────────────────────────────────────────────────────────────────────────────────┘
```

Three in-page modules, all plain JS/TS with no Playwright dependencies (this is what keeps the future Node-direct path cheap — see Design Constraints):

- **`GameBridge`** — the narrow API between page and host: start game, report game end, surface log lines, accept a decision. The only thing the host layer touches.
- **`serializer`** — `stateFor(player)` → JSON. Perspective-parameterized from day one; every card visibility question answered by the engine's own `PlayerCanLook`.
- **`LLMPlayer`** — implements the engine's two-method AI contract (`CommandChoice`/`SelectChoice`, Promise-returning), assembling each decision request and awaiting the host's answer. Drop-in replacement for `RunnerAI`.

The engine itself is loaded by our own `harness/harness.html`, modeled on `engine_text.html` (text mode, no PIXI, no PHP): the eleven core engine files, `sets/systemgateway.js` (+ SU21 when the pool expands), and the two precons in play. `gauntlet.php`, `index.php`, `decklauncher.php`, styling, and the other ~69 precons are never loaded.

## Milestones

### M0 — Scaffold
Fork created; `harness/` with TS + Playwright + a static file server (no PHP anywhere in the harness path); engine commit pinned and recorded; CI running typecheck + a smoke test. **Accept:** `npm test` green in CI on a fresh clone.

### M1 — Headless determinism
`harness.html` boots the engine in text mode headless; rules-AI vs rules-AI completes a full game. Engine patches, each small and guard-style: `mainLoopDelay` → 0; game-end hook exposed through GameBridge; **all randomness seeded** — the engine's LCG is already seedable, but the Runner AI's decision jitter and shuffles use raw `Math.random`, so the page installs a seeded PRNG over it before the engine loads. **Accept:** 100 seeded rules-vs-rules games complete without error; re-running a seed reproduces the identical game log, twice.

### M2 — Golden-log regression suite
Freeze ~10 seeded rules-vs-rules games (mixed precons) as fixtures; CI replays and diffs the logs. This is the safety net the engine has never had — it converts "did we break the engine?" from vibes to a diff, and it is the precondition for any future pruning or Node-direct port. Deliberately low-effort: the fixtures are just M1 output, checked in. **Accept:** CI fails when an engine-affecting change alters any golden log; a documented one-command path to re-bless fixtures when a change is intentional.

### M3 — Honest state serializer
`stateFor(player)` produces the full Runner-perspective state: board topology, ice (rezzed → full definition; unrezzed → position + advancement only), both players' public counters, score areas, run context mid-run, pile counts with known-card annotations, recent log tail, and full card text for every visible/owned card. **The no-cheating invariant gets its own automated test**: run full seeded games, serialize the Runner view at every decision point, and assert zero occurrences of hidden information (unrezzed ice titles, HQ/R&D contents, facedown card identities) by cross-checking against the omniscient state. This test is the project's constitution; nothing ships that fails it. **Accept:** invariant test green over ≥5 full games (thousands of decision points); serializer output stable and human-readable.

### M4 — LLMPlayer and the bridge
The real thing: `LLMPlayer` implements `CommandChoice`/`SelectChoice`; each decision request carries the serialized state, the enumerated legal options (verbatim engine option list, numbered), a compact running game summary, and the fixed system prompt (rules digest + output format). Host side: Anthropic API client, strict JSON response format (`{option: <index>, reasoning: <string>}`), bounded retries on malformed output, fallback to option 0 with an incident flag. Every decision appends one JSONL record (schema below), including the engine's `ReproductionCode()` string — which makes every logged decision a *resumable position*. Token and cost accounting per decision and per game. **Accept:** one complete Claude-Runner vs rules-Corp game end to end; log validates against schema; a malformed-response injection test exercises the retry/fallback path.

### M5 — Runner CLI and first results
`run-game` (seats, precons, seed, model, output dir) and `run-match` (N games, seed list); a summary script producing win rate, decisions/game, tokens and dollars/game. Plus the inspection tool you asked for: `inspect <log> <decision#>` loads that decision's `ReproductionCode` into the full graphical engine page locally, so any logged moment can be eyeballed on the real board, entirely separate from headless operation. **Accept — phase 1 done:** 10 complete Claude-Runner vs rules-Corp games on Gateway precons, zero crashes, results table produced, at least one game inspected visually via replay.

## Decision log schema (JSONL, one record per decision)

```jsonc
{
  "game_id": "g_2026...",        // ulid
  "seq": 142,                     // decision counter within game
  "turn": 7, "phase": "Run 4.4", "seat": "runner",
  "decision_type": "command" | "select",
  "state": { ... },               // serializer output given to the model
  "options": ["jack out", "continue"],
  "choice": 1,
  "reasoning": "...",             // model's stated reasoning, verbatim
  "raw_response": "...",          // exact model output pre-parse
  "retries": 0, "fallback": false,
  "model": "claude-...", "tokens_in": 3100, "tokens_out": 210, "latency_ms": 1840,
  "reproduction_code": "..."      // engine state string; resumable position
}
```

Rules-AI decisions in the same game are logged in the same stream (minus model fields), so agreement metrics and the `testAI` shadow-mode comparison slot in later without schema changes.

## Design constraints (cheap options, kept cheap)

**Node-direct engine (throughput path).** Deferred, and deferral wastes almost nothing *provided* we hold three rules: in-page harness code stays plain modules with zero Playwright coupling; all host↔page traffic flows through GameBridge only; every engine browser-dependency we encounter (DOM touches, `document.write` in loaders, localStorage) gets noted in `harness/docs/browser-deps.md` as we trip over it. Then a future jsdom host replaces one layer — the Playwright launcher — and the golden logs from M2 verify the port ran true.

**Corp seat.** Serializer and prompts are seat-agnostic by construction (`stateFor(player)`, no Runner-shaped assumptions in scaffolding). Corp becomes an increment.

**MCP wrapper.** The model-facing tool definitions (observe, act, and later `run_calculator` etc.) are declared once with schemas in `harness/src/tools/`, consumed by our loop now, exposable via an MCP server later unchanged.

## Parking lot (explicitly not phase 1)

- **Pilot-notes ablation** — your deck-piloting idea: compare play with vs. without a NetrunnerDB-style "how to pilot this deck" description, testing whether models infer an archetype's gameplan from the card list alone. Cheap to run once the harness exists; a lovely early experiment.
- **Progressive card pool** — SU21, then Elevation (93% implemented, AI-hooked) as play stabilizes.
- **Deckbuilding as a stretch goal** — model-built decks, eventually gauntlet-style drafting.
- **Harness ablation ladder** — state-only → +card text → +RunCalculator tool → +scratchpad/beliefs → model-authored tools.
- **Corp seat; model-vs-model; MCP wrapper; browser bring-your-own-key play; RL-adjacent tuning** — in roughly that order.
- **Aggressive engine pruning** — only if it still seems worth it once golden logs make it safe.

## Risks

| Risk | Mitigation |
|---|---|
| Hidden-info leak through a serializer bug | The M3 invariant test, run in CI, over full games |
| Context growth across ~200–400 decisions/game | Stateless-per-decision prompting with a compact running summary; summary compression is tunable |
| Cost of iteration | Default smoke-test model is small/cheap; frontier models only for measured runs; per-game token caps |
| Engine has no tests; we depend on its internals | Golden logs (M2); engine patches kept minimal and guard-style |
| Upstream drift (DrBo6 is active) | Engine commit pinned; deliberate, occasional upstream merges; quarantine strategy keeps conflicts near zero |
| Mid-run decision spam inflates cost | Acceptable in phase 1; "auto-pass trivial windows" becomes an explicit ablation arm later, not a silent default |

## Immediate next steps

1. You fork `drbo6/chiriboga`, add this file (e.g. as `harness/docs/PHASE1.md`), and share the repo. If it's public I can clone and push branches directly with the access you set up; either way, name the repo whatever feels right — the working name is yours to pick.
2. I scaffold M0–M1 as the first PR: `harness/` toolchain, static server, `harness.html` with the minimal engine loadout, seeded headless rules-vs-rules games.
3. Golden logs (M2) land as the second PR, and from there the serializer work begins.
