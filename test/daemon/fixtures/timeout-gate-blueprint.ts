import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint, createShell } from "../../../src/core/index.ts";
import type { Gate } from "../../../src/core/index.ts";

/**
 * A one-phase blueprint whose gate runs a command that EXCEEDS its timeout
 * cap (`sleep 5` capped at 500ms) — the doctrine: a gate that exceeds
 * its cap is a violation (error text), never a daemon crash or hang. The gate
 * fails deterministically, so the phase exhausts its budget and pauses.
 *
 * Driven by the existing fake-pi/build.json scripted session.
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope.",
  tools: ["bash"],
  context: [],
});

const GateEnvelope = EnvelopeBase.extend({ quality: z.number() });

/** `sleep 5` under a 500ms cap — killed by the cap, reported as exit -1. */
const cappedGate: Gate = async (_envelope, ctx) => {
  const res = await createShell(ctx.cwd, { timeoutMs: 500 })("sleep 5");
  if (res.code === 0) return { pass: true };
  return {
    pass: false,
    violations: [`gate command exceeded its cap (exit ${res.code}): ${res.stderr || "no output"}`],
  };
};

export default defineBlueprint({
  name: "timeout_gate",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: GateEnvelope,
      gates: [cappedGate],
      budget: 1,
    },
  ],
});
