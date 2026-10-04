// Game model for the board viewer — pure data, no DOM, ES module.
//
// One implementation shared by the browser viewer (recorded bundles and the
// live stream) and the Node exporter (`cli.ts site`), which writes the same
// model to site/data/games/<id>.json. Inputs are the harness's own artifacts:
// record.json, decisions.jsonl rows, frames.jsonl, debrief.json, and the
// NetrunnerDB card data (carddata/carddata.json).

export const MODEL_VERSION = 1;

/** Private log channels — never public narration (same list the harness's
 *  serializer filters; "AI:" lines are kept separately as rules-AI notes). */
const PRIVATE = /^\s*(SPOILER:|RC:|ERROR:|DEBUG:|AI would have chosen:|\[)/;

const FACTION = {
  "haas-bioroid": "hb",
  jinteki: "jinteki",
  nbn: "nbn",
  "weyland-consortium": "weyland",
  "neutral-corp": "neutral",
  anarch: "anarch",
  criminal: "criminal",
  shaper: "shaper",
  "neutral-runner": "neutral",
};

/** Compact card dictionary entry from a NetrunnerDB record. */
export function cardInfo(c) {
  const out = {
    t: c.title,
    ty: c.type_code,
    s: c.side_code,
    f: FACTION[c.faction_code] ?? "neutral",
  };
  if (c.keywords) out.st = c.keywords;
  if (typeof c.cost === "number") out.c = c.cost;
  if (typeof c.strength === "number") out.str = c.strength;
  if (typeof c.advancement_cost === "number") out.adv = c.advancement_cost;
  if (typeof c.agenda_points === "number") out.ap = c.agenda_points;
  if (typeof c.trash_cost === "number") out.tc = c.trash_cost;
  if (typeof c.memory_cost === "number") out.mu = c.memory_cost;
  if (typeof c.base_link === "number") out.link = c.base_link;
  if (c.text) out.tx = c.text;
  return out;
}

/** Card dictionary for the given ids from carddata.json's `data` array. */
export function cardDictionary(carddata, ids) {
  const want = new Set(ids.map(Number));
  const out = {};
  for (const c of carddata) {
    const id = parseInt(c.code, 10);
    if (want.has(id)) out[id] = cardInfo(c);
  }
  return out;
}

/** Every card id a frame references (for building the dictionary live). */
export function frameCardIds(frame, into = new Set()) {
  const visit = (ref) => {
    if (!ref) return;
    into.add(ref.id);
    if (ref.h) ref.h.forEach(visit);
  };
  const piles = (o, keys) => keys.forEach((k) => (o[k] || []).forEach(visit));
  if (frame.c) {
    visit(frame.c.id);
    piles(frame.c, ["hq", "rdTop", "ar", "sc", "rs"]);
  }
  if (frame.r) {
    visit(frame.r.id);
    piles(frame.r, ["grip", "heap", "prog", "hw", "res", "sc", "rs", "aside"]);
  }
  (frame.sv || []).forEach((s) => {
    s.ice.forEach(visit);
    s.root.forEach(visit);
  });
  if (frame.run && frame.run.acc) visit(frame.run.acc);
  (frame.rfg || []).forEach(visit);
  return into;
}

/** Display label for one menu entry as the model saw it (mirrors the
 *  formatter's optionLabel: verb + subject + committed second step). */
export function optionLabel(o) {
  if (!o || typeof o !== "object") return String(o);
  // A bare engine option ({} — "go on") carries nothing but its index.
  if (Object.keys(o).every((k) => k === "index")) return "continue";
  const card = o.card && typeof o.card === "object" ? o.card : {};
  const primary =
    o.command || o.label || o.button || card.title ||
    (card.hidden ? "(hidden card)" : null) || o.text || `option ${o.index}`;
  const bits = [primary];
  if (o.command && primary === o.command) {
    const subject = o.label || card.title;
    if (subject) bits.push(subject);
    else if (card.hidden) bits.push("(hidden card)");
  }
  if (o.server && !o.label) bits.push(`→ ${o.server}`);
  if (o.then) {
    const t = o.then;
    bits.push(`→ then: ${t.label || t.server || (t.card && t.card.title) || "…"}`);
  }
  return bits.join(" ");
}

function optionEntry(o) {
  const entry = { l: optionLabel(o) };
  if (o && o.card && typeof o.card.id === "number") entry.id = o.card.id;
  if (o && typeof o.description === "string" && o.description !== o.command) entry.d = o.description;
  return entry;
}

/** One viewer step from a decisions.jsonl row (decision or compaction). */
export function stepFromRow(row) {
  if (row.record_type === "compaction") {
    return {
      k: "c",
      seat: row.seat || "runner",
      id: row.compaction_id,
      seqBefore: row.seq_before,
      li: row.log_index ?? null,
      turn: row.turn || null,
      tokens: row.transcript_tokens_before ?? null,
      dropped: row.dropped_turns,
      kept: row.kept_turns,
      text: row.summary,
      truncated: !!row.summary_truncated,
    };
  }
  const step = {
    k: "d",
    seq: row.seq,
    seat: row.seat,
    dt: row.decision_type,
    ph: row.phase ? row.phase.identifier || "" : "",
    pt: row.phase ? row.phase.title || "" : "",
    turn: row.turn || null,
    li: row.log_index ?? null,
    opts: (row.options || []).map(optionEntry),
    ch: row.choice,
  };
  if (row.model) step.model = row.model;
  if (row.reasoning) step.rs = row.reasoning;
  if (row.forced) step.forced = 1;
  if (row.compound_fulfilled) step.fulfilled = 1;
  if (row.order_folded) step.folded = 1;
  if (row.retries) step.retries = row.retries;
  if (row.fallback) step.fallback = 1;
  if (row.transcript_tokens) step.ctx = row.transcript_tokens;
  if (row.multi_select) step.multi = { slot: row.multi_select.slot, of: row.multi_select.of };
  if (row.preview_divergence) step.divergence = 1;
  if (row.state && row.state.run) {
    // The deciding seat's run context (fills gaps in replayed frames).
    step.run = row.state.run.server;
  }
  return step;
}

/** True for a step the model actually answered (an API decision). */
export function isModelStep(step) {
  return step.k === "d" && !!step.model;
}

/** True for steps a reviewer usually skips (no decision was made). */
export function isAutoStep(step) {
  if (step.k !== "d") return false;
  if (step.forced || step.fulfilled || step.folded) return true;
  return !step.model && step.opts.length <= 1;
}

/** Public narration + rules-AI notes + turn markers, keeping log indices. */
export function narration(log) {
  const out = [];
  const turns = { Corp: 0, Runner: 0 };
  log.forEach((raw, i) => {
    const line = String(raw).replace(/\n+$/, "").trim();
    if (!line) return;
    const turn = line.match(/^SPOILER: At start of (Corp|Runner) turn:/);
    if (turn) {
      turns[turn[1]]++;
      out.push([i, "t", `${turn[1]} turn ${turns[turn[1]]}`]);
      return;
    }
    if (line.startsWith("AI:")) {
      out.push([i, "a", line.slice(3).trim()]);
      return;
    }
    if (PRIVATE.test(line) || /PixiJS/.test(line)) return;
    out.push([i, "p", line]);
  });
  return out;
}

/** The board part of a frame (what dedupe compares and the viewer draws). */
export function boardOf(frame) {
  const b = { c: frame.c, r: frame.r, sv: frame.sv };
  if (frame.run) b.run = frame.run;
  if (frame.rfg) b.rfg = frame.rfg;
  return b;
}

/** Incremental model builder — feed rows and frames in any interleaving
 *  (the live stream sends a frame just before its decision row). */
export class GameBuilder {
  constructor(meta, cards) {
    this.game = {
      v: MODEL_VERSION,
      meta: meta || {},
      cards: cards || {},
      log: [],
      steps: [],
      frames: [],
      debrief: [],
    };
    this.frameBySeq = new Map(); // seq → frame index
    this.lastKey = null;
    this.lastFrame = -1;
  }

  addFrame(frame) {
    if (!frame) return;
    const board = boardOf(frame);
    const key = JSON.stringify(board);
    if (key !== this.lastKey) {
      this.game.frames.push(board);
      this.lastKey = key;
    }
    this.lastFrame = this.game.frames.length - 1;
    if (typeof frame.seq === "number") this.frameBySeq.set(frame.seq, this.lastFrame);
  }

  addRow(row) {
    const step = stepFromRow(row);
    if (step.k === "d") {
      const f = this.frameBySeq.get(step.seq);
      step.fr = f !== undefined ? f : Math.max(0, this.lastFrame);
    } else {
      step.fr = Math.max(0, this.lastFrame);
    }
    this.game.steps.push(step);
    return step;
  }

  /** Close the game: result step on the final frame. */
  finish(result) {
    this.game.steps.push({ k: "end", fr: Math.max(0, this.game.frames.length - 1), ...(result || {}) });
  }
}

/** Build a whole game model from recorded artifacts. */
export function buildGame({ record, rows, frames, debrief, carddata }) {
  const meta = metaFromRecord(record);
  const ids = new Set();
  (frames || []).forEach((f) => frameCardIds(f, ids));
  for (const id of record.corpDeckIds || []) ids.add(id);
  for (const id of record.runnerDeckIds || []) ids.add(id);
  const builder = new GameBuilder(meta, carddata ? cardDictionary(carddata, [...ids]) : {});
  // Frames and rows interleave by seq: a decision's frame was captured
  // just before its row was written.
  const fs = [...(frames || [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  let fi = 0;
  for (const row of rows) {
    const seq = row.record_type === "compaction" ? row.seq_before : row.seq;
    while (fi < fs.length && (fs[fi].seq ?? 0) <= seq) builder.addFrame(fs[fi++]);
    builder.addRow(row);
  }
  while (fi < fs.length) builder.addFrame(fs[fi++]);
  builder.game.log = narration(record.log || []);
  builder.game.debrief = debriefEntries(debrief);
  builder.finish({ winner: record.winner, reason: record.reason });
  return builder.game;
}

export function debriefEntries(debrief) {
  if (!debrief) return [];
  const list = debrief.seats || [debrief];
  return list
    .filter((d) => d && d.text)
    .map((d) => ({ seat: d.seat || "runner", model: d.model || null, text: d.text }));
}

export function metaFromRecord(record) {
  const llmSeat = record.llmSeat || "runner";
  const seats = {};
  if (record.seats && Object.keys(record.seats).length) {
    for (const s of ["corp", "runner"]) {
      if (record.seats[s]) {
        const { model, driver, client } = record.seats[s];
        seats[s] = { model, driver: driver || "api", client: client || null };
      }
    }
  } else {
    seats.runner = { model: record.model };
  }
  return {
    id: record.gameId || null,
    seed: record.seed,
    corpPrecon: record.corpPrecon,
    runnerPrecon: record.runnerPrecon,
    llmSeat,
    seats,
    status: record.status,
    winner: record.winner ?? null,
    reason: record.reason ?? null,
    corpAP: record.corpAgendaPoints ?? null,
    runnerAP: record.runnerAgendaPoints ?? null,
    turns: record.turns || null,
    aiBranches: record.aiBranches || null,
    cardSets: record.cardSets || [],
    actions: record.actions || null,
    contextMode: record.contextMode || null,
    decisionView: record.decisionView || null,
    durationMs: record.durationMs ?? null,
  };
}
