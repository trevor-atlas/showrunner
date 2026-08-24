import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../src/core/index.ts";

/**
 * onPhaseStart THROWS: the phase never spawns; the loop
 * audits the failure (human_action hook_error), emits phase_end with status
 * failed, and parks the run at the hook_failed pause menu — it does NOT die
 * silently.
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope.",
  tools: ["bash"],
  context: [],
});

export default defineBlueprint({
  name: "hook-start-fail",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: EnvelopeBase,
      gates: [],
      budget: 3,
    },
  ],
  onPhaseStart: async () => {
    throw new Error("hook start boom");
  },
});
