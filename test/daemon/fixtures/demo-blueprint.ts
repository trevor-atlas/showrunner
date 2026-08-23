import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../src/core/index.ts";
import type { Envelope, Gate } from "../../../src/core/index.ts";

/**
 * The demo blueprint (T01b): a two-phase play — plan, then build — driven by
 * scripted FakePi sessions (spec §17; no pi binary). The scripted sessions
 * live next to this module under fake-pi/<phase>.json and are resolved by the
 * daemon at submit time; each turn ends with the agent "writing" an envelope.
 *
 * The plan phase's first turn writes a low-quality envelope (gate fail), the
 * daemon issues one correction, and the second turn passes — so the run shows
 * the full §5.2 loop: gate fail → correction → success, same session id.
 *
 * Run it with: showrunner run packages/daemon/test/fixtures/demo-blueprint.ts
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope to your outputs directory.",
  tools: ["bash", "edit", "read"],
  context: [],
});

const QualityEnvelope = EnvelopeBase.extend({
  /** 0..10 self-reported quality — the demo gate demands >= 7 */
  quality: z.number().min(0).max(10),
});

const qualityGate: Gate = async (envelope: Envelope, _ctx) => {
  const quality = (envelope as unknown as { quality: number }).quality;
  if (quality >= 7) return { pass: true };
  return { pass: false, violations: [`quality ${quality} is below the required 7`] };
};

export default defineBlueprint({
  name: "demo",
  phases: [
    {
      name: "plan",
      agent: builder,
      envelope: QualityEnvelope,
      gates: [qualityGate],
      budget: 3,
    },
    {
      name: "build",
      agent: builder,
      envelope: QualityEnvelope,
      gates: [qualityGate],
      budget: 3,
    },
  ],
});
