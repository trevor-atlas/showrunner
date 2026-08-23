import { EnvelopeBase, defineAgent, defineBlueprint } from "@showrunner/core";

/**
 * A one-phase happy blueprint — the build phase succeeds on its first turn
 * (fake-pi/build.json writes a valid envelope, no gates). Used by the F1
 * pool-slot test as the queued-then-started run.
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope.",
  tools: ["bash"],
  context: [],
});

export default defineBlueprint({
  name: "happy-demo",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: EnvelopeBase,
      gates: [],
      budget: 3,
    },
  ],
});
