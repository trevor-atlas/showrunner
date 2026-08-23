import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../src/core/index.ts";

/**
 * A one-phase blueprint whose §14 hooks BOTH fire with ctx.shell() — each
 * appends a marker line to `<run-cwd>/hooks.log` via the hook's shell()
 * escape hatch. The marker records the phase name and $PWD (the run's cwd —
 * ctx.shell() runs there, §3.7), so the contract test can prove onPhaseStart
 * AND onPhaseEnd fired, in order, with a working shell in the right cwd.
 * Driven by the existing fake-pi/build.json scripted session.
 */
const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write a typed envelope.",
  tools: ["bash"],
  context: [],
});

export default defineBlueprint({
  name: "hook-demo",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: EnvelopeBase,
      gates: [],
      budget: 3,
    },
  ],
  onPhaseStart: async (ctx) => {
    const res = await ctx.shell(`printf 'start %s in %s\\n' "${ctx.phase}" "$PWD" >> hooks.log`);
    if (res.code !== 0) throw new Error(`onPhaseStart shell failed: ${res.stderr}`);
  },
  onPhaseEnd: async (ctx) => {
    const res = await ctx.shell(`printf 'end %s\\n' "${ctx.phase}" >> hooks.log`);
    if (res.code !== 0) throw new Error(`onPhaseEnd shell failed: ${res.stderr}`);
  },
});
