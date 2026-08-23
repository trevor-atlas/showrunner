process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
/**
 * T10b acceptance e2e (issue #20): the run detail CONTROLS — the pause menu
 * (steer / override / restart-fresh / fail / approve) + the resume HEADER
 * action. Real daemon, real blueprint runs on FakePi (deterministic scripts),
 * driven through the app router with `router.fetch(...)` (the same hermetic
 * pattern as T10a/T11). Every control verb is asserted END-TO-END: the form
 * POSTs to a remix action (which calls the §13.2 daemon endpoint server-side),
 * the daemon audits the §6 #11 human_action event, and the re-rendered page
 * shows daemon state — NO optimistic mutation anywhere.
 *
 * Acceptance coverage:
 *  - pause menu renders when paused, per the daemon's own actions list;
 *    all five actions + resume hit the daemon control endpoints
 *  - steer/override validate with data-schema (no zod in the UI), inline
 *  - no optimistic mutation — page state comes from the daemon after each
 *    action (asserted through the daemon client, not the browser)
 *  - every action shows in the live feed as a human_action event
 *  - 409s (resume on non-interrupted; steer with no control handle) surface
 *    on the form
 *
 * Hermetic: scratch data dirs + cwds, in-process daemon, closed in finally,
 * no residue.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor, runDirFor } from "../../src/core/index.ts";
import { DaemonClient } from "../../src/daemon/client.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/daemon.ts";
import { insertEvent, insertPhase, insertRun, loadBlueprintModule, openDb, snapshotBlueprint } from "../../src/daemon/index.ts";
import { router } from "../../src/ui/app/router.ts";
import { routes } from "../../src/ui/app/routes.ts";

const CONTROLS = new URL("./fixtures/controls/controls-blueprint.ts", import.meta.url).pathname;
const APPROVAL = new URL("./fixtures/controls/approval-blueprint.ts", import.meta.url).pathname;
const HAPPY = new URL("./fixtures/controls/happy-blueprint.ts", import.meta.url).pathname;

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

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 20_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

/** GET a route through the app router (server-side, like a browser GET). */
async function fetchHtml(href: string): Promise<{ status: number; html: string }> {
  const res = await router.fetch(new Request("http://localhost" + href));
  return { status: res.status, html: await res.text() };
}

/** POST a control form (like a browser form submission). */
async function postControl(href: string, fields: Record<string, string> = {}): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return router.fetch(new Request("http://localhost" + href, { method: "POST", body: form }));
}

/** Follow a 303 redirect (the browser's fetch follows it automatically). */
async function followRedirect(res: Response): Promise<{ status: number; html: string }> {
  const location = res.headers.get("location");
  if (location === null) throw new Error("expected a 303 redirect");
  expect(res.status).toBe(303);
  return fetchHtml(location);
}

const runStatus = async (client: DaemonClient, runId: string): Promise<string | undefined> =>
  (await client.listRuns()).runs.find((r) => r.id === runId)?.status;

/** Submit the budget-exhaustion blueprint on FakePi and wait for the pause. */
async function startPausedRun(client: DaemonClient, cwd: string): Promise<string> {
  const { run_id: runId } = await client.submitRun({ blueprint: CONTROLS, cwd });
  await waitFor(async () => (await runStatus(client, runId)) === "paused", 20_000, "budget pause");
  return runId;
}

