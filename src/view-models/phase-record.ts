/**
 * The phase-record view-model — the ONE owner of a phase read (#47).
 *
 * `buildPhaseRecordModel` assembles a single phase's record from two
 * persistence handles: a SQLite connection and the run's data dir. It is a
 * PURE data-assembly layer — ids + handles in, serializable shapes out. No
 * SQL is written here (it calls db.ts readers), no HTTP/routing, no React, no
 * writes, no commands, no view state. It reproduces exactly the fields the six
 * phase proxies serve today (phases/controller.tsx): snapshot/context, inputs,
 * outputs, spend, envelopes, gates, and visit history.
 *
 * The gathers are ported from app/lib/phase-data.ts and the api core's
 * per-phase reads (server.ts apiSpend/apiPhaseEnvelopes/apiPhaseGates), reusing
 * the canonical readers rather than re-summing or re-copying: db.ts's SQL
 * readers, handoff.ts's filesystem readers, blueprint-snapshot.ts's snapshot
 * reader, and phase-data.ts's context-entry / input-cap helpers.
 *
 * Server-only (it reaches for the daemon db + node:fs via those readers), and —
 * for now — dead code: nothing imports it yet (#48 wires the controller to it).
 */
import type { Database } from "bun:sqlite";
import { dirname } from "node:path";

import { runDirFor } from "../core/index.ts";
import {
  getPhaseByName,
  getRun,
  listEnvelopes,
  listGateResults,
  listPhaseSpend,
  listPhaseVisits,
  listPhases,
  sumSpendTokenTotals,
} from "../daemon/db.ts";
import type { PhaseVisitRow } from "../daemon/db.ts";
import type { PhaseEnvelopes, PhaseGates } from "../daemon/contract.ts";
import { readHandoffInputs, readOutputsDir } from "../daemon/workspace/index.ts";
import { readBlueprintSnapshot } from "../server/lib/blueprint-snapshot.ts";
import {
  INPUT_CONTENTS_CAP,
  describeContextEntries,
} from "../server/lib/phase-data.ts";
import type {
  PhaseInputsData,
  PhaseOutputsData,
  PhaseSnapshotData,
  PhaseSpendData,
} from "../server/lib/phase-data.ts";

/**
 * The assembled phase record — one section per phase proxy, each carrying the
 * exact shape that proxy serves today.
 */
export interface PhaseRecordModel {
  /** snapshot.json — blueprint config + pre-resolved context + blueprint isFirst */
  snapshot: PhaseSnapshotData;
  /** inputs.json — the materialized predecessor handoff (contents capped) */
  inputs: PhaseInputsData;
  /** outputs.json — the phase's outputs/ dir listing + FINDINGS.md */
  outputs: PhaseOutputsData;
  /** spend.json — per-phase token/USD totals off the exact SQL SUM */
  spend: PhaseSpendData;
  /** envelopes — all attempts, visit → attempt order (T03) */
  envelopes: PhaseEnvelopes;
  /** gates — gate results incl. the override badge */
  gates: PhaseGates;
  /** the phase's visit history, in visit_number order */
  visits: PhaseVisitRow[];
}

/**
 * Assemble a phase's record, or null when the run or the phase does not exist
 * (the caller maps that to the proxies' 404). `dataDir` is the run's record
 * directory root — every filesystem read is scoped under runDirFor(dataDir,
 * runId); the blueprint snapshot is read through the shared reader.
 */
export function buildPhaseRecordModel(
  db: Database,
  dataDir: string,
  runId: string,
  phaseName: string,
): PhaseRecordModel | null {
  const run = getRun(db, runId);
  if (run === null) return null;
  const phase = getPhaseByName(db, runId, phaseName);
  if (phase === null) return null;

  const runDir = runDirFor(dataDir, runId);
  const detailFirstName = listPhases(db, runId)[0]?.name;

  const snapshot = assembleSnapshot(runId, phaseName, run.cwd, detailFirstName);
  const inputs = assembleInputs(runDir, phaseName, snapshot.isFirst);
  const outputs = readOutputsDir(runDir, phaseName);
  const spend = assembleSpend(db, runId, phase.id);

  return {
    snapshot,
    inputs,
    outputs,
    spend,
    envelopes: { run_id: runId, phase: phase.name, phase_id: phase.id, envelopes: listEnvelopes(db, runId, phase.id) },
    gates: { run_id: runId, phase: phase.name, phase_id: phase.id, gates: listGateResults(db, runId, phase.id) },
    visits: listPhaseVisits(db, phase.id),
  };
}

/** Ported from phase-data.ts gatherPhaseSnapshot: the phase's blueprint config
 * with its context entries pre-resolved, and blueprint-order isFirst (the
 * started_at-order `detailFirstName` is the fixture-run fallback). */
function assembleSnapshot(
  runId: string,
  phaseName: string,
  cwd: string,
  detailFirstName: string | undefined,
): PhaseSnapshotData {
  const { doc } = readBlueprintSnapshot(runId);
  const phase = doc?.phases.find((p) => p.name === phaseName) ?? null;
  const moduleDir = doc?.module ? dirname(doc.module) : null;
  const context = phase !== null ? describeContextEntries(phase.agent.context, cwd, moduleDir) : [];
  const isFirst =
    doc !== null && doc.phases.length > 0 ? doc.phases[0]!.name === phaseName : detailFirstName === phaseName;
  return { phase, moduleDir, context, isFirst };
}

/** Ported from phase-data.ts gatherPhaseInputs: the materialized handoff, each
 * file's contents clipped at INPUT_CONTENTS_CAP; the first phase has none. */
function assembleInputs(runDir: string, phaseName: string, isFirst: boolean): PhaseInputsData {
  const files = readHandoffInputs(runDir, phaseName).map(({ rel, contents }) =>
    contents.length > INPUT_CONTENTS_CAP
      ? { rel, contents: contents.slice(0, INPUT_CONTENTS_CAP), truncated: true }
      : { rel, contents, truncated: false },
  );
  return { files, isFirst };
}

/** Ported from server.ts apiSpend + phase-data.ts gatherPhaseSpend: the phase's
 * token/USD totals off the exact SQL SUM (no sweep, no truncated flag). */
function assembleSpend(db: Database, runId: string, phaseId: string): PhaseSpendData {
  const row = listPhaseSpend(db, runId).find((p) => p.id === phaseId);
  const tokens = sumSpendTokenTotals(db, runId).get(phaseId);
  return {
    tokensIn: tokens?.tokens_in ?? 0,
    tokensOut: tokens?.tokens_out ?? 0,
    cacheRead: tokens?.cache_read ?? 0,
    cacheWrite: tokens?.cache_write ?? 0,
    spendUsd: row?.spend_usd ?? 0,
    estimatedUsd: row?.estimated_spend_usd ?? 0,
  };
}
