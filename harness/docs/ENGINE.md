# Engine notes

## Base and quarantine policy

This repo is a fork of [drbo6/chiriboga](https://github.com/drbo6/chiriboga)
(itself a fork of [bobtheuberfish/chiriboga](https://github.com/bobtheuberfish/chiriboga)).
Harness work began at fork commit `ec72938` (upstream tip `c863f5a`, 2026-04-08).

**Engine files are not modified.** The harness quarantines rather than
deletes: `harness.html` loads only the files a headless game needs, and
everything else (`index.php`, `gauntlet.php`, `decklauncher.php`, precons,
styling) simply never executes. All harness behavior that must run inside the
page lives in `harness/page/bootstrap.js`, which rebinds globals after engine
scripts load — never by patching them on disk. This keeps upstream merges
conflict-free and every observation reproducible against a pristine engine.

## What harness.html loads

jQuery, Pixi (+ pixi-particles, particlesystems, cardrenderer), lz-string,
seedrandom, then the eleven core engine files (`init`, `phase`, `command`,
`checks`, `mechanics`, `utility`, `decks`, `runcalculator`, `ai_corp`,
`ai_runner` + the `cardSet` prelude), the System Gateway / System Update 2021
/ tutorial sets, and finally `harness/page/bootstrap.js`. Text mode
(`accessibilityMode="text"`) skips the graphical board; `mainLoopDelay = 0`
additionally short-circuits `Render()`.

Decks are passed the same way the engine's own pages do it: LZ-compressed
JSON (`{identity, cards[], name}`) in the `r`/`c` URL params, built from
`precons/*.js` by `harness/src/precons.ts`. `faceoff=1` puts the rules AI in
both seats.

## Determinism ledger

Everything found (via the `&rngtrace=1&rngstack=N-M` debug params in
bootstrap.js) while making seeded runs reproducible. Determinism is verified
in CI by `cli.ts determinism`, which plays the same seed twice and diffs logs.

1. **Engine LCG** — `command.js` `var rand = LCG()` self-seeds from
   `Math.random` at load. Bootstrap rebinds `rand = LCG(seed + 1)`.
2. **`Math.random`** — used by `RandomRange()` (all shuffles), the Runner
   AI's decision jitter (`ai_runner.js:2193`), and three card-AI call sites.
   Bootstrap seeds it via the engine's own bundled seedrandom.
3. **Pixi particle emitters** — `Emitter.update()` draws `Math.random` per
   spawned particle, driven by wall-clock deltas from the renderer's own
   `requestAnimationFrame` loop (`interfacerUpdate`, cardrenderer.js) as well
   as per-event effect bursts. This desynchronizes the seeded stream between
   otherwise identical runs. Bootstrap no-ops
   `PIXI.particles.Emitter.prototype.update` and stops the app/shared
   tickers.
4. **Post-win reload** — after `PlayerWin`, the engine offers a "play again"
   command; with both seats AI it gets resolved (`location.reload()`),
   destroying the page mid-observation. Bootstrap sets `pauseFaceoff = true`
   (the engine's own gate at the top of `Main()`) in its PlayerWin wrapper,
   and snapshots the log at the moment of the win (`logAtWin`) so trailing
   endgame-modal lines don't depend on host poll timing.
5. **Wall-clock text in logs** — the RunCalculator logs "execution time of
   NNN ms"; the determinism comparison normalizes `\d+ ms` before diffing.
   Raw logs are preserved untouched in `harness/out/`.
6. **Narration** — in text mode with narration on, the main loop is
   re-entered from `SpeechSynthesisUtterance.onend`, which never fires
   headless (stall, not nondeterminism — noted here because it must stay
   disabled). Bootstrap unchecks `#narration`.

## Browser dependencies observed (for a future Node/jsdom host)

Running the engine outside a real browser will need at minimum: jQuery
(deep-`extend` is load-bearing in card instantiation and phase templates),
DOM elements harness.html provides (`#history`, `#modal`, `#narration`,
`#rewind-select`, ...), `localStorage` (settings/achievements writes on
win), Pixi constructible enough for `CardRenderer.Renderer`'s constructor
(it runs even in text mode), and `requestAnimationFrame` existing. The
golden logs from the determinism/batch commands are the acceptance test for
any such port.
