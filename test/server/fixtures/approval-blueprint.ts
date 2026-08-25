import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../src/core/index.ts";

/**
 * A one-phase blueprint with require_approval — the run pauses BEFORE the
 * phase spawns and keeps its pool slot (F1), so a second submit of this
 * blueprint queues behind it (queue_position = 1). Used by the UI's e2e test
 * to prove the queued StatusPill renders from a REAL pool queue.
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
