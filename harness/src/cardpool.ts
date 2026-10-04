/** Card pool (D16): which engine set files a game needs.
 *
 *  harness.html statically loads the base pool — System Gateway, System
 *  Update 2021 and the tutorial set (what every golden fixture uses).
 *  Decks built on other sets (Elevation, Midnight Sun, the partial Core
 *  set, ...) need those set files too; the page loads them on demand from
 *  `&sets=a,b` (document.write'd right after the base sets, so engine
 *  load order is preserved). Base-pool games pass no param and load
 *  byte-identically to before.
 *
 *  Membership is derived from the set files themselves (every
 *  `cardSet[N] =` / `coreSet[N] =` definition), never from a precon's
 *  self-declared `sets` field — the definitions are what the engine runs.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Deck } from "./precons.js";

/** Loaded statically by harness.html — never passed in &sets=. */
export const BASE_SETS = ["systemgateway", "systemupdate2021", "tutorial"];

let indexCache: { root: string; index: Map<number, string> } | null = null;

/** card id → set file basename (first definition wins, in file order). */
export async function cardSetIndex(repoRoot: string): Promise<Map<number, string>> {
  if (indexCache && indexCache.root === repoRoot) return indexCache.index;
  const dir = join(repoRoot, "sets");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".js")).sort();
  // Base sets first so a reprint defined in two files maps to the base one.
  files.sort(
    (a, b) =>
      Number(!BASE_SETS.includes(a.replace(/\.js$/, ""))) -
        Number(!BASE_SETS.includes(b.replace(/\.js$/, ""))) || a.localeCompare(b)
  );
  const index = new Map<number, string>();
  for (const file of files) {
    const name = file.replace(/\.js$/, "");
    const src = await readFile(join(dir, file), "utf-8");
    for (const m of src.matchAll(/\b(?:cardSet|coreSet)\[(\d+)\]\s*=/g)) {
      const id = parseInt(m[1]!, 10);
      if (!index.has(id)) index.set(id, name);
    }
  }
  indexCache = { root: repoRoot, index };
  return index;
}

export interface PoolCheck {
  sets: string[]; // extra set files needed, in load order
  missing: number[]; // card ids no set file defines (unplayable deck)
}

/** The extra set files (beyond BASE_SETS) the given decks need, plus any
 *  card ids no set defines. */
export async function checkPool(repoRoot: string, decks: Deck[]): Promise<PoolCheck> {
  const index = await cardSetIndex(repoRoot);
  const sets = new Set<string>();
  const missing = new Set<number>();
  for (const deck of decks) {
    for (const id of [deck.identity, ...deck.cards]) {
      const set = index.get(id);
      if (set === undefined) missing.add(id);
      else if (!BASE_SETS.includes(set)) sets.add(set);
    }
  }
  return { sets: [...sets].sort(), missing: [...missing].sort((a, b) => a - b) };
}

/** Like checkPool, but a deck with undefined cards is an error: the
 *  engine would silently drop them (InstanceCard returns null). */
export async function requiredSets(repoRoot: string, decks: Deck[]): Promise<string[]> {
  const check = await checkPool(repoRoot, decks);
  if (check.missing.length > 0) {
    const names = decks.map((d) => d.name).join(" / ");
    throw new Error(
      `${names}: ${check.missing.length} card(s) not implemented in any set file ` +
        `(${check.missing.slice(0, 8).join(", ")}${check.missing.length > 8 ? ", ..." : ""}) ` +
        "— see `cli.ts pool` for playable decks"
    );
  }
  return check.sets;
}

/** URL fragment for harness.html / inspect.html (empty for the base pool). */
export function setsParam(sets: string[]): string {
  return sets.length > 0 ? `&sets=${sets.join(",")}` : "";
}
