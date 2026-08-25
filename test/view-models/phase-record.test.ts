/**
 * Ticket #47 — the dead-but-tested phase-record view-model.
 *
 * buildPhaseRecordModel(db, dataDir, runId, phaseName) assembles ONE phase
 * record from the persistence handles (a SQLite handle + the run's data dir),
 * reproducing the fields the six phase proxies serve today:
 *   snapshot/context, inputs, outputs, spend, envelopes, gates, visit history.
 *
 * The acceptance is shape-parity with the current proxies: snapshot/inputs/
 * outputs are asserted against known-good seed literals (the model is now the
 * single phase-record assembler — the old phase-data.ts gathers are gone), and
 * envelopes/gates/spend are asserted against the api core code paths, proving
 * the model is a faithful port, not a parallel re-derivation. Hermetic: scratch
 * data dir + cwd, no daemon.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor, runDirFor } from "../../src/core/index.ts";
import {
  insertEnvelope,
  insertEvent,
  insertGateOverride,
  insertGateResult,
  insertPhase,
  insertPhaseVisit,
  insertRun,
  openDb,
} from "../../src/daemon/db.ts";
import { apiPhaseEnvelopes, apiPhaseGates, apiSpend } from "../../src/daemon/index.ts";
import type { ApiState } from "../../src/daemon/server.ts";
import { inputsDirFor, outputsDirFor } from "../../src/daemon/workspace/index.ts";
import { snapshotPathFor } from "../../src/ui/app/lib/blueprint-snapshot.ts";
import { buildPhaseRecordModel } from "../../src/view-models/index.ts";

const RUN = "47474747-0000-4000-8000-000000000001"; // plan (first) → build
const GHOST = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-vm-${label}-`));
}

function setDataDir(dir: string): () => void {
  const saved = process.env.SHOWRUNNER_DATA_DIR;
  process.env.SHOWRUNNER_DATA_DIR = dir;
  return () => {
    if (saved === undefined) delete process.env.SHOWRUNNER_DATA_DIR;
    else process.env.SHOWRUNNER_DATA_DIR = saved;
  };
}

const iso = (offsetMs: number): string => new Date(Date.now() - 60_000 + offsetMs).toISOString();

/** Minimal ApiState for the api-core parity calls — those endpoints touch only
 * db + dataDir (never pool/startedAt), so the cast is safe for the comparison. */
function apiState(db: ReturnType<typeof openDb>, dir: string): ApiState {
  return { db, dataDir: dir, startedAt: 0 } as unknown as ApiState;
}

/** Seed the two-phase run + its on-disk snapshot / inputs / outputs plus the
 * envelope / gate / override / phase_visit rows the drill-in reads. `cwd` is a
 * real directory (with a README.md) so a context entry resolves as inlined. */
