import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../../src/core/index.ts";
import type { Envelope, Gate } from "../../../../src/core/index.ts";

/**
 * The demo-loop blueprint (R7 acceptance fixture): a four-phase loop
 * plan → implement → review → package in which review FAILS its first visit
 * (budget 1 exhausted — two rejected gate attempts, one correction) and the
 * on_fail jump sends execution BACK to implement for a second visit, after
 * which review v2 passes and the run completes.
 *
 * The exact driven sequence (pinned by test/daemon/demo-loop.test.ts):
 *   plan v1 succeeds → implement v1 succeeds → review v1: attempt 0 fails its
 *   gates, one correction is issued, attempt 1 fails, the correction budget
 *   (1) is exhausted, the phase ends `failed`, and the jump fires →
 *   implement v2 succeeds → review v2 succeeds → package v1 succeeds.
 *
 * The review gate is deterministic and driven by the ENVELOPE content: the
 * shared `qualityGate` requires quality >= 8, and the scripted sessions
 * (fake-pi/<phase>.json) control what quality each visit writes. review v1's
 * scripted turns write quality 5 then 6 (both below 8 — gate violations, so
 * the visit burns its budget); review v2's per-visit script (the `byVisit`
 * seam in the scripted session) writes quality 9 and passes. Plan/implement/
 * package write quality 9 on their first turn and pass outright.
 *
 * Run it with: showrunner run test/daemon/fixtures/demo-loop/demo-loop.ts
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope to your outputs directory.",
  tools: ["bash", "edit", "read"],
  context: [],
});

/** 0..10 self-reported quality — the demo-loop gate demands >= 8. */
const QualityEnvelope = EnvelopeBase.extend({
  quality: z.number().min(0).max(10),
});

const qualityGate: Gate = async (envelope: Envelope) => {
  const quality = (envelope as unknown as { quality: number }).quality;
  if (quality >= 8) return { pass: true };
  return { pass: false, violations: [`quality ${quality} is below the required 8`] };
};

export default defineBlueprint({
  name: "demo-loop",
  phases: [
    {
      name: "plan",
      agent: builder,
      envelope: QualityEnvelope,
      gates: [qualityGate],
      budget: 3,
    },
    {
      name: "implement",
      agent: builder,
      envelope: QualityEnvelope,
      gates: [qualityGate],
      budget: 3,
    },
    {
      name: "review",
      agent: builder,
      envelope: QualityEnvelope,
      gates: [qualityGate],
      // R7: one correction allowed per visit; when the budget is exhausted the
      // phase fails and the jump routes execution back to implement
      budget: 1,
      on_fail: { to: "implement" },
    },
    {
      name: "package",
      agent: builder,
      envelope: QualityEnvelope,
      gates: [qualityGate],
      budget: 3,
    },
  ],
});

// keep the Envelope import for TS consumers of this fixture
export type { Envelope };
