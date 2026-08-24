/**
 * Generate the on-disk FakePi sessions under src/blueprints/fake-pi/ from the
 * same builders the harness uses (src/daemon/pi/harness/session-builder.ts) — the CLI path
 * (`showrunner run <path-to-blueprint>.ts`) resolves each phase's scripted
 * session from <moduleDir>/fake-pi/<phase-slug>.json (daemon).
 *
 *   bun scripts/generate-fake-pi-sessions.ts
 *
 * Phases are keyed by slug and shared across blueprints (every plan phase in
 * every blueprint parses PlanEnvelope), so one JSON per phase slug serves all
 * ten blueprints. Regenerate after editing the builders; the fixtures test
 * (fixtures.test.ts "every blueprint phase resolves...") verifies the result.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildTurn,
  documentTurn,
  planTurn,
  promptTurn,
  reconTurn,
  reviewTurn,
  session,
  shipTurn,
} from "../src/daemon/pi/harness/session-builder.ts";

const OUT = join(import.meta.dir, "..", "src", "starter-kit", "blueprints", "fake-pi");

/** phase slug (handoff.slugFor) → a passing scripted session */
const SESSIONS: Record<string, ReturnType<typeof session>> = {
  do: session([promptTurn()]), // prompt blueprint
  recon: session([reconTurn()]), // scout blueprint
  plan: session([planTurn()]), // plan phase in plan/plan_build/plan_build_test/everything
  build: session([buildTurn()]), // build phase everywhere (incl. build_test's fix)
  fix: session([buildTurn()]), // build_test's fix phase
  review: session([reviewTurn(true)]), // review phase in build_review/plan_build_test/everything
  document: session([documentTurn()]), // document blueprint
  ship: session([shipTurn()]), // ship phase in plan_build/plan_build_test/everything
};

mkdirSync(OUT, { recursive: true });
let n = 0;
for (const [slug, script] of Object.entries(SESSIONS)) {
  writeFileSync(join(OUT, `${slug}.json`), JSON.stringify(script, null, 2) + "\n");
  n += 1;
}
console.log(`generated ${n} scripted sessions in ${OUT}`);
