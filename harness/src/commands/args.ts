/** Shared command-line plumbing: repository paths, harness/.env loading
 *  and flag parsing. Flags are `--name value`; on/off flags also accept
 *  the bare form (`--live` means on). */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const outDir = join(repoRoot, "harness", "out");

/** harness/.env: KEY=VALUE lines, # comments. Existing environment
 *  variables win. The file is gitignored so API keys stay out of shell
 *  history and the repository. */
export function loadEnvFile(): void {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, "harness", ".env"), "utf-8");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export class Args {
  constructor(private readonly argv: string[]) {}

  /** `--name value`, or `fallback` when absent. */
  str(name: string, fallback: string): string {
    const i = this.argv.indexOf(`--${name}`);
    const v = i > -1 ? this.argv[i + 1] : undefined;
    return v !== undefined && !v.startsWith("--") ? v : fallback;
  }

  int(name: string, fallback: number): number {
    const v = parseInt(this.str(name, String(fallback)), 10);
    return Number.isNaN(v) ? fallback : v;
  }

  /** On/off flag: absent → false, bare → true, `on|off` → as given. */
  flag(name: string): boolean {
    const i = this.argv.indexOf(`--${name}`);
    if (i === -1) return false;
    const v = this.argv[i + 1];
    if (v === undefined || v.startsWith("--")) return true;
    return v !== "off";
  }

  /** Presence of a valueless switch (`--corpus`, `--qualify`). */
  has(name: string): boolean {
    return this.argv.includes(`--${name}`);
  }

  /** Every value of a repeatable flag (`--promote a --promote b`). */
  all(name: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.argv.length; i++) {
      const v = this.argv[i + 1];
      if (this.argv[i] === `--${name}` && v !== undefined && !v.startsWith("--")) out.push(v);
    }
    return out;
  }

  /** First non-flag argument (`golden record`). */
  positional(): string | undefined {
    const v = this.argv[0];
    return v !== undefined && !v.startsWith("--") ? v : undefined;
  }

  get seed(): number {
    return this.int("seed", 1);
  }

  get corp(): string {
    return this.str("corp", "Gateway Corp");
  }

  get runner(): string {
    return this.str("runner", "Gateway Runner");
  }
}

export interface Context {
  repoRoot: string;
  outDir: string;
  args: Args;
}

/** A command returns its exit code; long-running servers resolve on Ctrl-C. */
export type Command = (ctx: Context) => Promise<number>;

export function untilInterrupted(): Promise<void> {
  return new Promise((done) => process.once("SIGINT", () => done()));
}