function seed(dir: string, cwd: string): void {
  const db = openDb(dbPathFor(dir));
  insertRun(db, {
    id: RUN,
    blueprint: "demo",
    status: "paused",
    cwd,
    needs_review: 0,
    started_at: iso(0),
    ended_at: null,
  });
  insertPhase(db, {
    id: "ph-plan",
    run_id: RUN,
    name: "plan",
    agent: "planner",
    status: "success",
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: 0.12,
    started_at: iso(1_000),
    ended_at: iso(2_000),
  });
  insertPhase(db, {
    id: "ph-build",
    run_id: RUN,
    name: "build",
    agent: "builder",
    status: "in_progress",
    visits: 2,
    corrections: 1,
    budget: 3,
    spend_usd: 0.3,
    started_at: iso(3_000),
    ended_at: null,
  });

  // spend events on build — the exact SQL SUM the spend proxy reports
  insertEvent(db, {
    run_id: RUN,
    phase_id: "ph-build",
    agent_session_id: null,
    type: "spend",
    ts: iso(4_000),
    data: { phase: "build", tokens_in: 500, tokens_out: 120, cache_read: 10, cache_write: 5, usd: 0.0021, estimated: false },
  });
  insertEvent(db, {
    run_id: RUN,
    phase_id: "ph-build",
    agent_session_id: null,
    type: "spend",
    ts: iso(4_500),
    data: { phase: "build", tokens_in: 40, tokens_out: 8, cache_read: 0, cache_write: 0, usd: 0.0009, estimated: true },
  });

  // build's per-visit rows (the visit history), plus envelopes + gates + an
  // override so the gate section carries the audit badge
  insertPhaseVisit(db, {
    id: "pv-build-1",
    phase_id: "ph-build",
    visit_number: 1,
    cause: null,
    status: "success",
    started_at: iso(3_000),
    ended_at: iso(3_500),
    agent_session_id: null,
  });
  insertPhaseVisit(db, {
    id: "pv-build-2",
    phase_id: "ph-build",
    visit_number: 2,
    cause: "gate testsPass failed",
    status: "in_progress",
    started_at: iso(4_000),
    ended_at: null,
    agent_session_id: null,
  });
  insertEnvelope(db, {
    id: "env-build-0",
    run_id: RUN,
    phase_id: "ph-build",
    visit: 1,
    attempt: 0,
    json: "not json",
    source: "build/envelope.json",
    validated_at: iso(3_200),
    valid: 0,
    violations: JSON.stringify(["expected 3 tests, got 2"]),
    correction: "tests failed: expected 3, got 2 — fix t1",
    visit_id: "pv-build-1",
  });
  insertEnvelope(db, {
    id: "env-build-1",
    run_id: RUN,
    phase_id: "ph-build",
    visit: 2,
    attempt: 0,
    json: JSON.stringify({ summary: "built it", artifacts: ["result.txt"] }),
    source: "build/envelope.json",
    validated_at: iso(4_200),
    valid: 1,
    violations: "[]",
    correction: null,
    visit_id: "pv-build-2",
  });
  insertGateResult(db, {
    id: "gr-build-0",
    envelope_id: "env-build-0",
    gate: "testsPass",
    pass: 0,
    violations: JSON.stringify(["expected 3 tests, got 2"]),
    ran_at: iso(3_300),
  });
  insertGateOverride(db, {
    id: "go-build-0",
    gate_result_id: "gr-build-0",
    run_id: RUN,
    envelope_id: "env-build-0",
    by: "web",
    reason: "flaky test — verified locally",
    created_at: iso(3_400),
  });
  db.close();

  const doc = {
    name: "demo",
    module: join(cwd, "blueprint.ts"),
    args: null,
    max_visits: 3,
    phases: [
      {
        name: "plan",
        agent: {
          name: "planner",
          model: "deepseek-v4-pro",
          prompt: "plan the work",
          tools: ["bash", "read"],
          context: ["README.md", "be concise"],
        },
        budget: 3,
        require_approval: false,
        on_fail: null,
        gates: ["testsPass"],
        envelope: { schema: "v1" },
      },
      {
        name: "build",
        agent: { name: "builder", model: "fake-pi", prompt: "build it", tools: [], context: [] },
        budget: 3,
        require_approval: true,
        on_fail: "plan",
        gates: [],
        envelope: null,
      },
    ],
    hooks: { onPhaseStart: false, onPhaseEnd: false },
  };
  const runDir = runDirFor(dir, RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(snapshotPathFor(dir, RUN), JSON.stringify(doc));

  const buildInputs = inputsDirFor(runDir, "build");
  mkdirSync(buildInputs, { recursive: true });
  writeFileSync(join(buildInputs, "envelope.json"), '{"summary":"scoped"}');
  writeFileSync(join(buildInputs, "plan.md"), "# plan\n");
  writeFileSync(join(buildInputs, "big.txt"), "x".repeat(20 * 1024)); // > 16KB cap

  const buildOutputs = outputsDirFor(runDir, "build");
  mkdirSync(buildOutputs, { recursive: true });
  writeFileSync(join(buildOutputs, "result.txt"), "done");
  writeFileSync(join(buildOutputs, "FINDINGS.md"), "# findings\nall good\n");
}

function withSeed(label: string, fn: (dir: string, cwd: string) => void): void {
  const dir = tmpDir(label);
  const cwd = tmpDir(`${label}-cwd`);
  writeFileSync(join(cwd, "README.md"), "# readme\n");
  const restore = setDataDir(dir);
  try {
    seed(dir, cwd);
    fn(dir, cwd);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("buildPhaseRecordModel (#47) — assembled phase record", () => {
  it("returns null for a ghost run and for a ghost phase", () => {
    withSeed("null", (dir) => {
      const db = openDb(dbPathFor(dir));
      try {
        expect(buildPhaseRecordModel(db, dir, GHOST, "build")).toBeNull();
        expect(buildPhaseRecordModel(db, dir, RUN, "ghost")).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  it("assembles snapshot/context matching the snapshot proxy (blueprint config + resolved context + isFirst)", () => {
    withSeed("snapshot", (dir, cwd) => {
      const db = openDb(dbPathFor(dir));
      try {
        const plan = buildPhaseRecordModel(db, dir, RUN, "plan")!;
        expect(plan.snapshot.phase?.agent.name).toBe("planner");
        expect(plan.snapshot.phase?.gates).toEqual(["testsPass"]);
        expect(plan.snapshot.isFirst).toBe(true);
        expect(plan.snapshot.context).toEqual([
          { raw: "README.md", kind: "inlined-file", entry: "README.md (inlined)" },
          { raw: "be concise", kind: "literal", entry: '"be concise"' },
        ]);
        // full snapshot shape (the model is the single phase-record assembler)
        expect(plan.snapshot).toEqual({
          phase: {
            name: "plan",
            agent: {
              name: "planner",
              model: "deepseek-v4-pro",
              prompt: "plan the work",
              tools: ["bash", "read"],
              context: ["README.md", "be concise"],
            },
            budget: 3,
            require_approval: false,
            on_fail: null,
            gates: ["testsPass"],
            envelope: { schema: "v1" },
          },
          moduleDir: cwd,
          context: [
            { raw: "README.md", kind: "inlined-file", entry: "README.md (inlined)" },
            { raw: "be concise", kind: "literal", entry: '"be concise"' },
          ],
          isFirst: true,
        });

        const build = buildPhaseRecordModel(db, dir, RUN, "build")!;
        expect(build.snapshot.phase?.require_approval).toBe(true);
        expect(build.snapshot.phase?.on_fail).toBe("plan");
        expect(build.snapshot.isFirst).toBe(false);
        expect(build.snapshot.context).toEqual([]);
        expect(build.snapshot).toEqual({
          phase: {
            name: "build",
            agent: { name: "builder", model: "fake-pi", prompt: "build it", tools: [], context: [] },
            budget: 3,
            require_approval: true,
            on_fail: "plan",
            gates: [],
            envelope: null,
          },
          moduleDir: cwd,
          context: [],
          isFirst: false,
        });
      } finally {
        db.close();
      }
    });
  });

  it("assembles inputs matching the inputs proxy (materialized handoff, 16KB cap, first-phase 'none')", () => {
    withSeed("inputs", (dir) => {
      const db = openDb(dbPathFor(dir));
      try {
        const build = buildPhaseRecordModel(db, dir, RUN, "build")!;
        expect(build.inputs.isFirst).toBe(false);
        expect(build.inputs.files.map((f) => f.rel).sort()).toEqual(["big.txt", "envelope.json", "plan.md"]);
        const big = build.inputs.files.find((f) => f.rel === "big.txt")!;
        expect(big.truncated).toBe(true);
        expect(big.contents.length).toBe(16 * 1024);
        expect(build.inputs).toEqual({
          isFirst: false,
          files: [
            { rel: "big.txt", contents: "x".repeat(16 * 1024), truncated: true },
            { rel: "envelope.json", contents: '{"summary":"scoped"}', truncated: false },
            { rel: "plan.md", contents: "# plan\n", truncated: false },
          ],
        });

        const plan = buildPhaseRecordModel(db, dir, RUN, "plan")!;
        expect(plan.inputs.isFirst).toBe(true);
        expect(plan.inputs.files).toEqual([]);
        expect(plan.inputs).toEqual({ files: [], isFirst: true });
      } finally {
        db.close();
      }
    });
  });

  it("assembles outputs matching the outputs proxy (outputs/ listing + FINDINGS.md)", () => {
    withSeed("outputs", (dir) => {
      const db = openDb(dbPathFor(dir));
      try {
        const build = buildPhaseRecordModel(db, dir, RUN, "build")!;
        expect([...build.outputs.files].sort()).toEqual(["FINDINGS.md", "result.txt"]);
        expect(build.outputs.findingsMd).toBe("# findings\nall good\n");

        const plan = buildPhaseRecordModel(db, dir, RUN, "plan")!;
        expect(plan.outputs).toEqual({ files: [], findingsMd: null });
      } finally {
        db.close();
      }
    });
  });

  it("assembles spend matching the spend proxy (per-phase tokens/USD off the exact SQL SUM)", () => {
    withSeed("spend", (dir) => {
      const db = openDb(dbPathFor(dir));
      try {
        const build = buildPhaseRecordModel(db, dir, RUN, "build")!;
        expect(build.spend.tokensIn).toBe(540);
        expect(build.spend.tokensOut).toBe(128);
        expect(build.spend.cacheRead).toBe(10);
        expect(build.spend.cacheWrite).toBe(5);
        expect(Object.keys(build.spend).sort()).toEqual([
          "cacheRead",
          "cacheWrite",
          "estimatedUsd",
          "spendUsd",
          "tokensIn",
          "tokensOut",
        ]);
        // exact parity with the api core's spend breakdown for this phase
        const breakdown = apiSpend(apiState(db, dir), RUN);
        const p = breakdown.phases.find((x) => x.id === "ph-build")!;
        expect(build.spend).toEqual({
          tokensIn: p.tokens_in,
          tokensOut: p.tokens_out,
          cacheRead: p.cache_read,
          cacheWrite: p.cache_write,
          spendUsd: p.spend_usd,
          estimatedUsd: p.estimated_spend_usd,
        });
      } finally {
        db.close();
      }
    });
  });

  it("assembles envelopes matching the envelopes proxy (all attempts, visit → attempt order)", () => {
    withSeed("envelopes", (dir) => {
      const db = openDb(dbPathFor(dir));
      try {
        const build = buildPhaseRecordModel(db, dir, RUN, "build")!;
        expect(build.envelopes.run_id).toBe(RUN);
        expect(build.envelopes.phase).toBe("build");
        expect(build.envelopes.phase_id).toBe("ph-build");
        expect(build.envelopes.envelopes.map((e) => e.id)).toEqual(["env-build-0", "env-build-1"]);
        expect(build.envelopes).toEqual(apiPhaseEnvelopes(apiState(db, dir), RUN, "build"));
      } finally {
        db.close();
      }
    });
  });

  it("assembles gates matching the gates proxy (results incl. the override badge)", () => {
    withSeed("gates", (dir) => {
      const db = openDb(dbPathFor(dir));
      try {
        const build = buildPhaseRecordModel(db, dir, RUN, "build")!;
        expect(build.gates.run_id).toBe(RUN);
        expect(build.gates.phase_id).toBe("ph-build");
        expect(build.gates.gates).toHaveLength(1);
        const gate = build.gates.gates[0]!;
        expect(gate.pass).toBe(0);
        expect(gate.overridden).toBe(1);
        expect(gate.override_by).toBe("web");
        expect(build.gates).toEqual(apiPhaseGates(apiState(db, dir), RUN, "build"));
      } finally {
        db.close();
      }
    });
  });

  it("assembles the visit history (phase_visits in visit_number order)", () => {
    withSeed("visits", (dir) => {
      const db = openDb(dbPathFor(dir));
      try {
        const build = buildPhaseRecordModel(db, dir, RUN, "build")!;
        expect(build.visits.map((v) => v.visit_number)).toEqual([1, 2]);
        expect(build.visits[0]!.id).toBe("pv-build-1");
        expect(build.visits[1]!.cause).toBe("gate testsPass failed");
        expect(build.visits[1]!.status).toBe("in_progress");

        // the first phase has no recorded visits — an empty history, not an error
        const plan = buildPhaseRecordModel(db, dir, RUN, "plan")!;
        expect(plan.visits).toEqual([]);
      } finally {
        db.close();
      }
    });
  });
});
