import type { Envelope } from "./envelope.ts";
import type { RunContext } from "./run.ts";

/** Gate context (spec §3.7): the workspace, the phase, and the visit number. */
export interface GateContext extends RunContext {
  phase: string;
  visit: number;
}

export type GateResult = { pass: true } | { pass: false; violations: string[] };

/**
 * A gate is a plain first-class function (ADR-0001). It runs in the daemon
 * process after parse succeeds and after the `blocked` short-circuit. Gate
 * violations feed the correction message verbatim.
 */
export type Gate = (envelope: Envelope, ctx: GateContext) => Promise<GateResult>;
