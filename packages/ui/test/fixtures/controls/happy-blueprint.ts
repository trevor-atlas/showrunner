import { EnvelopeBase, defineAgent, defineBlueprint } from "@showrunner/core";

/**
 * The T10b resume e2e fixture — a one-phase happy blueprint: the build phase
 * succeeds on its first turn (fake-pi/build.json). Used for the interrupted →
 * resume → success scenario: the e2e seeds an INTERRUPTED run row + pending
 * phase + the §13.3 snapshot (this module path) directly, then POSTs the
 * resume verb — the daemon relaunches the phase behind the pool and succeeds.
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope.",
  tools: ["bash"],
  context: [],
});

export default defineBlueprint({
  name: "controls-happy",
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
