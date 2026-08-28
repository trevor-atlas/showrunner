import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Envelope, EventType, Gate, GateContext } from "../../core/index.ts";

import {
  countUnoverriddenFailedGates,
  getEnvelope,
  getGateResult,
  getPhaseById,
  hasGateOverride,
  insertEnvelope,
  insertGateOverride,
  insertGateResult,
  updateEnvelope,
} from "../repository/db.ts";
import type { EnvelopeRow } from "../repository/db.ts";
import { inputsDirFor, outputsDirFor } from "../repository/workspace/index.ts";
import type { EventIds } from "./queue.ts";

/**
 * The envelope/gate stage of the run loop (steps 6–9) — deliberately a
 * small, clearly-named module with a tiny API: T03 extends it (attempt
 * history, overrides, gate-crash-as-violation hardening) without touching the
 * loop.
 *
 * Owned here:
 *  - reading envelope.json (the agent's typed result)
 *  - zod validation against the phase's schema
 *  - the `blocked` short-circuit (pre-gate, burns no corrections, never
 *    routed through on_fail)
 *  - gate execution: a THROWN gate is caught and treated
 *    as a violation (error text) — a crashing gate never crashes the server
 *  - recording envelope rows + gate_results rows per the schema, and the
 *    `envelope` / `gate_result` events
 *  - the gate-override mechanism: who + why + when audited next to the
 *    KEPT original gate_results row; T04's pause menu and T08's HTTP verb call
 *    these functions
 *
 * Attempt history (T03): EVERY attempt is an `envelopes` row — accepted,
 * rejected (gate violations), and invalid (zod-rejected or unreadable). Each
 * row carries `valid` (0/1), the `violations` that rejected it, and the
 * `correction` message issued after it (filled by the loop once the correction
 * is actually sent; null when none followed — accepted, blocked, or budget
 * exhausted). The drill-in renders per-attempt valid/invalid,
 * violations, and the correction that followed straight from these columns.
 * `attempt` = corrections issued before this attempt (0 = first attempt of the
 * visit). The `envelope` EVENT fires only on acceptance (valid + gates
 * passed or overridden), which is what `accepted` means.
 */

export type EnvelopeOutcome =
  | { kind: "accepted"; envelope: Envelope; raw: string; envelopeId: string; gateResults: GateRun[] }
  | { kind: "invalid"; error: string; envelopeId: string }
  | { kind: "blocked"; reason: string; envelopeId: string }
  | { kind: "violations"; envelope: Envelope; violations: string[]; envelopeId: string; gateResults: GateRun[] };

export interface GateRun {
  gate: string;
  pass: boolean;
  violations: string[];
}

export interface EnvelopeStageOptions {
  db: Database;
  runId: string;
  phaseId: string;
  phaseName: string;
  agentSessionId: string | null;
  visit: number;
  /** the phase_visits row this visit's attempts belong to (v3, #45); optional
   * so direct callers outside a live visit keep compiling, mirroring
   * EnvelopeRow.visit_id */
  visitId?: string;
  /** corrections already issued in this visit (0 = first attempt) */
  attempt: number;
  /** the run's cwd (the project the agent works on) — what gates call the workspace */
  cwd: string;
  /** the run's record dir ({data_dir}/runs/<run_id>) — where the per-phase
   * inputs/outputs workspace lives. Never the same tree as cwd. */
  runDir: string;
  /** absolute path to <runDir>/<phase>/outputs/envelope.json */
  envelopePath: string;
  schema: z.ZodTypeAny;
  gates: Gate[];
  now: () => string;
  emit: (type: EventType, data: unknown, ids?: EventIds) => void;
}

