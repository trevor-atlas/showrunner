/**
 * The replaceable model roster (PLAN §14 — the replace-this doctrine).
 *
 * Agents pick models by ROLE here, not by hardcoded ids. Swap the ids below
 * for the models that are good in YOUR week and every agent follows. This is
 * the single obvious file to edit when the roster ages.
 *
 * The ids in this file were the ones `pi --list-models` reported the week the
 * starter kit shipped — they are a point-in-time snapshot, not a promise.
 */

export interface RosterEntry {
  /** the model id exactly as the daemon's pi reports it (--list-models) */
  id: string;
  /** why this role is filled by this model */
  note: string;
}

/**
 * ROLES → model ids. Agents reference ROLES (e.g. `MODELS.reasoning.id`), so
 * you can retarget every agent at once by editing this one object.
 */
export const MODELS = {
  /** deliberate, plan-then-execute work: planning, reviewing, the heavy chain */
  reasoning: { id: "openai/gpt-5.3-codex", note: "the strongest code reasoning model available the week it shipped" },
  /** fast, cheap turns: recon, small edits, docs, repeated fix loops */
  fast: { id: "openai/gpt-5.4-mini", note: "the cheap end of the roster — good for high-volume phases" },
} as const satisfies Record<string, RosterEntry>;

export type ModelRole = keyof typeof MODELS;

/** The default role the starter agents use when a phase does not say otherwise. */
export const DEFAULT_MODEL_ROLE: ModelRole = "fast";

export function modelFor(role: ModelRole = DEFAULT_MODEL_ROLE): string {
  return MODELS[role].id;
}
