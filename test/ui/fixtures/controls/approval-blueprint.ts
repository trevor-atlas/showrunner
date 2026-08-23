import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../../src/core/index.ts";

/**
 * The T10b approve e2e fixture — a one-phase blueprint with require_approval:
 * the run pauses BEFORE the phase spawns (§5.2 step 1) with the approval menu
 * (approve / steer / fail); the approve action proceeds to spawn and the
 * phase succeeds on its first turn (fake-pi/build.json writes a valid
 * envelope; gates: [] means nothing rejects it).
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
