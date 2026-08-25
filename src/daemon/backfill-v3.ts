import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";

import { runDirFor } from "../core/index.ts";
import { insertPhaseVisit } from "./db.ts";

/**
 * backfillV3 — best-effort synthesis of v3 data for old v2-shaped DBs.
 *
 * Kept SEPARATE from the migration DDL and from backfill.ts (event backfill).
 * Called by openDb AFTER migrate() has committed, never inside the migration
 * transaction — so a bug here can never roll back or brick the schema
 * migration. It reads only from already-migrated tables and writes only the
 * v3 fields the v2 rows left empty:
 *   - phases.ordinal      ← the phase's insertion (rowid) order within its run
 *   - phases.agent_model  ← the run's blueprint.json snapshot, when present
 *   - phase_visits        ← one row per distinct (phase_id, visit) across
 *                           envelopes + agent_sessions
 *   - envelopes.visit_id  ← the phase_visits row matching (phase_id, visit)
 *
 * Every step is guarded on "the v3 field is still unset", so a second call is
 * a no-op: running it on a fresh, an already-backfilled, or a natively-v3 DB
 * changes nothing.
 */

export interface BackfillV3Summary {
  phasesOrdinaled: number;
  phasesModeled: number;
  visitsSynthesized: number;
  envelopesLinked: number;
}

interface Pair {
  phase_id: string;
  visit: number;
}

interface SessionStamp {
  id: string;
  started_at: string | null;
  ended_at: string | null;
}

export function backfillV3(db: Database): BackfillV3Summary {
  return db.transaction((): BackfillV3Summary => ({
    phasesOrdinaled: backfillOrdinals(db),
    phasesModeled: backfillAgentModels(db, dirname(db.filename)),
    visitsSynthesized: synthesizePhaseVisits(db),
    envelopesLinked: linkEnvelopeVisits(db),
  }))();
}

/** Derive ordinal from phase insertion (rowid) order per run; only fill NULLs. */
function backfillOrdinals(db: Database): number {
  return db
    .query(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY rowid) - 1 AS ord FROM phases
       )
       UPDATE phases SET ordinal = (SELECT ord FROM ranked WHERE ranked.id = phases.id)
       WHERE ordinal IS NULL`,
    )
    .run().changes;
}

/** Copy agent_model from each run's blueprint.json snapshot, when readable. */
function backfillAgentModels(db: Database, dataDir: string): number {
  let modeled = 0;
  const runs = db.query<{ id: string }, []>("SELECT id FROM runs").all();
  const update = db.query("UPDATE phases SET agent_model = ? WHERE run_id = ? AND name = ? AND agent_model IS NULL");
  for (const { id: runId } of runs) {
    const models = readSnapshotModels(dataDir, runId);
    if (models === null) continue;
    for (const [name, model] of models) {
      modeled += update.run(model, runId, name).changes;
    }
  }
  return modeled;
}

/** Phase name → agent model from a run's blueprint.json, or null when the file
 * is missing/unreadable/misshapen (external data, parsed defensively). */
function readSnapshotModels(dataDir: string, runId: string): Map<string, string> | null {
  let text: string;
  try {
    text = readFileSync(join(runDirFor(dataDir, runId), "blueprint.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const phases = (parsed as { phases?: unknown } | null)?.phases;
  if (!Array.isArray(phases)) return null;
  const out = new Map<string, string>();
  for (const p of phases) {
    if (typeof p !== "object" || p === null) continue;
    const name = (p as { name?: unknown }).name;
    const agent = (p as { agent?: unknown }).agent;
    const model = typeof agent === "object" && agent !== null ? (agent as { model?: unknown }).model : undefined;
    if (typeof name === "string" && typeof model === "string") out.set(name, model);
  }
  return out;
}

/** One phase_visits row per distinct (phase_id, visit) across envelopes +
 * agent_sessions that has none yet. status is the phase's status; the visit's
 * agent session (if any) supplies the stamps and the link. */
function synthesizePhaseVisits(db: Database): number {
  const pairs = db
    .query<Pair, []>("SELECT phase_id, visit FROM envelopes UNION SELECT phase_id, visit FROM agent_sessions")
    .all();
  if (pairs.length === 0) return 0;

  const phaseStatus = new Map(
    db.query<{ id: string; status: string }, []>("SELECT id, status FROM phases").all().map((r) => [r.id, r.status]),
  );
  const sessions = new Map<string, SessionStamp>();
  for (const s of db
    .query<{ id: string; phase_id: string; visit: number; started_at: string | null; ended_at: string | null }, []>(
      "SELECT id, phase_id, visit, started_at, ended_at FROM agent_sessions ORDER BY rowid",
    )
    .all()) {
    const key = `${s.phase_id}\u0000${s.visit}`;
    if (!sessions.has(key)) sessions.set(key, { id: s.id, started_at: s.started_at, ended_at: s.ended_at });
  }
  const exists = db.query("SELECT 1 FROM phase_visits WHERE phase_id = ? AND visit_number = ? LIMIT 1");

  let synthesized = 0;
  for (const { phase_id, visit } of pairs) {
    if (exists.get(phase_id, visit) !== null) continue;
    const session = sessions.get(`${phase_id}\u0000${visit}`);
    insertPhaseVisit(db, {
      id: `bf:${phase_id}:v${visit}`,
      phase_id,
      visit_number: visit,
      cause: null,
      status: phaseStatus.get(phase_id) ?? "unknown",
      started_at: session?.started_at ?? null,
      ended_at: session?.ended_at ?? null,
      agent_session_id: session?.id ?? null,
    });
    synthesized += 1;
  }
  return synthesized;
}

/** Point each still-unlinked envelope at the phase_visits row for its
 * (phase_id, visit); leaves envelopes with no matching visit row untouched. */
function linkEnvelopeVisits(db: Database): number {
  return db
    .query(
      `UPDATE envelopes
       SET visit_id = (
         SELECT pv.id FROM phase_visits pv
         WHERE pv.phase_id = envelopes.phase_id AND pv.visit_number = envelopes.visit
         LIMIT 1
       )
       WHERE visit_id IS NULL
         AND EXISTS (
           SELECT 1 FROM phase_visits pv
           WHERE pv.phase_id = envelopes.phase_id AND pv.visit_number = envelopes.visit
         )`,
    )
    .run().changes;
}
