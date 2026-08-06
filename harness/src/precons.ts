/** Parse the repo's precon deck files (precons/<name>.js) into the deck JSON
 *  the engine expects in its `r`/`c` URL params:
 *    { identity: <int card id>, cards: [<int card id>, ...], name?: string }
 *  compressed with LZString.compressToEncodedURIComponent (decks.js:LoadDecks).
 *
 *  Precon files are single registerPrecon({...}) calls; we extract fields with
 *  regexes rather than eval (same choice decklauncher.php makes for imports).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import lz from "lz-string";

export interface Deck {
  identity: number;
  cards: number[];
  name: string;
}

export async function loadPrecon(repoRoot: string, preconName: string): Promise<Deck> {
  const file = join(repoRoot, "precons", `${preconName}.js`);
  const src = await readFile(file, "utf-8");

  const idMatch = src.match(/identity:\s*["']?(\d+)["']?/);
  if (!idMatch?.[1]) throw new Error(`no identity in ${file}`);

  const cardsMatch = src.match(/cards:\s*\{([\s\S]*?)\}/);
  if (!cardsMatch?.[1]) throw new Error(`no cards block in ${file}`);

  const cards: number[] = [];
  for (const m of cardsMatch[1].matchAll(/["'](\d+)["']\s*:\s*(\d+)/g)) {
    const id = parseInt(m[1]!, 10);
    const count = parseInt(m[2]!, 10);
    for (let i = 0; i < count; i++) cards.push(id);
  }
  if (cards.length === 0) throw new Error(`empty deck in ${file}`);

  const nameMatch = src.match(/name:\s*["']([^"']+)["']/);
  return { identity: parseInt(idMatch[1], 10), cards, name: nameMatch?.[1] ?? preconName };
}

/** The exact encoding LoadDecks() reverses. */
export function encodeDeckParam(deck: Deck): string {
  return lz.compressToEncodedURIComponent(
    JSON.stringify({ identity: deck.identity, cards: deck.cards, name: deck.name })
  );
}
