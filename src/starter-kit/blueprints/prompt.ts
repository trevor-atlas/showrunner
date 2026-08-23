import { EnvelopeBase, defineBlueprint } from "../../core/index.ts";
import type { Agent, Blueprint, Gate } from "../../core/index.ts";
import { planner } from "../agents/planner.ts";

/**
 * prompt — "one agent, one prompt, NAME picks who" (PLAN §14). A single-phase
 * blueprint around whichever agent you want: the skill's `{prompt}` argument
 * is the goal, and you pick the agent by editing this module (or using the
 * factory below).
 *
 * The default export drives the planner — the most common "just think about
 * this" entry point. To send the prompt to another agent, replace the import
 * and the `agent:` line — or build your own in a copy:
 *
 *   import { defineBlueprint } from "../../core/index.ts";
 *   import { scout } from "../agents/scout.ts";
 *   import { ScoutEnvelope } from "../envelopes.ts";
 *   export default defineBlueprint({ name: "prompt", phases: [{
 *     name: "do", agent: scout, envelope: ScoutEnvelope, gates: [], budget: 3,
 *   }] });
 *
 * Replace-this: the agent, envelope, and gates are the point of this file.
 */
export function promptBlueprint(agent: Agent, envelope = EnvelopeBase, gates: Gate[] = []): Blueprint {
  return defineBlueprint({
    name: "prompt",
    phases: [{ name: "do", agent, envelope, gates, budget: 3 }],
  });
}

export default defineBlueprint({
  name: "prompt",
  phases: [
    {
      name: "do",
      agent: planner,
      envelope: EnvelopeBase,
      gates: [],
      budget: 3,
    },
  ],
});
