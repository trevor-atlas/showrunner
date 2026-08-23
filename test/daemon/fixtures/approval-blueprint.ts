import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../src/core/index.ts";

/**
 * A one-phase blueprint with require_approval — the run pauses BEFORE the
 * phase spawns (§5.2 step 1); the approve action proceeds to spawn, and the
 * build phase succeeds on its first turn (fake-pi/build.json).
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope.",
  tools: ["bash"],
  context: [],
});

export default defineBlueprint({
  name: "approval-demo",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: EnvelopeBase,
      gates: [],
      budget: 3,
      require_approval: true,
    },
  ],
});
