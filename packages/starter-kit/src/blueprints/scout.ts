import { defineBlueprint } from "@showrunner/core";
import { scout } from "../agents/scout.ts";
import { ScoutEnvelope } from "../envelopes.ts";
import { envelopeShape } from "../gates/index.ts";

/**
 * scout — read-only recon (PLAN §14). Nothing changes: the scout explores,
 * reports findings, and the run ends. Reach for it before any code moves.
 *
 * Replace-this: the agent, envelope, and gates are the point of this file.
 */
export default defineBlueprint({
  name: "scout",
  phases: [
    {
      name: "recon",
      agent: scout,
      envelope: ScoutEnvelope,
      // the envelope must carry findings — the whole point of a recon phase
      gates: [envelopeShape(ScoutEnvelope)],
      budget: 3,
    },
  ],
});
