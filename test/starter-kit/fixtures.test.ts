process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ScriptMap } from "../../src/daemon/runner.ts";
import { cursorEvents, listPhases, openDb, resolveScriptedSessions, runBlueprint } from "../../src/daemon/index.ts";

import promptBlueprint from "../../src/starter-kit/blueprints/prompt.ts";
import scoutBlueprint from "../../src/starter-kit/blueprints/scout.ts";
import planBlueprint from "../../src/starter-kit/blueprints/plan.ts";
import buildBlueprint from "../../src/starter-kit/blueprints/build.ts";
import planBuildBlueprint from "../../src/starter-kit/blueprints/plan_build.ts";
import buildTestBlueprint from "../../src/starter-kit/blueprints/build_test.ts";
import buildReviewBlueprint from "../../src/starter-kit/blueprints/build_review.ts";
import planBuildTestBlueprint from "../../src/starter-kit/blueprints/plan_build_test.ts";
import documentBlueprint from "../../src/starter-kit/blueprints/document.ts";
import everythingBlueprint from "../../src/starter-kit/blueprints/everything.ts";

import { buildTurn, documentTurn, planTurn, promptTurn, reconTurn, reviewTurn, session, shipTurn } from "./session-builder.ts";
import { failingWorkspace, passingWorkspace, rmDir, runToTerminal, tmpDir } from "./helpers.ts";
import type { Blueprint } from "../../src/core/index.ts";

/**
 * The starter kit's own fixtures (spec §17, §15) — FakePi drives every one of
 * the ten starter blueprints (and therefore all six agents) end-to-end:
 * envelope accepted, gates run and recorded, terminal success — plus a
 * bounded fix loop that exercises on_fail routing in both directions and the
 * visit guard. These are STARTER tests, replaceable by design.
 */

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmDir(d);
});

interface RunEnv {
  dataDir: string;
  cwd: string;
  db: ReturnType<typeof openDb>;
}

function env(label: string, workspace: (d: string) => void = () => {}): RunEnv {
  const dataDir = tmpDir(`fixtures-${label}-data`);
  const cwd = tmpDir(`fixtures-${label}-cwd`);
  workspace(cwd);
  cleanups.push(dataDir, cwd);
  return { dataDir, cwd, db: openDb(join(dataDir, "showrunner.db")) };
}

function gatePassed(db: ReturnType<typeof openDb>, runId: string, gate: string): boolean {
  return cursorEvents(db, runId, 0, 10_000).some(
    (e) => e.type === "gate_result" && (e.data as { gate: string; pass: boolean }).gate === gate && (e.data as { pass: boolean }).pass,
  );
}

function eventCount(db: ReturnType<typeof openDb>, runId: string, type: string): number {
  return cursorEvents(db, runId, 0, 10_000).filter((e) => e.type === type).length;
}

/** Run one blueprint to success with the given per-phase sessions. */
async function runToSuccess(e: RunEnv, blueprint: Blueprint, scripts: ScriptMap): Promise<string> {
  const run = runBlueprint(e.db, e.dataDir, { blueprint, cwd: e.cwd, scripts });
  const result = await runToTerminal(run);
  expect(result).toEqual({ status: "success", needs_review: false });
  for (const phase of blueprint.phases) {
    const row = listPhases(e.db, run.run_id).find((p) => p.name === phase.name);
    expect(row?.status, `phase ${phase.name} status`).toBe("success");
  }
  expect(eventCount(e.db, run.run_id, "envelope")).toBeGreaterThan(0);
  return run.run_id;
}

// ── one blueprint per agent (six agents, §15) ────────────────────────────────

test("scout runs end-to-end (scout agent, recon phase)", async () => {
  const e = env("scout");
  const runId = await runToSuccess(e, scoutBlueprint, { recon: session([reconTurn()]) });
  expect(gatePassed(e.db, runId, "envelopeShape")).toBe(true); // findings gate ran
});

test("plan runs end-to-end (planner agent)", async () => {
  const e = env("plan");
  await runToSuccess(e, planBlueprint, { plan: session([planTurn()]) });
});

test("build runs end-to-end (builder agent)", async () => {
  const e = env("build");
  await runToSuccess(e, buildBlueprint, { build: session([buildTurn()]) });
});

test("prompt runs end-to-end (single phase, default planner agent)", async () => {
  const e = env("prompt");
  await runToSuccess(e, promptBlueprint, { do: session([promptTurn()]) });
});

test("document runs end-to-end (documenter agent; filesExist gate insists on artifacts)", async () => {
  const e = env("document");
  const runId = await runToSuccess(e, documentBlueprint, { document: session([documentTurn()]) });
  expect(gatePassed(e.db, runId, "filesExist")).toBe(true);
});

// ── multi-phase chains ───────────────────────────────────────────────────────

