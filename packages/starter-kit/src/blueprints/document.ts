import { defineBlueprint } from "@showrunner/core";
import { documenter } from "../agents/documenter.ts";
import { DocumentEnvelope } from "../envelopes.ts";
import { envelopeShape, filesExist } from "../gates/index.ts";

/**
 * document — write up what just shipped (PLAN §14): the git diff goes in via
 * the prompt/context, the documenter produces docs, and the filesExist gate
 * refuses an envelope that lists no artifacts — docs must actually have been
 * written, not just promised.
 *
 * Replace-this: the agent, envelope, and gates are the point of this file.
 */
export default defineBlueprint({
  name: "document",
  phases: [
    {
      name: "document",
      agent: documenter,
      envelope: DocumentEnvelope,
      gates: [envelopeShape(DocumentEnvelope), filesExist()],
      budget: 3,
    },
  ],
});
