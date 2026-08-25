process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi, never real pi
/**
 * Issue #35 — the four phase-card data proxies under /runs/:runId/phases/:phase/
 * (snapshot.json, inputs.json, outputs.json, spend.json), driven through the app
 * router with `router.fetch(...)` (the same hermetic in-process pattern as the
 * R5 envelopes/gates proxy test in run-detail.test.ts). The browser never talks
 * to the daemon or the filesystem: the remix action does, server-side, and
 * returns JSON. Each proxy 404s (as JSON) for a ghost run or ghost phase.
 *
 * spend.json is asserted under Option A (post-#29): the api core's SQL SUM is
 * exact — 5500 spend events sum to 5500 with NO truncated flag and no sweep cap
 * (the old client-side sweep was deleted by #29). This mirrors, against the
 * proxy, run-controls.test.ts's "SQL SUM — no sweep cap, no truncated" scenario.
 *
 * Hermetic: scratch data dir + cwd, in-process daemon closed in finally.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor, runDirFor } from "../../src/core/index.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/daemon.ts";
import { insertEvent, insertPhase, insertRun, openDb } from "../../src/daemon/index.ts";
import { inputsDirFor, outputsDirFor } from "../../src/server/repository/workspace/index.ts";
import { snapshotPathFor } from "../../src/server/lib/blueprint-snapshot.ts";
import type {
  PhaseInputsData,
  PhaseOutputsData,
  PhaseSnapshotData,
  PhaseSpendData,
} from "../../src/server/lib/phase-data.ts";
import { router } from "../../src/server/router.ts";
import { routes } from "../../src/server/routes.ts";

type ProxyKind = "snapshot" | "inputs" | "outputs" | "spend";

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-ui-${label}-`));
}

function setDataDir(dir: string): () => void {
  const saved = process.env.SHOWRUNNER_DATA_DIR;
  process.env.SHOWRUNNER_DATA_DIR = dir;
  return () => {
    if (saved === undefined) delete process.env.SHOWRUNNER_DATA_DIR;
    else process.env.SHOWRUNNER_DATA_DIR = saved;
  };
}

async function fetchProxy(
  runId: string,
  phase: string,
  kind: ProxyKind,
): Promise<{ status: number; json: unknown }> {
  const href = routes.runs.phases[kind].href({ runId, phase });
  const response = await router.fetch(new Request("http://localhost" + href));
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // keep the raw status assertion below
  }
  return { status: response.status, json };
}

const RUN = "35353535-0000-4000-8000-000000000001"; // plan (first) → build
const RUN_NOSNAP = "35353535-0000-4000-8000-000000000002"; // fixture run, no snapshot
const RUN_SWEEP = "35353535-0000-4000-8000-000000000003"; // 5500 spend events
const GHOST = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const iso = (offsetMs: number): string => new Date(Date.now() - 60_000 + offsetMs).toISOString();

/** Seed the two-phase run + its on-disk snapshot / inputs / outputs. `cwd` is a
 * real directory (with a README.md) so a context entry resolves as inlined. */
