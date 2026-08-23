import { defineBlueprint } from "../../core/index.ts";
import { scout } from "../agents/scout.ts";
import { ScoutEnvelope } from "../envelopes.ts";
import { findingsReported } from "../gates/index.ts";

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
      // the findings are the payload — the gate insists the scout wrote its
      // FINDINGS.md to outputs/ and listed it in artifacts, so a scout that
      // reported nothing cannot pass
      gates: [findingsReported()],
      budget: 3,
    },
  ],
});
