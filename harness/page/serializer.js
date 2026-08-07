/* Honest state serializer (PHASE1 M3).
 *
 * window.__harness.stateFor(side) → JSON-serializable view of the game from
 * one seat's perspective. Every visibility decision defers to the engine's
 * own honesty choke point, PlayerCanLook(viewer, card) — the serializer
 * never re-implements visibility rules. Seat-agnostic by construction:
 * "runner" and "corp" run the identical code path.
 *
 * With &invariant=1, wraps both AIs' decision entry points and, at every
 * decision, verifies for BOTH viewers that the serialized structural state
 * contains no title of a card the viewer cannot see, and that the log tail
 * contains no private-channel lines. Violations accumulate in
 * window.__harness.invariantViolations.
 *
 * Loaded after bootstrap.js; plain JS, no host-framework coupling.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);

  // ---- card entries -------------------------------------------------------

  // Public-when-installed counters: advancement is visible on facedown
  // cards; the rest only surface on cards the viewer can see anyway, but
  // being on this list is harmless for hidden cards (undefined → omitted).
  var PUBLIC_COUNTERS = ["advancement"];
  var VISIBLE_COUNTERS = ["advancement", "credits", "virus", "power", "agenda"];

  function counterMap(card, names) {
    var out = null;
    for (var i = 0; i < names.length; i++) {
      var v = card[names[i]];
      if (typeof v === "number" && v > 0) {
        if (!out) out = {};
        out[names[i]] = v;
      }
    }
    return out;
  }

  function cardEntry(card, viewer) {
    if (!card) return null;
    var visible = PlayerCanLook(viewer, card);
    var entry;
    if (visible) {
      entry = {
        id: card.setNumber,
        title: card.title,
        cardType: card.cardType,
      };
      if (card.subTypes && card.subTypes.length) entry.subTypes = card.subTypes.slice();
      if (CheckInstalled(card)) {
        entry.installed = true;
        if (card.cardType === "ice" || card.cardType === "program") {
          try { entry.strength = Strength(card); } catch (e) { /* not all have strength */ }
        }
        if (card.player === corp) entry.rezzed = !!card.rezzed;
      }
      if (!IsFaceUp(card)) entry.faceUp = false;
      var counters = counterMap(card, VISIBLE_COUNTERS);
      if (counters) entry.counters = counters;
      if (card.cardType === "ice" && card.rezzed && card.subroutines) {
        entry.subroutines = card.subroutines.map(function (s) {
          return { text: s.text, broken: !!s.broken };
        });
      }
    } else {
      entry = { hidden: true };
      var publicCounters = counterMap(card, PUBLIC_COUNTERS);
      if (publicCounters) entry.counters = publicCounters;
    }
    if (card.hostedCards && card.hostedCards.length) {
      entry.hosted = card.hostedCards.map(function (h) {
        return cardEntry(h, viewer);
      });
    }
    return entry;
  }

  function pileEntries(cards, viewer) {
    return cards.map(function (c) {
      return cardEntry(c, viewer);
    });
  }

  // A hand/pile the viewer may not see into: count + any individually
  // visible cards (e.g. knownToRunner after an access, or the accessed card
  // itself), with their positions.
  function opaquePile(cards, viewer) {
    var out = { count: cards.length, known: [] };
    for (var i = 0; i < cards.length; i++) {
      if (PlayerCanLook(viewer, cards[i])) {
        out.known.push({ index: i, card: cardEntry(cards[i], viewer) });
      }
    }
    if (out.known.length === 0) delete out.known;
    return out;
  }

  // ---- servers ------------------------------------------------------------

  function serverEntry(server, viewer) {
    var entry = { name: ServerName(server) };
    // Engine convention: server.ice[0] is innermost; approach runs from the
    // outermost end. Present outermost-first, keeping the engine index.
    entry.ice = [];
    for (var i = server.ice.length - 1; i >= 0; i--) {
      var e = cardEntry(server.ice[i], viewer);
      e.position = i; // 0 = innermost
      entry.ice.push(e);
    }
    entry.root = pileEntries(server.root, viewer);
    return entry;
  }

  function allServers(viewer) {
    var servers = [
      serverEntry(corp.HQ, viewer),
      serverEntry(corp.RnD, viewer),
      serverEntry(corp.archives, viewer),
    ];
    for (var i = 0; i < corp.remoteServers.length; i++) {
      servers.push(serverEntry(corp.remoteServers[i], viewer));
    }
    return servers;
  }

  // ---- log tail -----------------------------------------------------------

  // The captured console log mixes the public game narration with private
  // channels. Private prefixes: "SPOILER:" (omniscient turn summaries,
  // phase.js), "AI:" (either AI's private reasoning), "[" (decklist dumps at
  // game start), and console noise (PixiJS banner). Everything else logged
  // via Log() is public narration by construction.
  function isPublicLogLine(line) {
    if (typeof line !== "string") return false;
    var t = line.trim();
    if (t === "") return false;
    if (t.indexOf("SPOILER:") === 0) return false;
    if (t.indexOf("AI:") === 0) return false;
    if (t.indexOf("RC:") === 0) return false; // RunCalculator diagnostics (runner-AI private)
    if (t.indexOf("ERROR:") === 0) return false; // engine error channel (surfaced via __harness.errors)
    if (t.indexOf("DEBUG:") === 0) return false; // debug-menu output
    if (t.indexOf("AI would have chosen:") === 0) return false; // testAI shadow mode (M4 agreement metric)
    if (t.indexOf("[") === 0) return false;
    if (t.indexOf("PixiJS") !== -1) return false;
    return true;
    // NOTE: card-trigger announcements also use a "Title:" shape
    // ("Pantograph: Gain 1[c] ... triggered") and are public — filters must
    // stay exact-prefix, never generic "word-colon" (log-corpus audit).
  }

  function publicLogTail(maxLines) {
    var src = typeof capturedLog !== "undefined" ? capturedLog : [];
    // Turn markers (bootstrap.js) are synthesized into the tail at
    // serialization time — capturedLog itself is never mutated, so golden
    // fixtures are unaffected.
    var markerAt = {};
    var markers = (window.__harness && window.__harness.turnMarkers) || [];
    for (var m = 0; m < markers.length; m++) {
      (markerAt[markers[m].logIndex] = markerAt[markers[m].logIndex] || [])
        .push(markers[m].text);
    }
    var out = [];
    // A marker keyed at src.length (turn flipped, nothing logged since)
    // renders at the very end of the tail.
    var pending = markerAt[src.length];
    if (pending) for (var q = 0; q < pending.length; q++) out.push(pending[q]);
    for (var i = src.length - 1; i >= 0 && out.length < maxLines; i--) {
      var line = String(src[i]).replace(/\n+$/, "");
      if (isPublicLogLine(line)) out.unshift(line);
      var ms = markerAt[i];
      if (ms && out.length < maxLines) {
        for (var k = ms.length - 1; k >= 0; k--) out.unshift(ms[k]);
      }
    }
    return out;
  }

  // ---- the state ----------------------------------------------------------

  function playerEntry(player, viewer) {
    var isRunner = player === runner;
    var entry = {
      // Full cardEntry (D02): identities can host counters and cards.
      identity: player.identityCard ? cardEntry(player.identityCard, viewer) : null,
      credits: Credits(player),
      clicks: player.clickTracker,
      maxHandSize: MaxHandSize(player),
      agendaPoints: AgendaPoints(player),
      scored: pileEntries(player.scoreArea, viewer),
    };
    // Events/operations mid-resolution (D02): Play() moves the card to
    // resolvingCards, previously an unserialized zone — an active Overclock
    // (with its hosted credits) was invisible. cardEntry → PlayerCanLook
    // honesty applies as everywhere.
    if (player.resolvingCards && player.resolvingCards.length) {
      entry.resolving = pileEntries(player.resolvingCards, viewer);
    }
    // Set-aside cards live on the identity (e.g. Ayla). PlayerCanLook
    // already knows this zone (owner may look).
    if (
      player.identityCard &&
      player.identityCard.setAsideCards &&
      player.identityCard.setAsideCards.length
    ) {
      entry.setAside = pileEntries(player.identityCard.setAsideCards, viewer);
    }
    if (isRunner) {
      // Run-scoped credits (D02): already INCLUDED in the credits total
      // (Credits() adds them) but lost unspent at run end — surfaced so the
      // ephemeral part of the total is visible. Name matches the engine's
      // public log line ("... unspent temporary credits").
      if (player.temporaryCredits > 0) {
        entry.temporaryCredits = player.temporaryCredits;
      }
      entry.tags = player.tags;
      entry.coreDamage = player.coreDamage;
      entry.grip = viewer === player
        ? pileEntries(player.grip, viewer)
        : opaquePile(player.grip, viewer);
      entry.stackCount = player.stack.length;
      entry.heap = pileEntries(player.heap, viewer); // heap is public
      entry.rig = {
        programs: pileEntries(player.rig.programs, viewer),
        hardware: pileEntries(player.rig.hardware, viewer),
        resources: pileEntries(player.rig.resources, viewer),
      };
      entry.memory = { total: MemoryUnits(), used: InstalledMemoryCost() };
      try { entry.link = Link(); } catch (e) { /* engine Link needs game state */ }
    } else {
      entry.badPublicity = player.badPublicity;
      entry.hq = viewer === player
        ? pileEntries(player.HQ.cards, viewer)
        : opaquePile(player.HQ.cards, viewer);
      // Nobody flips through R&D — opaque for both seats (PlayerCanLook
      // returns false even for the corp; known cards surface via `known`).
      entry.rnd = opaquePile(player.RnD.cards, viewer);
      entry.archives = pileEntries(player.archives.cards, viewer);
    }
    return entry;
  }

  function stateFor(side) {
    var viewer = side === "corp" ? corp : runner;
    var state = {
      viewer: side === "corp" ? "corp" : "runner",
      phase: currentPhase
        ? {
            identifier: currentPhase.identifier,
            title: currentPhase.title,
            activePlayer: activePlayer === corp ? "corp" : "runner",
          }
        : null,
      agendaPointsToWin: AgendaPointsToWin(),
      turn: (window.__harness && window.__harness.turn) || null,
      runner: playerEntry(runner, viewer),
      corp: playerEntry(corp, viewer),
      servers: allServers(viewer),
      run: null,
      log: publicLogTail(30),
    };
    if (attackedServer) {
      state.run = {
        server: ServerName(attackedServer),
        approachIcePosition: approachIce, // 0 = innermost, -1 = none
      };
      if (typeof encounteredIce !== "undefined" && encounteredIce) {
        state.run.encounteredIce = cardEntry(encounteredIce, viewer);
      }
      // The card being accessed (D02): the steal/trash/continue decision's
      // options are bare {} — without this the accessed card appears
      // nowhere in the request. PlayerCanLook grants visibility of the
      // accessed card to any viewer (engine's own rule, utility.js) and we
      // defer to the choke point as everywhere.
      if (typeof accessingCard !== "undefined" && accessingCard) {
        state.run.accessingCard = cardEntry(accessingCard, viewer);
      }
    }
    // RFG zone (D02): live in the current pool — Spin Doctor removes
    // itself from the game. One shared engine array; name matches the
    // "removed from the game" log line.
    if (typeof removedFromGame !== "undefined" && removedFromGame.length) {
      state.removedFromGame = pileEntries(removedFromGame, viewer);
    }
    return state;
  }

  window.__harness.stateFor = stateFor;
  // Card/option description helper for llmplayer.js — same PlayerCanLook
  // honesty as the rest of the serializer.
  window.__harness.cardEntry = function (card, side) {
    return cardEntry(card, side === "corp" ? corp : runner);
  };

  // ---- no-cheating invariant (&invariant=1) -------------------------------

  window.__harness.invariantViolations = [];
  window.__harness.invariantChecks = 0;
  window.__harness.sampleState = null;

  function everyCard() {
    var all = AllCards(corp).concat(AllCards(runner));
    if (corp.identityCard) all.push(corp.identityCard);
    if (runner.identityCard) all.push(runner.identityCard);
    // Zones the engine's AllCards omits but the serializer now emits (D02):
    // keep the checker's census a superset of the serializer's reach.
    if (typeof removedFromGame !== "undefined") all = all.concat(removedFromGame);
    [corp, runner].forEach(function (p) {
      if (p.identityCard && p.identityCard.setAsideCards) {
        all = all.concat(p.identityCard.setAsideCards);
      }
    });
    return all;
  }

  function checkViewer(side, decisionIndex) {
    var viewer = side === "corp" ? corp : runner;
    var state = stateFor(side);
    var log = state.log;
    delete state.log; // titles in public history are legal; check separately
    // phase.title is exempt from the structural check: card abilities create
    // decision phases named after the card (e.g. "Corp 2.1 / Spin Doctor"),
    // and the ability's use was publicly announced via Log() at
    // TriggerAbility — the title names an announced action. It can outlive
    // visibility of the card itself (Spin Doctor shuffles itself into R&D),
    // which is how this surfaced as a false positive on seeds 110/107.
    // phase.identifier (rulebook step) stays checked.
    if (state.phase) {
      state.phase = {
        identifier: state.phase.identifier,
        activePlayer: state.phase.activePlayer,
      };
    }
    // Pristine stringify (harness.html): the engine's global override
    // collapses title-bearing objects — the structural scan must see the
    // full serialized structure, exactly as the host receives it.
    var stringifyFull =
      (window.__pristineJSON && window.__pristineJSON.stringify) || JSON.stringify;
    var json = stringifyFull(state);

    // Structural check: no title of a card the viewer cannot see — unless a
    // same-titled copy is legitimately visible somewhere.
    var visibleTitles = {};
    var hiddenTitles = {};
    var cards = everyCard();
    for (var i = 0; i < cards.length; i++) {
      var t = cards[i].title;
      if (PlayerCanLook(viewer, cards[i])) visibleTitles[t] = true;
      else hiddenTitles[t] = true;
    }
    for (var title in hiddenTitles) {
      if (visibleTitles[title]) continue;
      if (json.indexOf(stringifyFull(title).slice(1, -1)) !== -1) {
        window.__harness.invariantViolations.push({
          decision: decisionIndex,
          viewer: side,
          kind: "hidden-title-in-state",
          detail: title,
          phase: currentPhase
            ? currentPhase.identifier + " / " + currentPhase.title
            : null,
        });
      }
    }

    // Log-tail check: no private-channel lines survived the filter.
    // Deliberately does NOT reuse isPublicLogLine — the checker must stay
    // independent of the filter it audits (a shared predicate made this
    // check tautological; caught by a planted-leak negative test).
    var PRIVATE_LOG_PATTERNS = [
      /^\s*SPOILER:/, /^\s*AI:/, /^\s*RC:/, /^\s*ERROR:/, /^\s*DEBUG:/,
      /^\s*AI would have chosen:/, /^\s*\[/, /PixiJS/,
    ];
    var isPrivate = function (line) {
      for (var p = 0; p < PRIVATE_LOG_PATTERNS.length; p++) {
        if (PRIVATE_LOG_PATTERNS[p].test(line)) return true;
      }
      return false;
    };
    for (var j = 0; j < log.length; j++) {
      if (isPrivate(log[j])) {
        window.__harness.invariantViolations.push({
          decision: decisionIndex,
          viewer: side,
          kind: "private-log-line",
          detail: log[j].slice(0, 120),
        });
      }
    }
    window.__harness.invariantChecks++;
  }

  if (params.get("invariant")) {
    var wrapForInvariant = function (ai) {
      if (!ai || !ai.prototype) return;
      ["CommandChoice", "SelectChoice"].forEach(function (m) {
        var orig = ai.prototype[m];
        if (typeof orig !== "function") return;
        ai.prototype[m] = function () {
          var d = window.__harness.decisions;
          try {
            checkViewer("runner", d);
            checkViewer("corp", d);
            // Keep one mid-game state for human review / fixtures.
            if (!window.__harness.sampleState && d > 250) {
              window.__harness.sampleState = stateFor("runner");
            }
          } catch (e) {
            window.__harness.invariantViolations.push({
              decision: d,
              viewer: "n/a",
              kind: "serializer-error",
              detail: String(e && e.stack ? e.stack : e).slice(0, 300),
            });
          }
          return orig.apply(this, arguments);
        };
      });
    };
    if (typeof CorpAI === "function") wrapForInvariant(CorpAI);
    if (typeof RunnerAI === "function") wrapForInvariant(RunnerAI);
  }
})();
