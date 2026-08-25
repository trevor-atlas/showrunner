import { defineBlueprint } from "../../core/index.ts";
import { documentPhase } from "./patterns.ts";

/**
 * document — write up what just shipped: the git diff goes in via
 * the prompt/context, the documenter produces docs, and the filesExist gate
 * refuses an envelope that lists no artifacts — docs must actually have been
 * written, not just promised.
 *
 * Replace-this: the shared document phase lives in patterns.ts; edit it (or
 * inline a phase here) to change the agent, envelope, or gates.
 */
export default defineBlueprint({
  name: "document",
  phases: [documentPhase()],
});