/** The one entry point: read + validate + block-check + gates, recording as it goes. */
export async function runEnvelopeStage(opts: EnvelopeStageOptions): Promise<EnvelopeOutcome> {
  const raw = readEnvelopeFile(opts.envelopePath);
  if (raw === null) {
    // an attempt that produced no readable envelope.json is still an attempt
    // "1 ✗ invalid (envelope.json missing) → corrected"
    const envelopeId = recordAttemptRow(opts, null, "");
    return { kind: "invalid", error: `no envelope.json written at ${opts.envelopePath}`, envelopeId };
  }

  const parsed = opts.schema.safeParse(raw.value);
  if (!parsed.success) {
    const error = formatZodError(parsed.error);
    // the rejected text is stored verbatim so the drill-in can show what failed
    const envelopeId = recordAttemptRow(opts, null, raw.text);
    return { kind: "invalid", error, envelopeId };
  }
  const envelope = parsed.data as Envelope;
  const envelopeId = recordAttemptRow(opts, envelope, raw.text);

  if (envelope.blocked === true) {
    // valid + recorded; no gates run, no correction follows, the run pauses
    return { kind: "blocked", reason: envelope.blocked_reason ?? "agent reported blocked", envelopeId };
  }

  const gateResults = await runGates(opts, envelope, envelopeId);

  // the violations that rejected this attempt live on the envelope row too —
  // the drill-in shows them per attempt without a second join hop
  const violations = gateResults.flatMap((g) => g.violations);
  updateEnvelope(opts.db, envelopeId, { violations: JSON.stringify(violations) });

  const passed = gateResults.every((g) => g.pass);
  if (!passed) {
    return { kind: "violations", envelope, violations, envelopeId, gateResults };
  }
  // accepted: the event
  opts.emit(
    "envelope",
    { phase: opts.phaseName, visit: opts.visit, attempt: opts.attempt, valid: true },
    { phase_id: opts.phaseId, agent_session_id: opts.agentSessionId },
  );
  return { kind: "accepted", envelope, raw: raw.text, envelopeId, gateResults };
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Read envelope.json verbatim; null when missing/unreadable/unparseable. */
function readEnvelopeFile(
  path: string,
): { text: string; value: Record<string, unknown> } | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return { text, value: value as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Record one attempt as an `envelopes` row — every attempt, valid or not. */
function recordAttemptRow(
  opts: EnvelopeStageOptions,
  envelope: Envelope | null,
  jsonText: string,
): string {
  const id = randomUUID();
  insertEnvelope(opts.db, {
    id,
    run_id: opts.runId,
    phase_id: opts.phaseId,
    visit: opts.visit,
    attempt: opts.attempt,
    json: jsonText,
    source: opts.envelopePath,
    validated_at: opts.now(),
    valid: envelope === null ? 0 : 1,
    violations: "[]",
    correction: null, // filled by the loop when a correction actually follows
    visit_id: opts.visitId ?? null,
  });
  return id;
}

/**
 * Run every gate; record a gate_results row + `gate_result` event per gate.
 * A throwing gate becomes a violation with the error text — the server
 * never crashes because a gate crashed.
 */
async function runGates(
  opts: EnvelopeStageOptions,
  envelope: Envelope,
  envelopeId: string,
): Promise<GateRun[]> {
  const ctx: GateContext = {
    run_id: opts.runId,
    cwd: opts.cwd,
    phase: opts.phaseName,
    visit: opts.visit,
    // gates that verify what the agent produced check the phase's outputs dir
    outputs_dir: outputsDirFor(opts.runDir, opts.phaseName),
    // gates that read what the phase was handed check the phase's inputs dir
    inputs_dir: inputsDirFor(opts.runDir, opts.phaseName),
  };
  const runs: GateRun[] = [];
  for (let i = 0; i < opts.gates.length; i++) {
    const gate = opts.gates[i]!;
    const name = gateName(gate, i);
    let run: GateRun;
    try {
      const result = await gate(envelope, ctx);
      run = result.pass
        ? { gate: name, pass: true, violations: [] }
        : { gate: name, pass: false, violations: result.violations };
    } catch (err) {
      // a thrown gate is a violation, never a server crash
      const message = err instanceof Error ? err.message : String(err);
      run = { gate: name, pass: false, violations: [`gate "${name}" crashed: ${message}`] };
    }
    const ranAt = opts.now();
    insertGateResult(opts.db, {
      id: randomUUID(),
      envelope_id: envelopeId,
      gate: run.gate,
      pass: run.pass ? 1 : 0,
      violations: JSON.stringify(run.violations),
      ran_at: ranAt,
    });
    opts.emit(
      "gate_result",
      { gate: run.gate, pass: run.pass, violations: run.violations },
      { phase_id: opts.phaseId, agent_session_id: opts.agentSessionId },
    );
    runs.push(run);
  }
  return runs;
}

/**
 * The gate name for the event / gate_results row: the name declared via
 * defineGate, else the legacy reflection (fn name, else index). The legacy
 * fallback keeps un-migrated gates byte-identical to their prior output.
 */
export function gateName(gate: Gate, index: number): string {
  const declared = (gate as { gateName?: string }).gateName;
  if (typeof declared === "string" && declared !== "") return declared;
  const n = (gate as { name?: string }).name;
  return typeof n === "string" && n !== "" ? n : `gate:${index}`;
}

// ── gate overrides: the mechanism T04's pause menu and T08's HTTP verb call ─

export interface OverrideGateOptions {
  db: Database;
  /** the gate_results row id to override — the original row is KEPT */
  gateResultId: string;
  /** who overrode (operator identity) — recorded in the audit marker + human_action */
  by: string;
  /** why — the audited reason, shown on the drill-in override badge */
  reason: string;
  now?: () => string;
  emit?: (type: EventType, data: unknown, ids?: EventIds) => void;
  agentSessionId?: string | null;
}

export interface GateOverrideResult {
  override_id: string;
  gate: string;
  envelope_id: string;
  /** true once every failed gate of this envelope is overridden — "treated as
   * passed"; the resume path then records acceptance and continues */
  approved: boolean;
}

/**
 * Mark a failed gate result as overridden. The original gate_results row is
 * KEPT (pass stays 0 — the audit trail is the point); an audited marker
 * (who + reason + when) is added, and a human_action event is emitted.
 * Throws when the result is missing, already passed, or already overridden.
 *
 * This is the mechanism T08's HTTP verb and T04's pause-menu action call. It
 * does NOT advance the run — after `approved`, the resume path calls
 * recordEnvelopeAcceptance() to record the acceptance and continues.
 */
export function overrideGateResult(opts: OverrideGateOptions): GateOverrideResult {
  const { db, gateResultId } = opts;
  const row = getGateResult(db, gateResultId);
  if (!row) throw new Error(`no gate result ${gateResultId} to override`);
  if (row.pass === 1) throw new Error(`gate "${row.gate}" passed — nothing to override`);
  if (hasGateOverride(db, gateResultId)) {
    throw new Error(`gate "${row.gate}" result ${gateResultId} is already overridden`);
  }

  const envelope = getEnvelope(db, row.envelope_id);
  if (!envelope) throw new Error(`envelope ${row.envelope_id} for gate result ${gateResultId} not found`);

  const overrideId = randomUUID();
  const createdAt = (opts.now ?? (() => new Date().toISOString()))();
  insertGateOverride(db, {
    id: overrideId,
    gate_result_id: gateResultId,
    run_id: envelope.run_id,
    envelope_id: row.envelope_id,
    by: opts.by,
    reason: opts.reason,
    created_at: createdAt,
  });
  opts.emit?.(
    "human_action",
    {
      action: "override_gate",
      by: opts.by,
      detail: `gate "${row.gate}" overridden on envelope ${row.envelope_id}: ${opts.reason}`,
    },
    { phase_id: envelope.phase_id, agent_session_id: opts.agentSessionId ?? null },
  );
  return {
    override_id: overrideId,
    gate: row.gate,
    envelope_id: row.envelope_id,
    approved: isEnvelopeApproved(db, row.envelope_id),
  };
}

/**
 * "Gate treated as passed": an envelope is approved when every gate
 * result for it either passed or has an override marker. An envelope with no
 * gate results is approved (nothing failed). The resume path consults this
 * before continuing a previously-rejected envelope as accepted.
 */
export function isEnvelopeApproved(db: Database, envelopeId: string): boolean {
  return countUnoverriddenFailedGates(db, envelopeId) === 0;
}

export interface RecordEnvelopeAcceptanceOptions {
  db: Database;
  /** the attempt's envelopes row id — must be valid and fully approved */
  envelopeId: string;
  agentSessionId?: string | null;
  emit: (type: EventType, data: unknown, ids?: EventIds) => void;
  now?: () => string;
}

/**
 * Record the acceptance for an envelope that was rejected but has since
 * been approved by overrides (or whose gates pass outright) — the step the
 * resume path runs after `isEnvelopeApproved` and before advancing the run.
 * Throws when the envelope is missing, invalid, or still has un-overridden
 * gate violations (correct-by-construction).
 */
export function recordEnvelopeAcceptance(opts: RecordEnvelopeAcceptanceOptions): EnvelopeRow {
  const row = getEnvelope(opts.db, opts.envelopeId);
  if (!row) throw new Error(`envelope ${opts.envelopeId} not found`);
  if (row.valid !== 1) throw new Error(`envelope ${opts.envelopeId} is invalid — cannot record acceptance`);
  if (!isEnvelopeApproved(opts.db, opts.envelopeId)) {
    throw new Error(`envelope ${opts.envelopeId} still has un-overridden gate violations`);
  }
  const phase = getPhaseById(opts.db, row.phase_id);
  opts.emit(
    "envelope",
    { phase: phase?.name ?? row.phase_id, visit: row.visit, attempt: row.attempt, valid: true },
    { phase_id: row.phase_id, agent_session_id: opts.agentSessionId ?? null },
  );
  return row;
}
