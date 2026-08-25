/**
 * The blueprint snapshot — the run's CONFIG source of truth for the
 * phase drill-in ("from the run's blueprint snapshot, not the live
 * blueprint — what actually ran").
 *
 * The server snapshots the RENDERED configuration at submit time into
 * `{data_dir}/runs/<run_id>/blueprint.json` (src/server/engine/runner.ts
 * `snapshotBlueprint`, record files). There is NO server HTTP endpoint for
 * it (the table stops at /raw) — the drill-in reads the file the same
 * way the server's own resume path does (runner.ts `prepareResume`), from the
 * data dir resolved by the same @showrunner/core helper the server client
 * uses. Later edits to the live blueprint module never reach this file.
 *
 * Browser never imports this module (server-side only, like src/server/lib/model.ts).
 */
import { readFileSync } from "node:fs";

import { resolveDataDir, runDirFor } from "../../core/index.ts";

/** The rendered agent configuration — exactly the snapshot shape. */
export interface SnapshotAgent {
  name: string;
  model: string;
  prompt: string;
  tools: string[];
  context: string[];
}

/** One phase of the snapshot. */
export interface SnapshotPhase {
  name: string;
  agent: SnapshotAgent;
  budget: number;
  require_approval: boolean;
  on_fail: string | null;
  /** gates by name, in declared order */
  gates: string[];
  envelope: unknown;
}

/** The blueprint.json document, as written by snapshotBlueprint(). */
export interface BlueprintSnapshotDoc {
  name: string;
  /** the blueprint module path (null for non-module runs, e.g. fixtures) */
  module: string | null;
  args: string[] | null;
  max_visits: number;
  phases: SnapshotPhase[];
  hooks: { onPhaseStart: boolean; onPhaseEnd: boolean };
}

export interface SnapshotReadResult {
  /** the parsed snapshot, or null when the run has no readable snapshot */
  doc: BlueprintSnapshotDoc | null;
}

/**
 * Read a run's blueprint snapshot from disk. Returns null when the file
 * is missing or unreadable (fixture/observation runs never write one) — the
 * CONFIG card then renders a "no snapshot" note instead of fabricating data.
 */
export function readBlueprintSnapshot(runId: string): SnapshotReadResult {
  const dataDir = resolveDataDir();
  const path = joinSnapshotPath(dataDir, runId);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { doc: null };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { phases?: unknown }).phases)) {
      return { doc: null };
    }
    return { doc: parsed as BlueprintSnapshotDoc };
  } catch {
    return { doc: null };
  }
}

/** {data_dir}/runs/<run_id>/blueprint.json — exported for tests/visibility. */
export function snapshotPathFor(dataDir: string, runId: string): string {
  return joinSnapshotPath(dataDir, runId);
}

function joinSnapshotPath(dataDir: string, runId: string): string {
  return `${runDirFor(dataDir, runId)}/blueprint.json`;
}
