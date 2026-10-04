# Engine quirks

The Chiriboga engine was written for people and for its own AI, not for a harness. These are the behaviors that mattered, and how the harness handles each without changing an engine file. The fork point is drbo6/chiriboga commit `ec72938` (upstream `c863f5a`).

## Loading the engine

`harness.html` loads only what a headless game needs: jQuery, Pixi, lz-string and seedrandom, the core engine files, the base card sets, any extra sets named in `&sets=`, and the page layer. Pages such as `index.php` and `gauntlet.php` never run. Whatever must change inside the page is done by `harness/page/bootstrap.js`, which rebinds globals after the engine loads and never edits a file. Text mode (`accessibilityMode="text"`) skips the board, and `mainLoopDelay = 0` skips rendering.

- **`JSON.stringify` is replaced.** `utility.js` swaps the global for a log-friendly version that collapses any object with a `.title` to the title and turns `null` into `"null"`. Serializing states through it silently drops every counter, strength and subroutine. `harness.html` saves the original as `window.__pristineJSON` before any engine script loads, and the page layer serializes with that copy.
- **There is no turn counter.** Bootstrap wraps `ChangePhase` to count turns and add turn markers to the serialized log. The wrapper must forward every argument: dropping `skipInit` re-runs phase initializers forever.
- **One viewing perspective.** The engine masks titles in labels and narration by a single global `viewingPlayer`. A game with a model Runner renders from the Runner's side so the shared log stays honest. A model Corp in such a game is told, in one sentence of its prompt, that its own cards appear as "hidden card" in the log, and its menus have those labels restored for cards it can see.
- **Breach menus name the cards about to be accessed.** `ChoicesAccess` unmasks titles for a human Runner. Menu entries for cards the deciding seat cannot see have their titles masked.
- **Hosted cards sit outside every zone.** Detente hosts a Corp card face up on Runner hardware, out of reach of the engine's `AllCards`, so the no-cheating census walks hosted cards recursively.

## The rules AI inside card scripts

Card scripts branch on `player.AI != null`. They prune a menu to the rules AI's pick, suppress an option the rules AI would not use, or pre-fill a choice through `preferred`. There are dozens of these branches across the sets. A model's seat needs an AI object for the engine to dispatch decisions, so `llmplayer.js` gives it `Object.create(rulesAI)` with the two choice methods routed to the host. It also makes `player.AI` read as null when the code reading it is a card script (a `sets/*.js` frame on the stack) and no rules-AI deliberation (`ai_corp.js`, `ai_runner.js`, `runcalculator.js`) is under way. Card code therefore offers a model the full menu a human would get, while the engine and the rules AI's helpers still see the shell. `--ai-branches rules` turns this off.

Two consequences follow:

- **Multi-card selections** ("trash 2 cards from your grip") carry slot arrays that the human interface fills click by click and the rules AI fills from `preferred`. The page asks a model for them one card at a time (`multi_select` on the record).
- **Searching your own deck** (Mutual Favor, R&D tutors) is looking, which `PlayerCanLook` does not model. Those menu entries are revealed to the searching seat; the state still shows the deck as a count.

## Private log channels

These log prefixes are private and never reach a model: `SPOILER:` (omniscient dumps), `AI:` (either AI's reasoning), `RC:` (run-calculator diagnostics), `ERROR:` and `DEBUG:`, `AI would have chosen:`, and `[` (decklist dumps). Matching must be on exact prefixes, because public card triggers share the "Title: ..." shape. The no-cheating checker exempts `phase.title`: a card's decision phase is publicly announced under its name and can outlive the card's visibility (Spin Doctor shuffles itself into R&D while its phase is still named after it).

## Determinism

Everything below had to be pinned for one seed to replay one game:

1. All game randomness flows through `Math.random`: shuffles, the Runner AI's jitter and a few card AIs. Bootstrap seeds it with the engine's bundled seedrandom. The engine's own `LCG` in `command.js` has no gameplay call sites; it is reseeded anyway.
2. Pixi particle emitters draw `Math.random` on wall-clock ticks. Bootstrap disables emitter updates and stops the tickers.
3. After a win the engine offers "play again", and with both seats automated it reloads the page. Bootstrap pauses the main loop at the win and snapshots the log at that moment.
4. The run calculator logs its execution time. Comparisons normalize `NNN ms`, and raw logs are kept.
5. Narration re-enters the main loop from a speech callback that never fires headless, so narration stays off.
6. Card enumerations can consume randomness in AI-only branches (fast advance shuffles its target list). The harness previews follow-up menus by dry-running enumerations, so every preview runs with `Math.random` swapped for a local fixed-seed generator. A harness feature that calls into the engine like this must leave a mock game's log identical to a run without the feature. Two runs with the feature would perturb the game identically and still agree with each other.

The debugging aids are `&rngtrace=1`, which counts draws per log line, and `&rngstack=N-M`, which captures stacks for draws N to M. The golden games are the regression net. Perturbing the seedrandom seed fails every one, and perturbing the engine's `LCG` changes nothing.

## Refused decks

`pool --qualify` refuses five precons because of engine defects. Each reproduces with the rules AI in both seats and no harness seat involved:

| deck | side | sets | first problem |
|---|---|---|---|
| Agency | Corp | elevation | `TypeError: Cannot read properties of null (reading 'unique')` |
| Fashion Lab | Corp | elevation | stalled after the same `TypeError` |
| Economy, Chaos and FIxed Suit | Runner | coreset | stalled: `TypeError: Cannot read properties of undefined (reading 'length')` |
| Professional Opportunities | Runner | elevation | `preferred option not matched with the above optionList` |
| R&Devour | Runner | coreset | stalled after the same `TypeError` as Economy, Chaos and FIxed Suit |

One more defect sits in decks that do qualify. Peer Review (Elevation) calls `NewRemoteServer()`, which the engine never defines, when a human or model Corp uses it to install into a new remote. The ReferenceError voids that install. The rules AI never takes that branch, and the single mock game in qualification did not reach it, so 1000 Cuts, Pecularity and Quick Returns all qualify. `smoke` hits it with 1000 Cuts against 2013 Worlds Game 3 on seed 1. Keep model Corps off those three decks until the engine is fixed.

Some set files also log self-lint at load ("... should not be automatic", "... will be ignored because it is set to automatic"), the same in every game. These are reported as lint, not errors.

## Merging upstream changes

Any change to engine files must pass `golden check`; re-bless with `golden record` only when the change in behavior is intended. Then rerun `pool --qualify`, `selftest` and `frames --corpus` to confirm that decks still qualify and that recorded games still replay.
