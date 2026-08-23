/**
 * T11 acceptance e2e: the phase drill-in page (§16.8, issue #16) rendered from
 * REAL daemon data — server-side only, driven through the app router with
 * `router.fetch(...)` (the same hermetic pattern as T09's run-list suite).
 *
 * The run is a REAL blueprint run on FakePi: build phase produces an invalid
 * attempt → a gate-violations attempt → a correction → an accepted attempt;
 * verify phase exhausts its budget (every attempt fails the gate) → the run
 * PAUSES → the test overrides the failed gate through the §13.2 HTTP verb
 * (audited: who + why) → the drill-in shows the override badge. The blueprint
 * module is MUTATED after submit to prove the CONFIG card renders the §13.3
 * snapshot (what actually ran), never the live module.
 *
 * Hermetic: every test uses its own mkdtemp data dir + cwd, writes its own
 * prices.json (roster estimate path), and closes its daemon; the mutated
 * fixture module is always restored. No repo or ~/.showrunner residue.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor } from "@showrunner/core";
import { DaemonClient } from "../../daemon/src/client.ts";
import { startDaemon, type DaemonHandle } from "../../daemon/src/daemon.ts";
import { insertPhase, insertRun, openDb, updateRun } from "../../daemon/src/db.ts";
import { router } from "../app/router.ts";
import { routes } from "../app/routes.ts";

const BLUEPRINT = new URL("./fixtures/drill-in/drill-in-blueprint.ts", import.meta.url).pathname;
/** the prompt line the test swaps OUT after submit to prove snapshot-not-live */
const ORIGINAL_PROMPT_LINE = "If a gate rejects your envelope, read the violation and fix it.";
const MUTATION_MARKER = "MUTATED-PROMPT-MARKER";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${ms}ms`);
}

async function fetchDrillIn(runId: string, phase: string): Promise<{ status: number; html: string }> {
  const response = await router.fetch(
    new Request("http://localhost" + routes.runs.phases.show.href({ runId, phase })),
  );
  return { status: response.status, html: await response.text() };
}

describe("phase drill-in (T11)", () => {
  it("renders every card for a real run: snapshot config, attempts, gates + override, spend, raw tail", async () => {
    const dir = tmpDir("drillin");
    const cwd = tmpDir("drillin-cwd");
    // the run's cwd carries the context file the blueprint references
    writeFileSync(join(cwd, "README.md"), "demo repo rules readme");
    // the §11.1 roster — verify's cost-free usage becomes an ESTIMATE
    writeFileSync(join(dir, "prices.json"), JSON.stringify({ "fake-pi": { in_per_mtok: 2, out_per_mtok: 8 } }));
    const restore = setDataDir(dir);
    const originalModule = readFileSync(BLUEPRINT, "utf8");
    let daemon: DaemonHandle | null = null;
    try {
      daemon = startDaemon({ dataDir: dir });
      const client = new DaemonClient({ socketPath: daemon.socketPath! });

      const { run_id: runId } = await client.submitRun({ blueprint: BLUEPRINT, cwd });
      expect(runId).toBeTruthy();

      // build succeeds; verify exhausts its budget → the run parks paused
      await waitFor(async () => {
        const { runs } = await client.listRuns();
        return runs.find((r) => r.id === runId)?.status === "paused";
      });

      // the audited override (who + why) — the drill-in renders the badge
      const over = await client.overrideGate(runId, "verify", {
        gate: "verifyNeverGreen",
        reason: "manual check passed",
        by: "reviewer-alice",
      });
      expect(over.ok).toBe(true);
      await waitFor(async () => {
        const { runs } = await client.listRuns();
        return runs.find((r) => r.id === runId)?.status === "success";
      });

      // the LIVE MODULE is mutated after submit — the CONFIG card must still
      // show the §13.3 snapshot (restored in finally)
      writeFileSync(BLUEPRINT, originalModule.replace(ORIGINAL_PROMPT_LINE, MUTATION_MARKER));

      // ── build phase: the full attempt history + snapshot config ──────────
      const build = await fetchDrillIn(runId, "build");
      expect(build.status).toBe(200);
      const html = build.html;

      // header: breadcrumb + phase context (visit/corr from the phase row)
      expect(html).toContain("drill-in-demo");
      expect(html).toContain("agent: builder");
      expect(html).toContain("visit 1");
      expect(html).toContain("corr 2");
      expect(html).toContain(`/runs/${runId}`); // breadcrumb back-link

      // CONFIG from the snapshot — never the mutated live module
      expect(html).toContain("CONFIG");
      expect(html).toContain("agent: builder · model: fake-pi");
      expect(html).toContain("bash, edit, read");
      expect(html).toContain("README.md (inlined)");
      expect(html).toContain('"demo repo rules"');
      expect(html).toContain(ORIGINAL_PROMPT_LINE);
      expect(html).not.toContain(MUTATION_MARKER);

      // ENVELOPE: invalid → gate violations → accepted, with corrections
      expect(html).toContain("ENVELOPE");
      expect(html).toContain("accepted");
      expect(html).toContain("attempt 3 of 3");
      expect(html).toContain("✗ invalid");
      expect(html).toContain("quality: Required"); // zod rejection → correction
      expect(html).toContain("→ corrected");
      expect(html).toContain("✓ valid, gates passed");
      expect(html).toContain("quality 4 below 7");
      expect(html).toContain("→ no correction followed");
      expect(html).toContain("context_handoff/build/outputs/envelope.json");
      expect(html).toContain("view JSON");
      expect(html).toContain('"quality": 8'); // accepted envelope JSON viewable

      // GATES: pass + fail rows with violations; no override on build
      expect(html).toContain("GATES");
      expect(html).toContain("✓ qualityGate");
      expect(html).toContain("✗ qualityGate");
      expect(html).toContain("quality 4 below 7");
      expect(html).not.toContain("overridden");

      // SPEND: per-phase tokens + reported USD from the spend events
      expect(html).toContain("SPEND");
      expect(html).toContain("tokens in 400 · out 90 · cache r/w 15/8");
      expect(html).toContain("usd $0.01");
      expect(html).not.toContain("incl. est.");

      // OUTPUT: the raw_output.jsonl tail
      expect(html).toContain("OUTPUT");
      expect(html).toContain("raw_output.jsonl tail");
      expect(html).toContain("Delivering the passing build.");

      // read-only page: no mutation controls anywhere
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<button");

      // ── verify phase: override badge (reason + who) + estimated spend ────
      const verify = await fetchDrillIn(runId, "verify");
      expect(verify.status).toBe(200);
      const vhtml = verify.html;
      expect(vhtml).toContain("no accepted envelope");
      expect(vhtml).toContain("✗ verifyNeverGreen");
      expect(vhtml).toContain("verify gate always fails by design");
      expect(vhtml).toContain("overridden");
      expect(vhtml).toContain("by reviewer-alice");
      expect(vhtml).toContain("manual check passed");
      // §11.1: cost-free usage estimated from the roster, flagged on the card
      expect(vhtml).toContain("tokens in 4,000 · out 1,000 · cache r/w 0/0");
      expect(vhtml).toContain("incl. est. $0.02 (roster estimate)");
      // raw tail holds the last (repeated) verify turn's lines
      expect(vhtml).toContain("Verifying quality: 5 (never green).");

      // ── needs_review banner when the run is flagged (§16.10) ─────────────
      const db = openDb(dbPathFor(dir));
      updateRun(db, runId, { needs_review: 1 });
      db.close();
      const flagged = await fetchDrillIn(runId, "build");
      expect(flagged.html).toContain("resumed after an interruption");
      expect(flagged.html).toContain("review before trusting");
    } finally {
      // restore the checked-in fixture module (no residue)
      writeFileSync(BLUEPRINT, originalModule);
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("404s with a back-link for a ghost run and a ghost phase (§16.10)", async () => {
    const dir = tmpDir("drillin-404");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      // seed a run + phase directly so the daemon has rows to look up
      const runId = "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const db = openDb(dbPathFor(dir));
      insertRun(db, {
        id: runId,
        blueprint: "ghost-demo",
        status: "success",
        cwd: "/tmp/x",
        needs_review: 0,
        started_at: new Date().toISOString(),
        ended_at: null,
      });
      insertPhase(db, {
        id: "phase-1",
        run_id: runId,
        name: "build",
        agent: "builder",
        status: "success",
        visits: 1,
        corrections: 0,
        budget: 3,
        spend_usd: 0,
        started_at: null,
        ended_at: null,
      });
      db.close();
      daemon = startDaemon({ dataDir: dir });

      // ghost run → 404 + back-link
      const ghostRun = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const missing = await fetchDrillIn(ghostRun, "build");
      expect(missing.status).toBe(404);
      expect(missing.html).toContain("not found");
      expect(missing.html).toContain(`run ${ghostRun} not found`);
      expect(missing.html).toContain("back to runs");

      // ghost phase (the run exists) → 404 + run breadcrumb + back-link
      const ghostPhase = await fetchDrillIn(runId, "ghost");
      expect(ghostPhase.status).toBe(404);
      expect(ghostPhase.html).toContain('phase "ghost" not found');
      expect(ghostPhase.html).toContain("ghost-demo");
      expect(ghostPhase.html).toContain("back to runs");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders the shell with the daemon-down banner instead of 500ing (§16.10)", async () => {
    const dir = tmpDir("drillin-down");
    const restore = setDataDir(dir);
    try {
      // no daemon started — the scratch socket cannot exist
      const res = await fetchDrillIn("11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "build");
      expect(res.status).toBe(200);
      expect(res.html).toContain("showrunner daemon is not running");
      expect(res.html).toContain("retry");
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
