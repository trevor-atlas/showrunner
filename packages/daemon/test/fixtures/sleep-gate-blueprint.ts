import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint, createShell } from "@showrunner/core";
import type { Gate } from "@showrunner/core";

/**
 * A one-phase blueprint whose gate REALLY runs a shell command (`sleep 2.5`)
 * via core's createShell — the §19 backpressure scenario at the HTTP seam:
 * while the gate executes, the daemon's event loop must stay responsive
 * (health/runs requests resolve DURING the gate). A spawnSync gate would
 * freeze every HTTP response for the gate's whole duration.
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

/** Runs a real 2.5s sleep as a gate — pass is unconditional after it returns.
 * Writes a marker file first so a test can probe the daemon WHILE the gate is
 * executing (the §19 backpressure window). */
const sleepingGate: Gate = async (_envelope, ctx) => {
  writeFileSync(join(ctx.cwd, "gate-started.marker"), "started\n");
  const res = await createShell(ctx.cwd)("sleep 2.5");
  if (res.code !== 0) {
    return { pass: false, violations: [`sleep gate crashed (exit ${res.code}): ${res.stderr}`] };
  }
  return { pass: true };
};

export default defineBlueprint({
  name: "sleep_gate",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: GateEnvelope,
      gates: [sleepingGate],
      budget: 1,
    },
  ],
});
