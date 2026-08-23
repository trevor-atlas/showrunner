import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The local price roster (spec §11.1) — the FALLBACK/estimate path for spend.
 *
 * pi's own reported cost (`Usage.cost.total`) is the primary source; the
 * roster only fills the gap when pi reports no cost (zero or absent). It is a
 * plain, replaceable file at {data_dir}/prices.json:
 *
 *   {
 *     "gpt-4o": { "in_per_mtok": 2.5, "out_per_mtok": 10 },
 *     "claude-3-5-sonnet": { "in_per_mtok": 3, "out_per_mtok": 15 }
 *   }
 *
 * "per_mtok" = USD per million tokens. A missing roster file is the default
 * (no estimates — usd stays null); a malformed file is a config error and
 * fails loudly rather than silently mis-estimating.
 */

/** One model's price: USD per million tokens (input, output). */
export const RosterEntrySchema = z.object({
  in_per_mtok: z.number().nonnegative(),
  out_per_mtok: z.number().nonnegative(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

/** The whole roster: model name → prices. */
export const RosterSchema = z.record(z.string().min(1), RosterEntrySchema);
export type Roster = z.infer<typeof RosterSchema>;

export const PRICES_FILE = "prices.json";

/** {data_dir}/prices.json (§11.1). */
export function pricesPathFor(dataDir: string): string {
  return join(dataDir, PRICES_FILE);
}

/**
 * Load the roster from {data_dir}/prices.json. A missing file reads as the
 * empty roster (no estimates — the primary path, §11.1); a file that is not
 * valid JSON or not the `{ model: { in_per_mtok, out_per_mtok } }` shape
 * throws with the file path — a broken roster is a configuration error, and
 * silently dropping estimates would hide it.
 */
export function loadRoster(dataDir: string): Roster {
  const path = pricesPathFor(dataDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`prices.json at ${path} is not valid JSON: ${messageOf(err)}`);
  }
  try {
    return RosterSchema.parse(parsed);
  } catch (err) {
    throw new Error(`prices.json at ${path} is not a valid roster: ${messageOf(err)}`);
  }
}

/**
 * Estimate the dollar cost of a token delta from the roster (tokens ×
 * per-mtok / 1e6). Returns null when the model has no roster entry — the
 * caller then keeps `usd: null` (never fabricated, §11.1). Cache tokens are
 * deliberately not priced: the roster only knows input/output rates.
 */
export function estimateUsd(
  roster: Roster,
  model: string,
  tokens: { tokens_in: number; tokens_out: number },
): number | null {
  const entry = roster[model];
  if (!entry) return null;
  return (tokens.tokens_in * entry.in_per_mtok + tokens.tokens_out * entry.out_per_mtok) / 1_000_000;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