describe("run detail controls (T10b) — pause menu + control verbs", () => {
  it("renders the per-kind pause menu for a paused run; steer posts → the feed gains a human_action and the message queues (no optimistic mutation)", async () => {
    const dir = tmpDir("controls");
    const cwd = tmpDir("controls-cwd");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });
      const runId = await startPausedRun(client, cwd);

      // ── the pause menu renders from the daemon's own actions list ───────
      const { status, html } = await fetchHtml(routes.runs.show.href({ runId }));
      expect(status).toBe(200);
      expect(html).toContain('data-pause-menu');
      expect(html).toContain('data-pause-kind="budget_exhausted"');
      expect(html).toContain('data-pause-phase="build"');
      expect(html).toContain('data-form="steer"');
      expect(html).toContain('data-form="override"');
      expect(html).toContain('data-form="restart"');
      expect(html).toContain('data-form="fail"');
      // budget pauses do NOT offer approve; resume is a header action, not a menu item
      expect(html).not.toContain('data-form="approve"');
      expect(html).not.toContain('data-form="resume"');
      // the override select carries the FAILED gate as its option
      expect(html).toContain('name="gate"');
      expect(html).toContain("neverGreen");

      // ── steer posts to the daemon; the feed gains the human_action ──────
      const steer = await postControl(routes.runs.steer.href({ runId }), {
        message: "fix the failing gate, then re-run",
      });
      const followed = await followRedirect(steer);
      expect(followed.status).toBe(200);
      expect(followed.html).toContain('data-human-action="steer"');
      expect(followed.html).toContain("fix the failing gate, then re-run");
      // the run STAYS paused — the menu re-renders with the queued steer
      expect(followed.html).toContain('data-pause-menu');
      expect(followed.html).toContain('data-queued-steers');

      // NO optimistic mutation: the queue lives in the DAEMON, and the page
      // shows exactly what the daemon reports
      const pause = await client.pause(runId);
      expect(pause.paused).toBe(true);
      expect(pause.queued_steers).toContain("fix the failing gate, then re-run");
      expect(await runStatus(client, runId)).toBe("paused");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, { timeout: 40_000 });

  it("override (with reason) accepts the gate → the run continues to success; the feed gains the override human_action", async () => {
    const dir = tmpDir("controls-override");
    const cwd = tmpDir("controls-override-cwd");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });
      const runId = await startPausedRun(client, cwd);

      const over = await postControl(routes.runs.phases.override.href({ runId, phase: "build" }), {
        gate: "neverGreen",
        reason: "manual review accepts the envelope",
      });
      const followed = await followRedirect(over);

      // the override continues the run from the rejected envelope → success
      await waitFor(async () => (await runStatus(client, runId)) === "success", 20_000, "success after override");
      expect(followed.status).toBe(200);
      const done = await fetchHtml(routes.runs.show.href({ runId }));
      expect(done.html).toContain('data-status="success"');
      expect(done.html).not.toContain('data-pause-menu'); // menu gone — the run left the pause
      // the feed carries the audited override (who/why live in the event)
      expect(done.html).toContain('data-human-action="override_gate"');
      expect(done.html).toContain("manual review accepts the envelope");
      // the daemon agrees — the audit trail + terminal state are daemon-side
      const detail = await client.getRun(runId);
      expect(detail.run.status).toBe("success");
      // dashboard-originated overrides are audited as "web" (not the daemon's
      // "cli" default) — the gate_overrides row + the feed carry the true who
      const gates = await client.getPhaseGates(runId, "build");
      const overridden = gates.gates.find((g) => g.overridden === 1);
      expect(overridden?.override_by).toBe("web");
      expect(done.html).toContain("by web");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, { timeout: 40_000 });

  it("approve on a require_approval pause proceeds the run to success; the feed gains the approve human_action", async () => {
    const dir = tmpDir("controls-approve");
    const cwd = tmpDir("controls-approve-cwd");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });
      const { run_id: runId } = await client.submitRun({ blueprint: APPROVAL, cwd });
      await waitFor(async () => (await runStatus(client, runId)) === "paused", 20_000, "approval pause");

      // the approval menu: approve + steer + fail — NO override/restart-fresh
      const before = await fetchHtml(routes.runs.show.href({ runId }));
      expect(before.html).toContain('data-pause-kind="approval"');
      expect(before.html).toContain('data-form="approve"');
      expect(before.html).toContain('data-form="steer"');
      expect(before.html).toContain('data-form="fail"');
      expect(before.html).not.toContain('data-form="override"');
      expect(before.html).not.toContain('data-form="restart"');

      const appr = await postControl(routes.runs.approve.href({ runId }));
      const followed = await followRedirect(appr);
      expect(followed.status).toBe(200);
      await waitFor(async () => (await runStatus(client, runId)) === "success", 20_000, "success after approve");

      const done = await fetchHtml(routes.runs.show.href({ runId }));
      expect(done.html).toContain('data-status="success"');
      expect(done.html).toContain('data-human-action="approve"');
      expect(done.html).not.toContain('data-pause-menu');
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, { timeout: 40_000 });

  it("restart-fresh re-drives the phase as a NEW visit (v2 session id); the feed gains the restart human_action", async () => {
    const dir = tmpDir("controls-restart");
    const cwd = tmpDir("controls-restart-cwd");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });
      const runId = await startPausedRun(client, cwd);
      expect((await client.getRun(runId)).sessions).toHaveLength(1); // visit 1

      const rest = await postControl(routes.runs.phases.restart.href({ runId, phase: "build" }));
      const followed = await followRedirect(rest);
      expect(followed.status).toBe(200);

      // the restarted visit also fails its gate → the run pauses again
      await waitFor(async () => (await runStatus(client, runId)) === "paused", 20_000, "second pause");
      await waitFor(async () => (await client.getRun(runId)).sessions.length === 2, 20_000, "v2 session");

      // a NEW pi session with the §8.1 id v<visit+1>
      const detail = await client.getRun(runId);
      const ids = detail.sessions.map((s) => s.pi_session_id).sort();
      expect(ids).toEqual([
        `${runId.slice(0, 8)}_build_v1`,
        `${runId.slice(0, 8)}_build_v2`,
      ]);
      expect(detail.sessions.map((s) => s.visit)).toEqual([1, 2]);

      const done = await fetchHtml(routes.runs.show.href({ runId }));
      expect(done.html).toContain('data-human-action="restart"');
      expect(done.html).toContain('data-pause-menu'); // paused again — the menu re-renders
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, { timeout: 40_000 });

  it("fail → the run fails; the feed gains the fail human_action + the terminal run_status; the menu disappears", async () => {
    const dir = tmpDir("controls-fail");
    const cwd = tmpDir("controls-fail-cwd");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });
      const runId = await startPausedRun(client, cwd);

      const failed = await postControl(routes.runs.fail.href({ runId }));
      const followed = await followRedirect(failed);
      expect(followed.status).toBe(200);
      await waitFor(async () => (await runStatus(client, runId)) === "failed", 20_000, "failed after fail");

      const done = await fetchHtml(routes.runs.show.href({ runId }));
      expect(done.html).toContain('data-status="failed"');
      expect(done.html).not.toContain('data-pause-menu');
      expect(done.html).toContain('data-human-action="fail"');
      expect(done.html).toContain("run failed by human");
      // the terminal run_status event rides the same feed
      expect(done.html).toContain('data-event-type="run_status"');
      expect(done.html).toContain("paused → failed");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, { timeout: 40_000 });

  it("resume is a HEADER action for interrupted runs → the run continues to success with needs_review; the feed gains the resume human_action", async () => {
    const dir = tmpDir("controls-resume");
    const cwd = tmpDir("controls-resume-cwd");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      // seed an INTERRUPTED run directly (status + pending phase + §13.3
      // snapshot) — the same shape prepareResume reads (contract.test.ts)
      const runId = "bbbbbbbb-0000-4000-8000-000000000002";
      const seedDb = openDb(dbPathFor(dir));
      const startedAt = new Date().toISOString();
      insertRun(seedDb, { id: runId, blueprint: "controls-happy", status: "interrupted", cwd, needs_review: 0, started_at: startedAt, ended_at: null });
      insertPhase(seedDb, { id: "ph-build", run_id: runId, name: "build", agent: "builder", status: "pending", visits: 0, corrections: 0, budget: 3, spend_usd: 0, started_at: null, ended_at: null });
      const blueprint = await loadBlueprintModule(HAPPY);
      mkdirSync(runDirFor(dir, runId), { recursive: true });
      snapshotBlueprint(runDirFor(dir, runId), blueprint, 3, HAPPY);
      seedDb.close();

      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });

      // the interrupted run renders the resume HEADER action (not in the menu)
      const before = await fetchHtml(routes.runs.show.href({ runId }));
      expect(before.html).toContain('data-form="resume"');
      expect(before.html).toContain('data-status="interrupted"');
      expect(before.html).not.toContain('data-pause-menu');

      const resumed = await postControl(routes.runs.resume.href({ runId }));
      const followed = await followRedirect(resumed);
      expect(followed.status).toBe(200);
      // §19 pin: ANY resume flags needs_review — the re-render shows it
      expect(followed.html).toContain('data-meta="needs-review"');
      expect(followed.html).toContain("resumed after an interruption");

      await waitFor(async () => (await runStatus(client, runId)) === "success", 20_000, "success after resume");
      const done = await fetchHtml(routes.runs.show.href({ runId }));
      expect(done.html).toContain('data-status="success"');
      expect(done.html).toContain('data-human-action="resume"');
      expect(done.html).toContain("needs review"); // the flag survives success
      const detail = await client.getRun(runId);
      expect(detail.run.needs_review).toBe(1);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, { timeout: 40_000 });

  it("409s surface on the form: resume on a non-interrupted run; steer with no control handle", async () => {
    const dir = tmpDir("controls-409");
    const cwd = tmpDir("controls-409-cwd");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });
      const runId = await startPausedRun(client, cwd);

      // resume on a PAUSED run → daemon 409 → the resume control re-renders
      // with the error ON the form (defensive render keeps it visible)
      const badResume = await postControl(routes.runs.resume.href({ runId }));
      expect(badResume.status).toBe(400);
      const resumeHtml = await badResume.text();
      expect(resumeHtml).toContain('data-form="resume"');
      expect(resumeHtml).toContain('data-form-error');
      expect(resumeHtml).toContain('data-error-for="resume"');
      expect(resumeHtml).toMatch(/resume failed \(409\)/);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, { timeout: 40_000 });

  it("steer on a paused run with NO control handle 409s on the form (the seeded run has no live daemon handle)", async () => {
    const dir = tmpDir("controls-409-steer");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      // seed a paused run DIRECTLY — no loop, no control handle (§12 restart case)
      const runId = "99999999-0000-4000-8000-000000000009";
      const seedDb = openDb(dbPathFor(dir));
      const startedAt = new Date().toISOString();
      insertRun(seedDb, { id: runId, blueprint: "seeded", status: "paused", cwd: "/tmp/seeded", needs_review: 0, started_at: startedAt, ended_at: null });
      insertPhase(seedDb, { id: "ph-build", run_id: runId, name: "build", agent: "builder", status: "in_progress", visits: 1, corrections: 1, budget: 1, spend_usd: 0, started_at: startedAt, ended_at: null });
      insertEvent(seedDb, { run_id: runId, phase_id: "ph-build", agent_session_id: null, type: "run_status", ts: startedAt, data: { from: "running", to: "paused", reason: "seeded pause" } });
      seedDb.close();

      daemon = await startDaemon({ dataDir: dir, port: 0 });

      // the paused run renders the menu shell (no control handle → no actions)
      const before = await fetchHtml(routes.runs.show.href({ runId }));
      expect(before.html).toContain('data-pause-menu');
      expect(before.html).toContain('data-pause-note');
      expect(before.html).not.toContain('data-form="steer"');

      // steer with no control handle → daemon 409 → the steer form re-renders
      // with the error ON it (defensive render — no silent drop)
      const badSteer = await postControl(routes.runs.steer.href({ runId }), { message: "hello?" });
      expect(badSteer.status).toBe(400);
      const html = await badSteer.text();
      expect(html).toContain('data-form="steer"');
      expect(html).toContain('data-error-for="steer"');
      expect(html).toMatch(/steer failed \(409\)/);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 40_000 });

  it("data-schema validation rejects empty/blank inputs inline on the form (no zod, no silent drop)", async () => {
    const dir = tmpDir("controls-validation");
    const cwd = tmpDir("controls-validation-cwd");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });
      const runId = await startPausedRun(client, cwd);

      // steer: empty message → 400 + inline field error; whitespace-only → too
      const empty = await postControl(routes.runs.steer.href({ runId }), {});
      expect(empty.status).toBe(400);
      const emptyHtml = await empty.text();
      expect(emptyHtml).toContain('data-field-error="message"');
      expect(emptyHtml).toMatch(/message is required/);

      const blank = await postControl(routes.runs.steer.href({ runId }), { message: "   " });
      expect(blank.status).toBe(400);
      const blankHtml = await blank.text();
      expect(blankHtml).toContain('data-field-error="message"');
      expect(blankHtml).toContain("steer message is required");

      // override: missing gate / missing reason / both → field-level errors
      const noReason = await postControl(routes.runs.phases.override.href({ runId, phase: "build" }), {
        gate: "neverGreen",
        reason: "",
      });
      expect(noReason.status).toBe(400);
      const noReasonHtml = await noReason.text();
      expect(noReasonHtml).toContain('data-field-error="reason"');
      expect(noReasonHtml).toContain("reason is required");

      const noGate = await postControl(routes.runs.phases.override.href({ runId, phase: "build" }), {
        gate: "",
        reason: "because",
      });
      expect(noGate.status).toBe(400);
      expect(await noGate.text()).toContain('data-field-error="gate"');

      const none = await postControl(routes.runs.phases.override.href({ runId, phase: "build" }), {});
      expect(none.status).toBe(400);
      const noneHtml = await none.text();
      expect(noneHtml).toContain('data-field-error="gate"');
      expect(noneHtml).toContain('data-field-error="reason"');

      // nothing was mutated: the run is STILL paused, no human_action landed
      expect(await runStatus(client, runId)).toBe("paused");
      const pause = await client.pause(runId);
      expect(pause.queued_steers ?? []).toHaveLength(0);
      const detail = await client.getRun(runId);
      expect(detail.event_count).toBeGreaterThan(0);
      const events = await client.getEvents(runId, { cursor: 0, limit: 500 });
      expect(events.events.some((e) => e.type === "human_action")).toBe(false);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, { timeout: 40_000 });

  it("polish: the drill-in spend sweep pages to the TRUE tail — 5500 spend events sum fully (no silent 10-page cap)", async () => {
    const dir = tmpDir("controls-spend-sweep");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      const runId = "55555555-0000-4000-8000-000000000005";
      const startedAt = new Date().toISOString();
      const db = openDb(dbPathFor(dir));
      insertRun(db, { id: runId, blueprint: "spendy", status: "success", cwd: "/tmp/spendy", needs_review: 0, started_at: startedAt, ended_at: startedAt });
      insertPhase(db, { id: "ph-build", run_id: runId, name: "build", agent: "builder", status: "success", visits: 1, corrections: 0, budget: 3, spend_usd: 0.55, started_at: startedAt, ended_at: startedAt });
      // 5500 §6 #12 spend events (11 pages of 500) — the OLD sweep capped at
      // 5000 and silently under-reported; the fix pages to the tail
      for (let i = 0; i < 5500; i++) {
        insertEvent(db, {
          run_id: runId,
          phase_id: "ph-build",
          agent_session_id: null,
          type: "spend",
          ts: startedAt,
          data: { phase: "build", tokens_in: 1, tokens_out: 0, cache_read: 0, cache_write: 0, usd: 0.0001, estimated: false },
        });
      }
      db.close();

      daemon = await startDaemon({ dataDir: dir, port: 0 });

      const { status, html } = await fetchHtml(routes.runs.phases.show.href({ runId, phase: "build" }));
      expect(status).toBe(200);
      // 1 token × 5500 events — the full sweep (a 10-page cap would show 5,000)
      expect(html).toContain("tokens in 5,500 · out 0 · cache r/w 0/0");
      expect(html).toContain("SPEND");
      expect(html).not.toContain("older spend omitted");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 60_000 });
});
