import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Envelope, EventType, Gate, GateContext } from "@showrunner/core";

import { insertEnvelope, insertGateResult } from "./db.ts";
import type { EventIds } from "./queue.ts";

/**
 * The envelope/gate stage of the run loop (§5.2 steps 6–9) — deliberately a
 * small, clearly-named module with a tiny API: T03 extends it (attempt
 * history, overrides, gate-crash-as-violation hardening) without touching the
 * loop.
 *
 * Owned here:
 *  - reading envelope.json (the agent's typed result, §9.1)
 *  - zod validation against the phase's schema (ADR-0002)
 *  - the `blocked` short-circuit (§3.2: pre-gate, burns no corrections, never
 *    routed through on_fail)
 *  - gate execution with §5.5 semantics: a THROWN gate is caught and treated
 *    as a violation (error text) — a crashing gate never crashes the daemon
 *  - recording envelope rows + gate_results rows per the §4 schema, and the
 *    `envelope` / `gate_result` events (§6 #8, #9)
 *
 * Rows recorded here: every *validated* envelope (parse success) becomes an
 * `envelopes` row with `attempt` = corrections used so far ("0 = first
 * successful parse"); gates that ran against it become `gate_results` rows.
 * The `envelope` EVENT fires only on acceptance (valid + gates passed), which
 * is what §6 #8 means by "accepted".
 */

export type EnvelopeOutcome =
  | { kind: "accepted"; envelope: Envelope; raw: string; gateResults: GateRun[] }
  | { kind: "invalid"; error: string }
  | { kind: "blocked"; reason: string }
  | { kind: "violations"; envelope: Envelope; violations: string[]; gateResults: GateRun[] };

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
  /** corrections already issued in this visit (0 = first parse) */
  attempt: number;
  cwd: string;
  /** absolute path to context_handoff/<phase>/outputs/envelope.json */
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
    return { kind: "invalid", error: `no envelope.json written at ${opts.envelopePath}` };
  }

  const parsed = opts.schema.safeParse(raw.value);
  if (!parsed.success) {
    const error = formatZodError(parsed.error);
    return { kind: "invalid", error };
  }
  const envelope = parsed.data as Envelope;

  // every validated envelope is recorded (attempt history — the seam T03 extends)
  const envelopeId = recordEnvelopeRow(opts, envelope, raw.text);

  if (envelope.blocked === true) {
    return { kind: "blocked", reason: envelope.blocked_reason ?? "agent reported blocked" };
  }

  const gateResults = await runGates(opts, envelope, envelopeId);

  const passed = gateResults.every((g) => g.pass);
  if (!passed) {
    return { kind: "violations", envelope, violations: gateResults.flatMap((g) => g.violations), gateResults };
  }
  // accepted: the §6 #8 event
  opts.emit(
    "envelope",
    { phase: opts.phaseName, visit: opts.visit, attempt: opts.attempt, valid: true },
    { phase_id: opts.phaseId, agent_session_id: opts.agentSessionId },
  );
  return { kind: "accepted", envelope, raw: raw.text, gateResults };
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

function recordEnvelopeRow(
  opts: EnvelopeStageOptions,
  envelope: Envelope,
  jsonText: string,
): string {
  const id = randomUUID();
  const validatedAt = opts.now();
  insertEnvelope(opts.db, {
    id,
    run_id: opts.runId,
    phase_id: opts.phaseId,
    visit: opts.visit,
    attempt: opts.attempt,
    json: jsonText,
    source: opts.envelopePath,
    validated_at: validatedAt,
  });
  return id;
}

/**
 * Run every gate; record a gate_results row + `gate_result` event per gate.
 * A throwing gate becomes a violation with the error text (§5.5) — the daemon
 * never crashes because a gate crashed.
 */
async function runGates(
  opts: EnvelopeStageOptions,
  envelope: Envelope,
  envelopeId: string,
): Promise<GateRun[]> {
  const ctx: GateContext = { run_id: opts.runId, cwd: opts.cwd, phase: opts.phaseName, visit: opts.visit };
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
      // §5.5: a thrown gate is a violation, never a daemon crash
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

/** The gate name for the §6 #9 event / §4 gate_results row: fn name, else index. */
export function gateName(gate: Gate, index: number): string {
  const n = (gate as { name?: string }).name;
  return typeof n === "string" && n !== "" ? n : `gate:${index}`;
}
