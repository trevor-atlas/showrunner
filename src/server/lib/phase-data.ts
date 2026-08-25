/**
 * Shared context-entry resolution + the phase-data response shapes.
 *
 * The phase-record assembly now lives in one place — the phase-record
 * view-model (src/view-models/phase-record.ts), the single owner of a phase
 * read (#47–#49). This module keeps only what that assembler and the phase
 * cards both reuse: `describeContextEntries` (the CONFIG card's {raw, kind,
 * entry} resolution), the per-surface response interfaces (snapshot/inputs/
 * outputs/spend), and the input-preview cap.
 *
 * Server-only for the fs-touching resolver (node:fs), so the browser never
 * imports it; the type-only exports are safe anywhere.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { SnapshotPhase } from "./blueprint-snapshot.ts";

// ── context-entry resolution (relocated from config-card.tsx) ────────────────

export type ContextEntryKind = "inlined-file" | "literal";

export interface ContextEntry {
  /** the raw snapshot entry text */
  raw: string;
  kind: ContextEntryKind;
  /** rendered text: "README.md (inlined)" for files, quoted literals otherwise */
  entry: string;
}

/**
 * Resolve each context entry the way the server did at run time
 * (handoff.ts resolveContextFile: cwd first, then the blueprint module dir):
 * an entry that resolves to an existing file is marked "(inlined)"; anything
 * else was passed through as a literal. Best-effort — files may have changed
 * since the snapshot, so this is the current-resolution view. Pre-resolved
 * here so the CONFIG card receives {raw, kind, entry} and never touches disk.
 */
export function describeContextEntries(
  entries: readonly string[],
  cwd: string,
  moduleDir: string | null,
): ContextEntry[] {
  return entries.map((raw) => {
    const file = resolveContextFile(cwd, moduleDir, raw);
    if (file !== null) {
      return { raw, kind: "inlined-file", entry: `${raw} (inlined)` };
    }
    return { raw, kind: "literal", entry: `"${raw}"` };
  });
}

function resolveContextFile(cwd: string, moduleDir: string | null, entry: string): string | null {
  const candidates: string[] = [];
  if (isAbsolute(entry)) {
    candidates.push(entry);
  } else {
    candidates.push(join(cwd, entry));
    if (moduleDir !== null) candidates.push(join(moduleDir, entry));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // keep walking
    }
  }
  return null;
}

// ── the four proxy response shapes ───────────────────────────────────────────

/** snapshot.json — the phase's snapshot config + pre-resolved context. */
export interface PhaseSnapshotData {
  /** the phase's SnapshotPhase (agent + budget/require_approval/on_fail/gates/
   * envelope), or null for fixture/observation runs with no readable snapshot */
  phase: SnapshotPhase | null;
  /** dirname of the snapshot's blueprint module (context fallback dir) */
  moduleDir: string | null;
  /** context entries resolved to {raw, kind, entry} at request time */
  context: ContextEntry[];
  /** first phase in blueprint order (the INPUTS "none" label depends on it) */
  isFirst: boolean;
}

/** one materialized input file for inputs.json (contents defensively capped). */
export interface PhaseInputFile {
  rel: string;
  contents: string;
  /** true when `contents` was clipped at the per-file cap */
  truncated: boolean;
}

/** inputs.json — the materialized predecessor handoff for this phase. */
export interface PhaseInputsData {
  files: PhaseInputFile[];
  isFirst: boolean;
}

/** outputs.json — the phase's outputs/ dir (pure filesystem). */
export interface PhaseOutputsData {
  files: string[];
  findingsMd: string | null;
}

/** spend.json — per-phase token/USD totals off the api core's exact SQL SUM. */
export interface PhaseSpendData {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  spendUsd: number;
  estimatedUsd: number;
}

/**
 * Defensive per-file cap on inlined input contents: 16KB. A handoff artifact
 * can be arbitrarily large; the drill-in only previews it, so clip and flag
 * rather than shipping megabytes over the proxy (settled).
 */
export const INPUT_CONTENTS_CAP = 16 * 1024;
