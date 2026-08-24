import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../src/core/index.ts";

/**
 * onPhaseEnd THROWS: the visit's envelope was ACCEPTED,
 * but the end hook fails — the phase is recorded `failed` (phase_end with
 * status failed), the failure is audited as a human_action hook_error, and
 * the run parks at the hook_failed pause menu instead of advancing.
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope.",
  tools: ["bash"],
  context: [],
});

export default defineBlueprint({
  name: "hook-end-fail",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: EnvelopeBase,
      gates: [],
      budget: 3,
    },
  ],
  onPhaseEnd: async () => {
    throw new Error("hook end boom");
  },
});
