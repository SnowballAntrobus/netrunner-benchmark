// Project page data: game gallery, results table, card-pool summary — all
// from data/index.json, written by `npx tsx src/cli.ts site`.

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

const SEAT = { corp: "Corp", runner: "Runner" };
const usd = (v) => (v === null || v === undefined ? "—" : `$${v.toFixed(2)}`);

/** Display name: the OpenRouter routing prefix is plumbing, not a name. */
const shortModel = (m) => m.replace(/^openrouter\//, "");

function modelsLabel(game) {
  return game.seats.map((s) => `${shortModel(s.model)} (${SEAT[s.seat]})`).join(" vs ");
}

/** Did the model(s) win? One seat: that seat's outcome; both: winner. */
function outcome(game) {
  if (game.status !== "completed") return { text: game.status, cls: "" };
  if (game.seats.length === 1) {
    const won = game.winner === game.seats[0].seat;
    return { text: won ? "won" : "lost", cls: won ? "win" : "loss" };
  }
  const w = game.seats.find((s) => s.seat === game.winner);
  return { text: w ? `${w.model} won` : `${game.winner} won`, cls: "" };
}

function viewerHref(game) {
  return `./viewer/?game=../${game.bundle}`;
}

function renderGallery(games) {
  const ul = $("#gallery");
  ul.replaceChildren();
  const playable = games.filter((g) => g.bundle);
  if (!playable.length) {
    ul.appendChild(el("li", "table-note", "No games with board snapshots yet."));
    return;
  }
  playable
    .sort((a, b) => (b.decisions ?? 0) - (a.decisions ?? 0))
    .forEach((g) => {
      const li = el("li");
      const a = el("a", "game-card");
      a.href = viewerHref(g);
      const m = el("span", "gc-model");
      g.seats.forEach((s, i) => {
        if (i) m.appendChild(document.createTextNode(" vs "));
        m.appendChild(el("span", `seat-dot ${s.seat}`));
        m.appendChild(document.createTextNode(shortModel(s.model)));
      });
      a.appendChild(m);
      a.appendChild(el("span", "gc-meta", `${g.seats.map((s) => SEAT[s.seat]).join(" + ")} · ${g.corpPrecon} vs ${g.runnerPrecon} · seed ${g.seed}`));
      const o = outcome(g);
      const r = el("span", "gc-result");
      r.appendChild(el("span", o.cls, o.text));
      r.appendChild(document.createTextNode(` — ${g.reason ?? ""} · ${g.corpAP ?? "?"}–${g.runnerAP ?? "?"} · ${g.corpTurns ?? "?"} turns`));
      a.appendChild(r);
      li.appendChild(a);
      ul.appendChild(li);
    });
}

function renderTable(games) {
  const tbody = $("#games-table tbody");
  tbody.replaceChildren();
  games
    .slice()
    .sort((a, b) => a.era - b.era || modelsLabel(a).localeCompare(modelsLabel(b)))
    .forEach((g) => {
      const tr = el("tr");
      const th = el("th");
      th.scope = "row";
      if (g.bundle) {
        const a = el("a", null, modelsLabel(g));
        a.href = viewerHref(g);
        th.appendChild(a);
      } else th.textContent = modelsLabel(g);
      tr.appendChild(th);
      tr.appendChild(el("td", null, `${g.corpPrecon} vs ${g.runnerPrecon} · seed ${g.seed}`));
      const o = outcome(g);
      const td = el("td");
      td.appendChild(el("span", o.cls, o.text));
      td.appendChild(document.createTextNode(` — ${g.reason ?? ""}`));
      tr.appendChild(td);
      tr.appendChild(el("td", "num", `${g.corpAP ?? "?"}–${g.runnerAP ?? "?"}`));
      tr.appendChild(el("td", "num", String(g.corpTurns ?? "—")));
      tr.appendChild(el("td", "num", g.seats.map((s) => s.llmDecisions).join(" + ")));
      const cost = g.seats.map((s) => s.costUsd).filter((c) => c !== null);
      tr.appendChild(el("td", "num", cost.length ? usd(cost.reduce((a, b) => a + b, 0)) : "—"));
      tbody.appendChild(tr);
    });
  const eras = [...new Set(games.map((g) => g.era))].sort();
  if (eras.length && window.__siteData) {
    const labels = eras.map((e) => window.__siteData.eras[e]).filter(Boolean);
    $("#games-note").textContent += ` Interface era: ${labels.join("; ")} — games are comparable only within an era.`;
  }
}

function renderPool(pool) {
  if (!pool) return;
  const span = $("#pool-summary");
  const q = pool.qualified;
  span.textContent =
    `${q.corp + q.runner} of ${pool.total} decks currently qualify (${q.corp} Corp, ${q.runner} Runner); ` +
    `the rest hit engine defects such as crashes or stalls and are refused unless explicitly allowed`;
}

async function main() {
  try {
    const res = await fetch("./data/index.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    window.__siteData = data;
    renderGallery(data.games);
    renderTable(data.games);
    renderPool(data.pool);
  } catch (err) {
    const msg = `Could not load the game index (${err}). Build it with \`npx tsx src/cli.ts site\`.`;
    $("#gallery").replaceChildren(el("li", "table-note", msg));
    const td = el("td", "table-note", msg);
    td.colSpan = 7;
    const tr = el("tr");
    tr.appendChild(td);
    $("#games-table tbody").replaceChildren(tr);
  }
}

main();
