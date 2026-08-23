import { EnvelopeBase, defineAgent, defineBlueprint } from "@showrunner/core";
import type { Envelope, Gate } from "@showrunner/core";

/**
 * A one-phase blueprint whose phase ALWAYS fails its gate — the correction
 * budget (1) exhausts on the second attempt and the run pauses (T04's
 * budget_exhausted menu, no on_fail). Driven by the existing fake-pi/build.json
 * scripted session (its last turn repeats, so the phase keeps failing).
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope.",
  tools: ["bash"],
  context: [],
});

const alwaysFail: Gate = async () => ({ pass: false, violations: ["always failing"] });

export default defineBlueprint({
  name: "pause-demo",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: EnvelopeBase,
      gates: [alwaysFail],
      budget: 1,
    },
  ],
});

// keep the Envelope import for TS consumers of this fixture
export type { Envelope };
