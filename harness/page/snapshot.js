/* Board snapshots for the viewer.
 *
 * window.__harness.snapshot(seq, logIndex) → a compact, OMNISCIENT frame
 * of the whole board: every card in every zone with its identity, plus
 * per-card visibility for each seat (PlayerCanLook, the serializer's own
 * choke point), so the viewer can render the omniscient board or either
 * player's view of it. Frames are a reviewer artifact: the host writes
 * them to frames.jsonl and the live stream, never into a model request.
 *
 * Read-only (the same engine reads as serializer.js; no RNG, no state
 * writes) — golden fixtures and seeded games are unaffected.
 *
 * Card reference format: {id: setNumber, u: stable instance id,
 *   v: visibility bits (1 = Runner can see, 2 = Corp can see),
 *   rz: 1 rezzed, fu: 1 faceup, ct: {adv, cr, vir, pow, ag} counters,
 *   str: current strength, sub: [0|1 broken per subroutine],
 *   h: [hosted refs]}.
 * Loaded after serializer.js; plain JS, no host-framework coupling.
 */
(function () {
  "use strict";

  var ids = new WeakMap();
  var nextId = 1;
  function uid(card) {
    var u = ids.get(card);
    if (!u) {
      u = nextId++;
      ids.set(card, u);
    }
    return u;
  }

  var COUNTERS = { advancement: "adv", credits: "cr", virus: "vir", power: "pow", agenda: "ag" };

  function cardRef(card) {
    if (!card) return null;
    var ref = { id: card.setNumber, u: uid(card) };
    var v = 0;
    try { if (PlayerCanLook(runner, card)) v += 1; } catch (e) { /* mid-setup */ }
    try { if (PlayerCanLook(corp, card)) v += 2; } catch (e) { /* mid-setup */ }
    ref.v = v;
    if (card.rezzed) ref.rz = 1;
    if (card.faceUp) ref.fu = 1;
    var ct = null;
    for (var k in COUNTERS) {
      if (typeof card[k] === "number" && card[k] > 0) {
        if (!ct) ct = {};
        ct[COUNTERS[k]] = card[k];
      }
    }
    if (ct) ref.ct = ct;
    if (card.cardType === "ice" || card.cardType === "program") {
      try {
        if (CheckInstalled(card)) ref.str = Strength(card);
      } catch (e) { /* not all cards have strength */ }
    }
    if (card.cardType === "ice" && card.rezzed && card.subroutines && card.subroutines.length) {
      ref.sub = card.subroutines.map(function (s) { return s.broken ? 1 : 0; });
    }
    if (card.hostedCards && card.hostedCards.length) ref.h = card.hostedCards.map(cardRef);
    return ref;
  }

  function pile(cards) {
    return (cards || []).map(cardRef);
  }

  function servers() {
    return [corp.HQ, corp.RnD, corp.archives].concat(corp.remoteServers || []);
  }

  // Public narration since the previous snapshot ([logIndex, kind, text];
  // kind "t" = turn marker, "p" = public line) — the live viewer's log.
  // Same public filter as the serializer's state.log.
  var logSent = 0;
  var markersSent = 0;
  function logDelta() {
    var out = [];
    var src = typeof capturedLog !== "undefined" ? capturedLog : [];
    var isPublic = window.__harness.isPublicLogLine;
    var markers = window.__harness.turnMarkers || [];
    for (; markersSent < markers.length; markersSent++) {
      var m = markers[markersSent];
      out.push([m.logIndex - 0.5, "t", m.text.replace(/^=== | begins ===$/g, "")]);
    }
    for (; logSent < src.length; logSent++) {
      var line = String(src[logSent]).replace(/\n+$/, "");
      if (isPublic && isPublic(line)) out.push([logSent, "p", line.trim()]);
    }
    out.sort(function (a, b) { return a[0] - b[0]; });
    return out;
  }

  window.__harness.snapshot = function (seq, logIndex) {
    try {
      var f = {
        seq: seq,
        li: logIndex,
        turn: window.__harness.turn || null,
        ph: currentPhase ? currentPhase.identifier : null,
        pt: currentPhase ? currentPhase.title : null,
        ap: activePlayer === corp ? "corp" : "runner",
      };
      f.c = {
        id: cardRef(corp.identityCard),
        cr: Credits(corp),
        ck: corp.clickTracker,
        bp: corp.badPublicity || 0,
        pts: AgendaPoints(corp),
        mh: MaxHandSize(corp),
        hq: pile(corp.HQ.cards),
        rd: corp.RnD.cards.length,
        // Top of R&D, top card first — omniscient review only.
        rdTop: pile(corp.RnD.cards.slice(-3).reverse()),
        ar: pile(corp.archives.cards),
        sc: pile(corp.scoreArea),
      };
      if (corp.resolvingCards && corp.resolvingCards.length) f.c.rs = pile(corp.resolvingCards);
      var mu = null;
      try { mu = [InstalledMemoryCost(), MemoryUnits()]; } catch (e) { mu = null; }
      var link = 0;
      try { link = Link(); } catch (e) { link = 0; }
      f.r = {
        id: cardRef(runner.identityCard),
        cr: Credits(runner),
        tmp: runner.temporaryCredits || 0,
        ck: runner.clickTracker,
        tg: runner.tags || 0,
        cd: runner.coreDamage || 0,
        pts: AgendaPoints(runner),
        mh: MaxHandSize(runner),
        grip: pile(runner.grip),
        st: runner.stack.length,
        heap: pile(runner.heap),
        prog: pile(runner.rig.programs),
        hw: pile(runner.rig.hardware),
        res: pile(runner.rig.resources),
        sc: pile(runner.scoreArea),
        mu: mu,
        link: link,
      };
      if (runner.resolvingCards && runner.resolvingCards.length) f.r.rs = pile(runner.resolvingCards);
      if (runner.identityCard && runner.identityCard.setAsideCards && runner.identityCard.setAsideCards.length) {
        f.r.aside = pile(runner.identityCard.setAsideCards);
      }
      f.sv = servers().map(function (s) {
        return { n: ServerName(s), ice: pile(s.ice), root: pile(s.root) };
      });
      if (typeof attackedServer !== "undefined" && attackedServer) {
        f.run = {
          s: servers().indexOf(attackedServer),
          i: typeof approachIce === "number" ? approachIce : -1,
        };
        if (typeof encounteredIce !== "undefined" && encounteredIce) f.run.enc = uid(encounteredIce);
        if (typeof accessingCard !== "undefined" && accessingCard) f.run.acc = cardRef(accessingCard);
      }
      if (typeof removedFromGame !== "undefined" && removedFromGame.length) f.rfg = pile(removedFromGame);
      var lg = logDelta();
      if (lg.length) f.lg = lg;
      return f;
    } catch (e) {
      return null; // a snapshot must never break the game
    }
  };
})();
