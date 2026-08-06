/* Harness page bootstrap.
 *
 * Plain JS, no host-framework coupling (see PHASE1.md "Design constraints"):
 * everything the host needs crosses through window.__harness only, so this
 * file works identically under Playwright today or a jsdom host later.
 *
 * Loaded at the end of <body>, i.e. AFTER all engine scripts have executed
 * but BEFORE body onload fires Init(). That ordering is what lets us seed
 * RNG and re-point globals without patching any engine file.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var seed = parseInt(params.get("seed") || "0", 10) || 0;

  // ---- The host-visible surface -------------------------------------------
  window.__harness = {
    seed: seed,
    started: false,
    done: false,
    result: null, // { winner: "corp"|"runner", reason, corpAgendaPoints, runnerAgendaPoints }
    errors: [], // uncaught errors + engine LogError output
    decisions: 0, // count of AI decision promises resolved (progress signal)
    log: function () {
      // capturedLog is the engine's own console-capture buffer (utility.js).
      return typeof capturedLog !== "undefined" ? capturedLog : [];
    },
  };

  // ---- Determinism --------------------------------------------------------
  // 1. The engine's own LCG (command.js: `var rand = LCG();` — unseeded by
  //    default, seedable by construction).
  if (typeof LCG === "function") {
    rand = LCG(seed + 1); // +1: LCG(0) would fall back to Math.random
  }
  // 2. Math.random — used by RandomRange() (all shuffles) and the Runner AI's
  //    decision jitter. seedrandom.min.js is already loaded by the engine.
  if (typeof Math.seedrandom === "function") {
    Math.seedrandom("harness-" + seed);
  }

  // ---- RNG debug tracing (opt-in: &rngtrace=1[&rngstack=N-M]) -------------
  // Counts Math.random draws and records the count at every captured log
  // line (window.__rngTrace, aligned with capturedLog indices). With
  // rngstack, also records call stacks for draws in index range N..M.
  // Used to hunt non-game RNG consumers that desync the seeded stream.
  if (params.get("rngtrace")) {
    window.__rngDraws = 0;
    window.__rngTrace = [];
    window.__rngStacks = [];
    var stackRange = (params.get("rngstack") || "").split("-");
    var stackFrom = parseInt(stackRange[0] || "-1", 10);
    var stackTo = parseInt(stackRange[1] || "-1", 10);
    var seededRandom = Math.random;
    Math.random = function () {
      window.__rngDraws++;
      if (window.__rngDraws >= stackFrom && window.__rngDraws <= stackTo) {
        window.__rngStacks.push(window.__rngDraws + ": " + new Error().stack);
      }
      return seededRandom();
    };
    var tracedConsoleLog = console.log;
    console.log = function () {
      window.__rngTrace.push(window.__rngDraws);
      return tracedConsoleLog.apply(console, arguments);
    };
  }

  // ---- Speed --------------------------------------------------------------
  // 0 also short-circuits Render() ("console only if rapidplay required").
  mainLoopDelay = 0;

  // ---- Disable narration --------------------------------------------------
  // In text mode with narration on, the main loop is re-entered from
  // SpeechSynthesisUtterance.onend — which never fires headless. The
  // checkbox in harness.html is unchecked; enforce belt-and-braces.
  var narration = document.getElementById("narration");
  if (narration) narration.checked = false;

  // ---- Turn tracking ------------------------------------------------------
  // The engine has no global turn counter; ChangePhase flips playerTurn at
  // identifiers "Corp 1.1" / "Runner 1.1". Wrap it (global function, no
  // engine edit) to maintain __harness.turn and per-turn log markers that
  // the serializer synthesizes into its log tail. capturedLog itself is
  // never touched.
  window.__harness.turn = null;
  window.__harness.turnMarkers = [];
  var turnCounts = { corp: 0, runner: 0 };
  window.__harness.turnCounts = turnCounts; // live reference
  // Forward ALL arguments — ChangePhase(src, skipInit); dropping skipInit
  // makes DecisionPhase returns re-run Init forever (caught as a decision
  // storm: 93k decisions, game never ends).
  var engineChangePhase = ChangePhase;
  ChangePhase = function () {
    // Measure the log BEFORE the engine runs the transition: turn-begin
    // triggers log during ChangePhase itself and must render AFTER the
    // marker.
    var preLen = typeof capturedLog !== "undefined" ? capturedLog.length : 0;
    var ret = engineChangePhase.apply(this, arguments);
    var id = currentPhase ? currentPhase.identifier : "";
    var side = id === "Corp 1.1" ? "corp" : id === "Runner 1.1" ? "runner" : null;
    if (side) {
      turnCounts[side]++;
      window.__harness.turn = { side: side, number: turnCounts[side] };
      window.__harness.turnMarkers.push({
        logIndex: preLen, // marker renders above the line at this index
        text: "=== " + (side === "corp" ? "Corp" : "Runner") + " turn " +
          turnCounts[side] + " begins ===",
      });
    }
    return ret;
  };

  // ---- Game end hook ------------------------------------------------------
  // PlayerWin is a global function declaration (utility.js); rebinding the
  // name intercepts every engine call site without touching engine files.
  var enginePlayerWin = PlayerWin;
  PlayerWin = function (player, msgstr) {
    // Freeze the faceoff loop: post-win, the engine offers a "play again"
    // command that the still-active AI will happily resolve —
    // location.reload() mid-poll (observed as "Execution context was
    // destroyed"). pauseFaceoff is the engine's own gate at the top of
    // Main(); with both seats AI it stops all further decisions.
    pauseFaceoff = true;
    if (!window.__harness.done) {
      window.__harness.done = true;
      window.__harness.result = {
        winner: player === corp ? "corp" : "runner",
        reason: String(msgstr),
        corpAgendaPoints: AgendaPoints(corp),
        runnerAgendaPoints: AgendaPoints(runner),
      };
      // Snapshot the log at the moment of the win: lines logged after this
      // point (endgame modal flow) depend on host poll timing, so the
      // determinism comparison uses this snapshot, not the live buffer.
      window.__harness.logAtWin =
        typeof capturedLog !== "undefined" ? capturedLog.slice() : [];
    }
    try {
      return enginePlayerWin(player, msgstr);
    } catch (e) {
      // Post-game UI (modals, achievements/localStorage) must not take the
      // recorded result down with it.
      window.__harness.errors.push("PlayerWin tail: " + String(e));
    }
  };

  // ---- Error capture ------------------------------------------------------
  var engineLogError = typeof LogError === "function" ? LogError : null;
  if (engineLogError) {
    LogError = function (msgstr) {
      window.__harness.errors.push("LogError: " + String(msgstr));
      return engineLogError(msgstr);
    };
  }
  window.addEventListener("error", function (e) {
    window.__harness.errors.push(
      "uncaught: " + e.message + " @ " + e.filename + ":" + e.lineno
    );
  });
  window.addEventListener("unhandledrejection", function (e) {
    window.__harness.errors.push("unhandledrejection: " + String(e.reason));
  });

  // ---- Neutralize particle emitters ---------------------------------------
  // pixi-particles' Emitter.update() draws Math.random per spawned particle
  // and is driven by wall-clock deltas — from the renderer's own
  // requestAnimationFrame loop (interfacerUpdate) as well as per-event
  // effects. With Math.random seeded, that desynchronizes the stream between
  // runs (found via &rngtrace: draws diverging inside t._spawnRect).
  // Headless needs no particles; no-op the update at the prototype.
  if (
    typeof PIXI !== "undefined" &&
    PIXI.particles &&
    PIXI.particles.Emitter
  ) {
    PIXI.particles.Emitter.prototype.update = function () {};
  }

  // ---- Stop frame-driven RNG consumption ----------------------------------
  // Math.random is seeded, but PIXI consumes draws on its ticker (per-frame),
  // and frame counts vary with wall-clock timing — which desynchronizes the
  // seeded stream between otherwise identical runs (observed: HQ hand order
  // diverging after a breach). Text mode needs no animation: stop all tickers
  // once Init() has constructed the renderer. This listener registers after
  // the body onload attribute (Init), so it runs after it.
  window.addEventListener("load", function () {
    try {
      if (typeof cardRenderer !== "undefined" && cardRenderer && cardRenderer.app) {
        cardRenderer.app.ticker.stop();
      }
      if (typeof PIXI !== "undefined") {
        if (PIXI.ticker && PIXI.ticker.shared) PIXI.ticker.shared.stop(); // pixi v4
        if (PIXI.Ticker && PIXI.Ticker.shared) PIXI.Ticker.shared.stop(); // pixi v5+
      }
    } catch (e) {
      window.__harness.errors.push("ticker stop: " + String(e));
    }
  });

  // ---- Progress signal ----------------------------------------------------
  // Wrap both AIs' decision entry points to count decisions; the host uses
  // this as a liveness signal for its stall watchdog. (Same two-method
  // interface the LLMPlayer will implement in M4.)
  function countDecisions(ai) {
    if (!ai || !ai.prototype) return;
    ["CommandChoice", "SelectChoice"].forEach(function (m) {
      var orig = ai.prototype[m];
      if (typeof orig !== "function") return;
      ai.prototype[m] = function () {
        window.__harness.decisions++;
        return orig.apply(this, arguments);
      };
    });
  }
  if (typeof CorpAI === "function") countDecisions(CorpAI);
  if (typeof RunnerAI === "function") countDecisions(RunnerAI);

  window.__harness.started = true;
})();
