import { z } from "zod";
import { EnvelopeBase } from "./envelope.ts";
import type { Envelope } from "./envelope.ts";
import type { Agent } from "./agent.ts";
import type { Gate } from "./gate.ts";
import type { PhaseHookContext } from "./run.ts";

/**
 * Blueprint types. A blueprint is a TypeScript module defining a
 * play of phases; phases reference imported agents and gates directly - no
 * string registries.
 */

export interface BlueprintPhase<S extends z.ZodType<Envelope> = z.ZodType<Envelope>> {
  /** phase name - on_fail.to targets these; unique within a blueprint */
  name: string;
  agent: Agent; // imported module, not a string
  /** zod schema extended from EnvelopeBase */
  envelope: S;
  gates: Gate<z.infer<S>>[];
  /** max corrections per visit (default ~3) */
  budget?: number;
  /** phase name - fired after budget exhaustion; loops by configuration */
  on_fail?: { to: string };
  /** pause for human before start */
  require_approval?: boolean;
  /** phase-level additions to the agent's defaults */
  context?: string[];
}

export interface Blueprint {
  name: string;
  /** index = execution order; on_fail may target any phase */
  phases: BlueprintPhase[];
  onPhaseStart?: (ctx: PhaseHookContext) => Promise<void>;
  onPhaseEnd?: (ctx: PhaseHookContext) => Promise<void>;
}

/** Default correction budget per visit. */
export const DEFAULT_BUDGET = 3;

/** Thrown by defineBlueprint when a blueprint fails load-time validation. */
export class BlueprintValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintValidationError";
  }
}

/**
 * Load-time validation (run in the server):
 *  - phase names non-empty and unique
 *  - `on_fail.to` must name a phase that exists
 *  - `envelope` must be assignable to EnvelopeBase
 *  - budget must be a positive integer when present
 */
export function validateBlueprint(b: Blueprint): void {
  if (!b || typeof b !== "object") {
    throw new BlueprintValidationError("blueprint must be an object");
  }
  if (typeof b.name !== "string" || b.name.trim() === "") {
    throw new BlueprintValidationError("blueprint must have a non-empty name");
  }
  if (!Array.isArray(b.phases) || b.phases.length === 0) {
    throw new BlueprintValidationError(`blueprint "${b.name}" must define at least one phase`);
  }

  const names = new Set<string>();
  for (const phase of b.phases) {
    if (!phase || typeof phase !== "object") {
      throw new BlueprintValidationError(`blueprint "${b.name}": every phase must be an object`);
    }
    if (typeof phase.name !== "string" || phase.name.trim() === "") {
      throw new BlueprintValidationError(`blueprint "${b.name}": every phase must have a non-empty name`);
    }
    if (names.has(phase.name)) {
      throw new BlueprintValidationError(`blueprint "${b.name}": duplicate phase name "${phase.name}"`);
    }
    names.add(phase.name);

    if (!phase.agent || typeof phase.agent !== "object") {
      throw new BlueprintValidationError(`phase "${phase.name}": missing agent`);
    }
    if (!phase.envelope || typeof (phase.envelope as z.ZodTypeAny).safeParse !== "function") {
      throw new BlueprintValidationError(`phase "${phase.name}": envelope must be a zod schema`);
    }
    assertEnvelopeExtendsBase(phase.name, phase.envelope);
    if (!Array.isArray(phase.gates)) {
      throw new BlueprintValidationError(`phase "${phase.name}": gates must be an array`);
    }
    if (phase.budget !== undefined) {
      if (!Number.isInteger(phase.budget) || phase.budget < 1) {
        throw new BlueprintValidationError(`phase "${phase.name}": budget must be a positive integer`);
      }
    }
    if (phase.on_fail !== undefined) {
      if (!phase.on_fail || typeof phase.on_fail.to !== "string") {
        throw new BlueprintValidationError(`phase "${phase.name}": on_fail.to must be a phase name string`);
      }
    }
  }

  for (const phase of b.phases) {
    if (phase.on_fail && !names.has(phase.on_fail.to)) {
      throw new BlueprintValidationError(
        `phase "${phase.name}": on_fail.to "${phase.on_fail.to}" does not name an existing phase`,
      );
    }
  }
}

/**
 * The envelope-extends-base check: build `EnvelopeBase.merge(envelope)`
 * and assert it still accepts an EnvelopeBase instance.
 *
 * Phases normally use `EnvelopeBase.extend({...})`, which can add *required*
 * extra fields; a strict probe parse would reject those. So the check accepts
 * the probe when either (a) the merged schema parses it outright, or (b) a
 * `.partial()` parse succeeds with the base fields intact - meaning the only
 * missing keys are the phase's own additions, and no base field was redefined
 * with an incompatible type (e.g. `summary: z.number()` fails the partial
 * parse and is rejected).
 */
function assertEnvelopeExtendsBase(phaseName: string, envelope: z.ZodTypeAny): void {
  const probe: Record<string, unknown> = {
    summary: "probe summary",
    artifacts: ["probe-artifact"], // a non-empty string element so redefined array types are caught
    notes_for_next_agent: "probe notes",
  };
  try {
    const merged = EnvelopeBase.merge(envelope as z.ZodObject<z.ZodRawShape>);
    if (merged.safeParse(probe).success) return;
    const partial = merged.partial().safeParse(probe);
    if (partial.success && EnvelopeBase.safeParse(probe).success) return;
  } catch {
    // merge threw (non-object schema, etc.)
  }
  throw new BlueprintValidationError(
    `phase "${phaseName}": envelope must extend EnvelopeBase (zod .extend() of the base)`,
  );
}

/** Pass-through helper with load-time validation. */
export function defineBlueprint(b: Blueprint): Blueprint {
  validateBlueprint(b);
  return b;
}
