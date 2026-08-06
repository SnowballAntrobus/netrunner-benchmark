/** Card reference builder (PHASE1 M4).
 *
 *  Builds the static card-reference block for the system prompt from
 *  carddata/carddata.json (NetrunnerDB dump; codes match engine setNumbers
 *  for SG/SU21). Both decklists are provided — open decklists, mirroring
 *  common NSG tournament practice and reducing the memorized-meta confound.
 *  This is a deliberate, documented information grant made at the prompt
 *  layer; the state serializer's no-cheating invariant is unaffected.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Deck } from "./precons.js";

export interface CardInfo {
  title: string;
  type: string;
  faction: string;
  text: string;
  keywords?: string;
  cost?: number;
  strength?: number;
  memory_cost?: number;
  advancement_cost?: number;
  agenda_points?: number;
  trash_cost?: number;
}

export async function loadCardData(repoRoot: string): Promise<Map<number, CardInfo>> {
  const raw = JSON.parse(
    await readFile(join(repoRoot, "carddata", "carddata.json"), "utf-8")
  ) as { data: Record<string, unknown>[] };
  const map = new Map<number, CardInfo>();
  for (const c of raw.data) {
    const code = parseInt(String(c["code"]), 10);
    if (!Number.isFinite(code)) continue;
    map.set(code, {
      title: String(c["title"]),
      type: String(c["type_code"]),
      faction: String(c["faction_code"]),
      text: String(c["text"] ?? ""),
      keywords: c["keywords"] ? String(c["keywords"]) : undefined,
      cost: typeof c["cost"] === "number" ? c["cost"] : undefined,
      strength: typeof c["strength"] === "number" ? c["strength"] : undefined,
      memory_cost: typeof c["memory_cost"] === "number" ? c["memory_cost"] : undefined,
      advancement_cost:
        typeof c["advancement_cost"] === "number" ? c["advancement_cost"] : undefined,
      agenda_points:
        typeof c["agenda_points"] === "number" ? c["agenda_points"] : undefined,
      trash_cost: typeof c["trash_cost"] === "number" ? c["trash_cost"] : undefined,
    });
  }
  return map;
}

function statLine(info: CardInfo): string {
  const bits: string[] = [`${info.type}`, `${info.faction}`];
  if (info.keywords) bits.push(info.keywords);
  if (info.cost !== undefined) bits.push(`cost ${info.cost}`);
  if (info.strength !== undefined) bits.push(`strength ${info.strength}`);
  if (info.memory_cost !== undefined) bits.push(`${info.memory_cost} MU`);
  if (info.advancement_cost !== undefined) bits.push(`adv req ${info.advancement_cost}`);
  if (info.agenda_points !== undefined) bits.push(`${info.agenda_points} AP`);
  if (info.trash_cost !== undefined) bits.push(`trash cost ${info.trash_cost}`);
  return bits.join(", ");
}

/** One deck as a card-reference section: identity, then each unique card
 *  with count, stats, and full rules text. */
export function deckReference(
  label: string,
  deck: Deck,
  cards: Map<number, CardInfo>
): string {
  const lines: string[] = [`## ${label}: "${deck.name}"`];
  const identity = cards.get(deck.identity);
  if (identity) {
    lines.push(`Identity: ${identity.title} (${statLine(identity)})`);
    if (identity.text) lines.push(`  ${identity.text.replace(/\n/g, " / ")}`);
  }
  const counts = new Map<number, number>();
  for (const id of deck.cards) counts.set(id, (counts.get(id) ?? 0) + 1);
  const entries = [...counts.entries()]
    .map(([id, n]) => ({ id, n, info: cards.get(id) }))
    .sort((a, b) =>
      (a.info?.type ?? "").localeCompare(b.info?.type ?? "") ||
      (a.info?.title ?? "").localeCompare(b.info?.title ?? "")
    );
  for (const { n, info, id } of entries) {
    if (!info) {
      lines.push(`- ${n}x [unknown card ${id}]`);
      continue;
    }
    lines.push(`- ${n}x ${info.title} (${statLine(info)})`);
    if (info.text) lines.push(`    ${info.text.replace(/\n/g, " / ")}`);
  }
  return lines.join("\n");
}