function seedRun(dir: string, cwd: string): void {
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
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: 0.3,
    started_at: iso(3_000),
    ended_at: null,
  });
  insertEvent(db, {
    run_id: RUN,
    phase_id: "ph-build",
    agent_session_id: null,
    type: "spend",
    ts: iso(4_000),
    data: { phase: "build", tokens_in: 500, tokens_out: 120, cache_read: 10, cache_write: 5, usd: 0.0021, estimated: false },
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

/** A one-phase run with NO blueprint snapshot on disk (fixture/observation). */
function seedNoSnapshotRun(dir: string): void {
  const db = openDb(dbPathFor(dir));
  insertRun(db, {
    id: RUN_NOSNAP,
    blueprint: "fixture",
    status: "success",
    cwd: "/tmp/none",
    needs_review: 0,
    started_at: iso(0),
    ended_at: iso(5_000),
  });
  insertPhase(db, {
    id: "ph-solo",
    run_id: RUN_NOSNAP,
    name: "solo",
    agent: "observer",
    status: "success",
    visits: 1,
    corrections: 0,
    budget: 1,
    spend_usd: 0,
    started_at: iso(1_000),
    ended_at: iso(2_000),
  });
  db.close();
}

/** A run whose build phase has 5500 spend events — the exact-SUM scenario. */
function seedSweepRun(dir: string): void {
  const db = openDb(dbPathFor(dir));
  insertRun(db, {
    id: RUN_SWEEP,
    blueprint: "spendy",
    status: "success",
    cwd: "/tmp/spendy",
    needs_review: 0,
    started_at: iso(0),
    ended_at: iso(5_000),
  });
  insertPhase(db, {
    id: "ph-sweep",
    run_id: RUN_SWEEP,
    name: "build",
    agent: "builder",
    status: "success",
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: 0.55,
    started_at: iso(1_000),
    ended_at: iso(2_000),
  });
  for (let i = 0; i < 5500; i++) {
    insertEvent(db, {
      run_id: RUN_SWEEP,
      phase_id: "ph-sweep",
      agent_session_id: null,
      type: "spend",
      ts: iso(2_000),
      data: { phase: "build", tokens_in: 1, tokens_out: 0, cache_read: 0, cache_write: 0, usd: 0.0001, estimated: false },
    });
  }
  db.close();
}

describe("phase-card data proxies (#35) — snapshot/inputs/outputs/spend.json", () => {
  it("snapshot.json serves the phase's snapshot config with pre-resolved context + blueprint isFirst", async () => {
    const dir = tmpDir("proxy-snapshot");
    const cwd = tmpDir("proxy-cwd");
    writeFileSync(join(cwd, "README.md"), "# readme\n");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedRun(dir, cwd);

      const plan = await fetchProxy(RUN, "plan", "snapshot");
      expect(plan.status).toBe(200);
      const p = plan.json as PhaseSnapshotData;
      expect(p.phase?.agent.name).toBe("planner");
      expect(p.phase?.agent.model).toBe("deepseek-v4-pro");
      expect(p.phase?.agent.tools).toEqual(["bash", "read"]);
      expect(p.phase?.gates).toEqual(["testsPass"]);
      expect(p.isFirst).toBe(true);
      // README.md exists in cwd → inlined; the literal is quoted
      expect(p.context).toEqual([
        { raw: "README.md", kind: "inlined-file", entry: "README.md (inlined)" },
        { raw: "be concise", kind: "literal", entry: '"be concise"' },
      ]);

      const build = await fetchProxy(RUN, "build", "snapshot");
      expect(build.status).toBe(200);
      const b = build.json as PhaseSnapshotData;
      expect(b.phase?.agent.name).toBe("builder");
      expect(b.phase?.require_approval).toBe(true);
      expect(b.phase?.on_fail).toBe("plan");
      expect(b.isFirst).toBe(false);
      expect(b.context).toEqual([]);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("snapshot.json returns phase: null for a run with no blueprint snapshot", async () => {
    const dir = tmpDir("proxy-nosnap");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedNoSnapshotRun(dir);

      const res = await fetchProxy(RUN_NOSNAP, "solo", "snapshot");
      expect(res.status).toBe(200);
      const s = res.json as PhaseSnapshotData;
      expect(s.phase).toBeNull();
      expect(s.context).toEqual([]);
      expect(s.isFirst).toBe(true); // sole phase → first
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inputs.json lists the materialized handoff, caps per-file contents at 16KB, and flags first-phase 'none'", async () => {
    const dir = tmpDir("proxy-inputs");
    const cwd = tmpDir("proxy-inputs-cwd");
    writeFileSync(join(cwd, "README.md"), "# readme\n");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedRun(dir, cwd);

      const build = await fetchProxy(RUN, "build", "inputs");
      expect(build.status).toBe(200);
      const b = build.json as PhaseInputsData;
      expect(b.isFirst).toBe(false);
      expect(b.files.map((f) => f.rel).sort()).toEqual(["big.txt", "envelope.json", "plan.md"]);
      const big = b.files.find((f) => f.rel === "big.txt")!;
      expect(big.truncated).toBe(true);
      expect(big.contents.length).toBe(16 * 1024);
      const plan = b.files.find((f) => f.rel === "plan.md")!;
      expect(plan.truncated).toBe(false);
      expect(plan.contents).toBe("# plan\n");

      // the first phase has no predecessor handoff → isFirst true, files []
      const first = await fetchProxy(RUN, "plan", "inputs");
      expect(first.status).toBe(200);
      const f = first.json as PhaseInputsData;
      expect(f.isFirst).toBe(true);
      expect(f.files).toEqual([]);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("outputs.json lists the phase's outputs/ dir + FINDINGS.md (empty for a phase with none)", async () => {
    const dir = tmpDir("proxy-outputs");
    const cwd = tmpDir("proxy-outputs-cwd");
    writeFileSync(join(cwd, "README.md"), "# readme\n");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedRun(dir, cwd);

      const build = await fetchProxy(RUN, "build", "outputs");
      expect(build.status).toBe(200);
      const b = build.json as PhaseOutputsData;
      expect(b.files.sort()).toEqual(["FINDINGS.md", "result.txt"]);
      expect(b.findingsMd).toBe("# findings\nall good\n");

      const plan = await fetchProxy(RUN, "plan", "outputs");
      expect(plan.status).toBe(200);
      expect(plan.json as PhaseOutputsData).toEqual({ files: [], findingsMd: null });
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("spend.json returns per-phase tokens/USD off the api core's exact SQL SUM (no truncated field)", async () => {
    const dir = tmpDir("proxy-spend");
    const cwd = tmpDir("proxy-spend-cwd");
    writeFileSync(join(cwd, "README.md"), "# readme\n");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedRun(dir, cwd);

      const res = await fetchProxy(RUN, "build", "spend");
      expect(res.status).toBe(200);
      const s = res.json as PhaseSpendData;
      expect(s.tokensIn).toBe(500);
      expect(s.tokensOut).toBe(120);
      expect(s.cacheRead).toBe(10);
      expect(s.cacheWrite).toBe(5);
      // Option A: the SQL SUM is exact — no truncated flag on the wire
      expect(Object.keys(s).sort()).toEqual([
        "cacheRead",
        "cacheWrite",
        "estimatedUsd",
        "spendUsd",
        "tokensIn",
        "tokensOut",
      ]);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("spend.json sums 5500 spend events exactly — SQL SUM, no sweep cap, no truncated", async () => {
    const dir = tmpDir("proxy-spend-sweep");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedSweepRun(dir);

      const res = await fetchProxy(RUN_SWEEP, "build", "spend");
      expect(res.status).toBe(200);
      const s = res.json as PhaseSpendData;
      // 1 token × 5500 events — the exact total (a 10-page sweep cap would
      // have reported 5,000; #29 removed the cap)
      expect(s.tokensIn).toBe(5500);
      expect("truncated" in (res.json as object)).toBe(false);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 60_000 });

  it("every proxy 404s (as JSON) for a ghost run and a ghost phase", async () => {
    const dir = tmpDir("proxy-404");
    const cwd = tmpDir("proxy-404-cwd");
    writeFileSync(join(cwd, "README.md"), "# readme\n");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedRun(dir, cwd);

      const kinds: ProxyKind[] = ["snapshot", "inputs", "outputs", "spend"];
      for (const kind of kinds) {
        const ghostRun = await fetchProxy(GHOST, "build", kind);
        expect(ghostRun.status).toBe(404);
        expect((ghostRun.json as { error: string }).error).toContain("not found");

        const ghostPhase = await fetchProxy(RUN, "ghost", kind);
        expect(ghostPhase.status).toBe(404);
        expect((ghostPhase.json as { error: string }).error).toContain("not found");
      }
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
