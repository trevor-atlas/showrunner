import type { Envelope } from "./envelope.ts";
import type { RunContext, ShellResult } from "./run.ts";

/** Gate context: the workspace, the phase, and the visit number. */
export interface GateContext extends RunContext {
  phase: string;
  visit: number;
  /**
   * Absolute path to this phase's inputs/ dir — the run's per-phase workspace
   * ({data_dir}/runs/<run_id>/<phase>/inputs) where the predecessor's accepted
   * envelope.json and artifacts were materialized for the agent. Gates that
   * read what the phase was handed (matchesPlan) check files here. Absent
   * when a server does not provide it.
   */
  inputs_dir?: string;
  /**
   * Absolute path to this phase's outputs/ dir ({data_dir}/runs/<run_id>/<phase>/outputs)
   * — where the agent wrote its envelope.json and artifacts. Gates that verify
   * what the agent actually produced (findingsReported, artifact existence)
   * check files here. Absent when a server does not provide it.
   */
  outputs_dir?: string;
  /**
   * The escape hatch to the host shell. Hooks always get one; v1 servers
   * may not provide it to gates yet — gates can fall back to `createShell`
   * from this package when absent.
   */
  shell?(cmd: string): Promise<ShellResult>;
}

export type GateResult = { pass: true } | { pass: false; violations: string[] };

/**
 * A gate is a plain first-class function. It runs in the server
 * process after parse succeeds and after the `blocked` short-circuit. Gate
 * violations feed the correction message verbatim.
 */
export type Gate<E extends Envelope = Envelope> = (envelope: E, ctx: GateContext) => Promise<GateResult>;

/**
 * A gate that carries its identity EXPLICITLY. Gate names are a persisted
 * contract (gate_results.gate, phases.gate_names, the gate_result event, and
 * the snapshot's gates[]); deriving them from `Function.name` is fragile
 * (minification, wrapping) so `defineGate` pins the name on the gate itself.
 */
export type NamedGate<E extends Envelope = Envelope> = Gate<E> & { gateName: string };

/**
 * Pin a stable, explicit name onto a gate — the identity the server persists
 * instead of reflecting over `Function.name`. Mirrors defineBlueprint/
 * defineAgent: a pass-through that reads as a definition at the call site.
 */
export function defineGate<E extends Envelope = Envelope>(name: string, run: Gate<E>): NamedGate<E> {
  return Object.assign(run, { gateName: name });
}
