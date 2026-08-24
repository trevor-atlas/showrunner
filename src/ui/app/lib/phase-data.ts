/**
 * The shared server-only gather module for the phase drill-in surfaces.
 *
 * Both the phase-card JSON proxies (phases/controller.tsx) and the run-detail
 * render path (runs/controller.tsx, ticket 11) consume THIS module — never each
 * other — so the aggregation for each surface lives in exactly one place and
 * the `phases → runs` render import never has to point back the other way (no
 * import cycle). Every derivation here reuses the canonical helper (the api
 * core's SQL-SUM spend, handoff.ts's fs readers, blueprint-snapshot.ts) rather
 * than re-summing or re-copying per use-case.
 *
 * Server-only, like app/lib/daemon.ts and app/lib/blueprint-snapshot.ts: it
 * reaches for node:fs, the daemon api core, and @showrunner/core, so the
 * browser never imports it — the remix ACTIONS do, in-process.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { resolveDataDir, runDirFor } from "../../../core/index.ts";
import { readHandoffInputs, readOutputsDir } from "../../../daemon/handoff.ts";
import { readBlueprintSnapshot, type SnapshotPhase } from "./blueprint-snapshot.ts";
import { getSpend } from "./daemon.ts";

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
 * Resolve each context entry the way the daemon did at run time
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

// ── gather functions (one per proxy; reused by the show action) ──────────────

/**
 * Is this phase first in BLUEPRINT order? The snapshot doc is the authoritative
 * declared order (RunDetail.phases is started_at order, which NULL-sorts pending
 * phases first). `detailFirstName` is the started_at-order fallback for
 * fixture/observation runs that never wrote a snapshot.
 */
export function isFirstBlueprintPhase(
  runId: string,
  phaseName: string,
  detailFirstName: string | undefined,
): boolean {
  const { doc } = readBlueprintSnapshot(runId);
  if (doc !== null && doc.phases.length > 0) return doc.phases[0]!.name === phaseName;
  return detailFirstName === phaseName;
}

/**
 * The phase's blueprint-snapshot config with its context entries pre-resolved.
 * `phase === null` is the card's "no blueprint snapshot" state. `isFirst` is
 * blueprint order (the snapshot's declared order), with `detailFirstName` as the
 * fixture-run fallback.
 */
export function gatherPhaseSnapshot(
  runId: string,
  phaseName: string,
  cwd: string,
  detailFirstName: string | undefined,
): PhaseSnapshotData {
  const { doc } = readBlueprintSnapshot(runId);
  const phase = doc?.phases.find((p) => p.name === phaseName) ?? null;
  const moduleDir =
    doc?.module !== null && doc?.module !== undefined && doc.module !== "" ? dirname(doc.module) : null;
  const context = phase !== null ? describeContextEntries(phase.agent.context, cwd, moduleDir) : [];
  const isFirst =
    doc !== null && doc.phases.length > 0 ? doc.phases[0]!.name === phaseName : detailFirstName === phaseName;
  return { phase, moduleDir, context, isFirst };
}

/**
 * The materialized inputs for this phase (handoff.ts readHandoffInputs), each
 * file's contents clipped at INPUT_CONTENTS_CAP. The first phase has no
 * predecessor, so `files` is empty and `isFirst` labels the "none" state.
 */
export function gatherPhaseInputs(runId: string, phaseName: string, isFirst: boolean): PhaseInputsData {
  const runDir = runDirFor(resolveDataDir(), runId);
  const files = readHandoffInputs(runDir, phaseName).map(({ rel, contents }) => {
    if (contents.length > INPUT_CONTENTS_CAP) {
      return { rel, contents: contents.slice(0, INPUT_CONTENTS_CAP), truncated: true };
    }
    return { rel, contents, truncated: false };
  });
  return { files, isFirst };
}

/** The phase's outputs/ dir listing + FINDINGS.md (handoff.ts readOutputsDir). */
export function gatherPhaseOutputs(runId: string, phaseName: string): PhaseOutputsData {
  const runDir = runDirFor(resolveDataDir(), runId);
  return readOutputsDir(runDir, phaseName);
}

/**
 * The phase's spend, looked up by phase id off the api core's spend breakdown.
 * The SQL SUM is exact — there is no event sweep and no truncated flag (issue
 * #29 moved the derivation into the core; the old UI cap is gone).
 */
export async function gatherPhaseSpend(runId: string, phaseId: string): Promise<PhaseSpendData> {
  const spend = await getSpend(runId);
  const phase = spend.phases.find((p) => p.id === phaseId);
  return {
    tokensIn: phase?.tokens_in ?? 0,
    tokensOut: phase?.tokens_out ?? 0,
    cacheRead: phase?.cache_read ?? 0,
    cacheWrite: phase?.cache_write ?? 0,
    spendUsd: phase?.spend_usd ?? 0,
    estimatedUsd: phase?.estimated_spend_usd ?? 0,
  };
}