test("plan_build runs plan → build → ship; ship waits for human approval; matchesPlan ran", async () => {
  const e = env("plan-build");
  const runId = await runToSuccess(e, planBuildBlueprint, {
    plan: session([planTurn()]),
    build: session([buildTurn()]),
    ship: session([shipTurn()]),
  });
  // the build phase's matchesPlan gate saw the plan arrive via the §9.3 handoff
  expect(gatePassed(e.db, runId, "matchesPlan")).toBe(true);
  // the ship phase was a real approval pause: a human_action approve was recorded
  const approves = cursorEvents(e.db, runId, 0, 10_000).filter(
    (ev) => ev.type === "human_action" && (ev.data as { action: string }).action === "approve",
  );
  expect(approves.length).toBe(1);
}, { timeout: 30_000 });

test("build_test succeeds when the suite is green (testsPass + lintClean run in a real run)", async () => {
  const e = env("build-test-pass", passingWorkspace);
  const runId = await runToSuccess(e, buildTestBlueprint, {
    build: session([buildTurn()]),
    fix: session([buildTurn()]),
  });
  expect(gatePassed(e.db, runId, "testsPass")).toBe(true);
  expect(gatePassed(e.db, runId, "lintClean")).toBe(true);
}, { timeout: 30_000 });

test("build_test bounded fix loop: a red suite routes build ⇄ fix until the visit guard pauses", async () => {
  // each gate attempt spawns a real `bun test` in the red workspace, so the
  // loop runs 6 visits × 4 attempts — headroom over the 5s default timeout
  const e = env("build-test-loop", failingWorkspace);
  const run = runBlueprint(e.db, e.dataDir, {
    blueprint: buildTestBlueprint,
    cwd: e.cwd,
    scripts: { build: session([buildTurn()]), fix: session([buildTurn()]) },
  });
  const result = await run.done;
  expect(result).toEqual({ status: "paused", needs_review: false });
  // the loop bounced off the budget in BOTH directions and hit the visit guard
  const phases = listPhases(e.db, run.run_id);
  const build = phases.find((p) => p.name === "build")!;
  const fix = phases.find((p) => p.name === "fix")!;
  expect(build.visits).toBe(3); // max_visits default
  expect(fix.visits).toBe(3);
  expect(build.corrections).toBe(3); // budget exhausted each visit
  expect(fix.corrections).toBe(3);
  const last = cursorEvents(e.db, run.run_id, 0, 10_000)
    .filter((ev) => ev.type === "run_status")
    .at(-1)!.data as { to: string; reason?: string };
  expect(last.to).toBe("paused");
  expect(last.reason).toMatch(/max_visits|guard/);
}, { timeout: 30_000 });

test("build_review runs end-to-end (reviewer approves; reviewApproved gate ran)", async () => {
  const e = env("build-review");
  const runId = await runToSuccess(e, buildReviewBlueprint, {
    build: session([buildTurn()]),
    review: session([reviewTurn(true)]),
  });
  expect(gatePassed(e.db, runId, "reviewApproved")).toBe(true);
}, { timeout: 30_000 });

test("plan_build_test runs the standard chain (plan → build → review → ship)", async () => {
  const e = env("plan-build-test", passingWorkspace);
  const runId = await runToSuccess(e, planBuildTestBlueprint, {
    plan: session([planTurn()]),
    build: session([buildTurn()]),
    review: session([reviewTurn(true)]),
    ship: session([shipTurn()]),
  });
  expect(gatePassed(e.db, runId, "testsPass")).toBe(true);
  expect(gatePassed(e.db, runId, "lintClean")).toBe(true);
  expect(gatePassed(e.db, runId, "matchesPlan")).toBe(true);
  expect(gatePassed(e.db, runId, "reviewApproved")).toBe(true);
}, { timeout: 30_000 });

test("everything runs end-to-end with two human approvals (plan and ship)", async () => {
  const e = env("everything", passingWorkspace);
  const runId = await runToSuccess(e, everythingBlueprint, {
    plan: session([planTurn()]),
    build: session([buildTurn()]),
    review: session([reviewTurn(true)]),
    ship: session([shipTurn()]),
  });
  const approves = cursorEvents(e.db, runId, 0, 10_000).filter(
    (ev) => ev.type === "human_action" && (ev.data as { action: string }).action === "approve",
  );
  expect(approves.length).toBe(2);
}, { timeout: 30_000 });

// ── CLI path: on-disk scripted sessions (spec §13.3, §17) ────────────────────

test("every blueprint phase resolves a scripted FakePi session for the CLI path (src/starter-kit/blueprints/fake-pi)", () => {
  const blueprints = [
    promptBlueprint,
    scoutBlueprint,
    planBlueprint,
    buildBlueprint,
    planBuildBlueprint,
    buildTestBlueprint,
    buildReviewBlueprint,
    planBuildTestBlueprint,
    documentBlueprint,
    everythingBlueprint,
  ];
  const fakePiDir = join(import.meta.dir, "..", "..", "src", "starter-kit", "blueprints", "fake-pi");
  for (const blueprint of blueprints) {
    // throws listing the missing session(s) if any phase has none
    resolveScriptedSessions(blueprint, fakePiDir);
  }
});
