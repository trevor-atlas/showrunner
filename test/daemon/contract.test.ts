process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { runDirFor } from "../../src/core/index.ts";

import { CURSOR_SQL } from "../../src/server/repository/db.ts";
import { loadBlueprintModule, snapshotBlueprint } from "../../src/server/engine/runner.ts";
import { startDaemon } from "../../src/server/lifecycle.ts";
import { insertPhase, insertRun, openDb } from "../../src/server/repository/db.ts";
import { DaemonClient } from "../../src/server/transport/client.ts";
import { type SubmitRunBody } from "../../src/server/contract.ts";
import { type DaemonHandle } from "../../src/server/lifecycle.ts";
import type {
  ControlResult,
  EventsPage,
  PauseView,
  PhaseEnvelopes,
  PhaseGates,
  RawTail,
  RunDetail,
  RunListItem,
  SpendBreakdown,
  SubmitRunResult,
  TimelineView,
} from "../../src/server/contract.ts";
import { ApiError as ClientApiError } from "../../src/server/transport/client.ts";
import { ApiError as ServerApiError } from "../../src/server/contract.ts";
import { apiTimeline } from "../../src/server/services/runs.ts";
import { cleanupDir, tmpDataDir } from "./helpers.ts";

/**
 * The API contract surface (issue #13 / T08): a real daemon against a
 * scratch data dir, FakePi runs only (no pi binary), exercising EVERY
 * endpoint — read, control, blueprint submission,
 * hooks & waits, the exact cursor query, the queue-position +
 * run_submitted-at-acceptance fixes (F2), and the typed client over the
 * merged HTTP transport (every path under /api/*).
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const DEMO = join(fixturesDir, "demo-blueprint.ts");
const APPROVAL = join(fixturesDir, "approval-blueprint.ts");
const PAUSE = join(fixturesDir, "pause-blueprint.ts");
const HAPPY = join(fixturesDir, "happy-blueprint.ts");
const HOOK = join(fixturesDir, "hook-blueprint.ts");
const HOOK_START_FAIL = join(fixturesDir, "hook-start-fail.ts");
const HOOK_END_FAIL = join(fixturesDir, "hook-end-fail.ts");

/** Raw probe over the daemon's merged HTTP server: every path below is
 * `/api`-prefixed (the web server dispatches /api/* to the api core). */
function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = new URL("/api" + path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port === "" ? undefined : url.port,
        method,
        path: url.pathname + url.search,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (res: IncomingMessage) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          let json: unknown = data;
          try {
            json = JSON.parse(data);
          } catch {
            // keep raw text
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 20_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForStatus(baseUrl: string, runId: string, status: string, timeoutMs = 20_000): Promise<void> {
  await waitFor(async () => {
    const { json } = await api(baseUrl, "GET", `/runs/${runId}`);
    return (json as RunDetail).run.status === status;
  }, timeoutMs, `run ${runId} → ${status}`);
}

async function runEvents(baseUrl: string, runId: string): Promise<{ id: number; type: string; data: Record<string, unknown> }[]> {
  const { json } = await api(baseUrl, "GET", `/runs/${runId}/events?cursor=0&limit=500`);
  // the EventsPage contract types the page; the event `data` column is
  // `unknown` (core's EventRow), so widen that one field for the payload
  // assertions below (the data slices are typed where they are asserted)
  return (json as EventsPage).events.map((e) => ({ id: e.id, type: e.type, data: e.data as Record<string, unknown> }));
}

function scratchCwd(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-${label}-`));
}

// ── read endpoints over a completed blueprint run ─────────────────────

test("read surface: detail, envelopes, gates, spend, raw tail, list — and the 404 semantics", async () => {
  const dir = tmpDataDir("contract-read");
  const cwd = scratchCwd("contract-read-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;
    const sub = await api(baseUrl, "POST", "/runs", { blueprint: DEMO, cwd, delayMs: 0 });
    expect(sub.status).toBe(201);
    const { run_id } = sub.json as SubmitRunResult;
    await waitForStatus(baseUrl, run_id, "success");

    // GET /runs — list with id/blueprint/status/started/ended/spend + queue position
    const list = ((await api(baseUrl, "GET", "/runs")).json as { runs: RunListItem[] }).runs;
    expect(list).toHaveLength(1);
    const listed = list[0]!;
    expect(listed.id).toBe(run_id);
    expect(listed.blueprint).toBe("demo");
    expect(listed.status).toBe("success");
    expect(listed.started_at).toBeTypeOf("string");
    expect(listed.ended_at).toBeTypeOf("string");
    expect(listed.spend_usd).toBeTypeOf("number");
    expect(listed.queue_position).toBeNull(); // not queued

    // GET /runs/:id — detail: phases (status/visits/corrections/spend), envelope count, needs_review
    const detail = (await api(baseUrl, "GET", `/runs/${run_id}`)).json as RunDetail;
    expect(detail.run.status).toBe("success");
    expect(detail.run.needs_review).toBe(0);
    expect(detail.envelope_count).toBe(3); // plan ×2 attempts + build ×1
    expect(detail.event_count).toBeGreaterThan(0);
    expect(detail.sessions).toHaveLength(2);
    expect(detail.phases.map((p) => [p.name, p.status, p.visits, p.corrections])).toEqual([
      ["plan", "success", 1, 1],
      ["build", "success", 1, 0],
    ]);
    for (const p of detail.phases) expect(p.spend_usd).toBeTypeOf("number");

    // GET /runs/:id/phases/:phase/envelopes — ALL attempts, ordered visit → attempt
    const planEnv = (await api(baseUrl, "GET", `/runs/${run_id}/phases/plan/envelopes`)).json as PhaseEnvelopes;
    expect(planEnv.run_id).toBe(run_id);
    expect(planEnv.phase).toBe("plan");
    expect(planEnv.envelopes).toHaveLength(2);
    expect(planEnv.envelopes[0]!.attempt).toBe(0);
    expect(planEnv.envelopes[0]!.valid).toBe(1); // parsed, but the gate rejected it
    expect(planEnv.envelopes[0]!.violations).toContain("below the required 7");
    expect(planEnv.envelopes[0]!.correction).toBeTypeOf("string"); // the correction that followed
    expect(planEnv.envelopes[1]!.attempt).toBe(1);
    expect(planEnv.envelopes[1]!.violations).toBe("[]");
    expect(planEnv.envelopes[1]!.correction).toBeNull();

    // GET /runs/:id/phases/:phase/gates — results incl. the override badge
    const planGates = (await api(baseUrl, "GET", `/runs/${run_id}/phases/plan/gates`)).json as PhaseGates;
    expect(planGates.gates).toHaveLength(2);
    expect(planGates.gates[0]).toMatchObject({ gate: "qualityGate", pass: 0 });
    expect(planGates.gates[0]!.violations).toContain("quality 4");
    expect(planGates.gates[1]).toMatchObject({ gate: "qualityGate", pass: 1, overridden: 0 });
    expect(planGates.gates[0]!.override_by).toBeNull();

    // GET /runs/:id/spend — per-phase breakdown (+ estimated markers)
    const spend = (await api(baseUrl, "GET", `/runs/${run_id}/spend`)).json as SpendBreakdown;
    expect(spend.run_id).toBe(run_id);
    expect(spend.phases.map((p) => p.name)).toEqual(["plan", "build"]);
    for (const p of spend.phases) {
      expect(p.spend_usd).toBeTypeOf("number");
      expect(p.estimated_spend_usd).toBeTypeOf("number");
    }
    expect(spend.spend_usd).toBe(spend.phases.reduce((a, p) => a + p.spend_usd, 0));

    // GET /runs/:id/raw?lines=N — the tail semantics: last N lines, full count, truncated
    const raw = (await api(baseUrl, "GET", `/runs/${run_id}/raw?lines=3`)).json as RawTail;
    expect(raw.run_id).toBe(run_id);
    expect(raw.raw.split("\n").filter((l) => l !== "")).toHaveLength(3);
    expect(raw.line_count).toBeGreaterThan(3);
    expect(raw.truncated).toBe(true);
    // ?n= is kept as an alias; a full read is not truncated
    const full = (await api(baseUrl, "GET", `/runs/${run_id}/raw?n=99999`)).json as RawTail;
    expect(full.truncated).toBe(false);
    expect(full.line_count).toBe(raw.line_count);

    // the exact cursor query shape is the server's read transport
    expect(CURSOR_SQL).toBe("SELECT * FROM events WHERE run_id = ? AND rowid > ? ORDER BY rowid LIMIT ?");

    // ── 404 semantics: missing run everywhere; missing phase on phase-scoped reads
    const notFound = [
      ["GET", "/runs/ghost"],
      ["GET", "/runs/ghost/events"],
      ["GET", "/runs/ghost/raw"],
      ["GET", "/runs/ghost/spend"],
      ["GET", "/runs/ghost/phases/plan/envelopes"],
      ["GET", "/runs/ghost/phases/plan/gates"],
      ["GET", `/runs/${run_id}/phases/nope/envelopes`],
      ["GET", `/runs/${run_id}/phases/nope/gates`],
    ] as const;
    for (const [m, p] of notFound) {
      const res = await api(baseUrl, m, p);
      expect(res.status, `${m} ${p}`).toBe(404);
      expect(typeof (res.json as { error: unknown }).error).toBe("string"); // proper JSON errors
    }
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

// ── cursor contract: pagination, next_cursor, the 500 limit ────────────

test("cursor contract: limit honored (500 cap, default), next_cursor advances, idempotent at the tail", async () => {
  const dir = tmpDataDir("contract-cursor");
  let daemon: DaemonHandle | null = null;
  try {
    // seed >500 events through the DB BEFORE the daemon starts (the events
    // table is append-only; the HTTP layer has no ingest endpoint by design)
    const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const seedDb = openDb(join(dir, "showrunner.db"));
    insertRun(seedDb, { id: runId, blueprint: "bulk", status: "success", cwd: "/tmp", needs_review: 0, started_at: new Date().toISOString(), ended_at: new Date().toISOString() });
    for (let i = 0; i < 600; i++) {
      seedDb
        .query("INSERT INTO events (run_id, phase_id, agent_session_id, type, ts, data) VALUES (?, NULL, NULL, 'run_submitted', ?, ?)")
        .run(runId, new Date().toISOString(), JSON.stringify({ blueprint: "bulk", cwd: "/tmp" }));
    }
    seedDb.close();

    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;

    // default limit is 500 and the cap is honored (limit=1000 still yields 500)
    for (const qs of ["", "&limit=1000"]) {
      const page = (await api(baseUrl, "GET", `/runs/${runId}/events?cursor=0${qs}`)).json as EventsPage;
      expect(page.events).toHaveLength(500);
      expect(page.next_cursor).toBe(page.events[499]!.id);
    }

    // next_cursor advances: the second page starts strictly after the first
    const first = (await api(baseUrl, "GET", `/runs/${runId}/events?cursor=0&limit=500`)).json as EventsPage;
    const second = (await api(baseUrl, "GET", `/runs/${runId}/events?cursor=${first.next_cursor}&limit=500`)).json as EventsPage;
    expect(second.events).toHaveLength(100);
    for (const e of second.events) expect(e.id).toBeGreaterThan(first.events[499]!.id);
    expect(second.next_cursor).toBe(second.events[99]!.id);

    // the query is idempotent at the tail: empty page echoes the requested cursor
    const tail = (await api(baseUrl, "GET", `/runs/${runId}/events?cursor=${second.next_cursor}`)).json as EventsPage;
    expect(tail.events).toHaveLength(0);
    expect(tail.next_cursor).toBe(second.next_cursor);

    // a bounded page walks the whole stream without dupes or gaps
    let cursor = 0;
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      const p = (await api(baseUrl, "GET", `/runs/${runId}/events?cursor=${cursor}&limit=250`)).json as EventsPage;
      ids.push(...p.events.map((e) => e.id));
      if (p.events.length === 0) break;
      cursor = p.next_cursor;
    }
    expect(ids).toHaveLength(600);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(600);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
}, { timeout: 30_000 });

// ── submit with queue position + run_submitted at ACCEPTANCE ───

test("F2: run_submitted fires at acceptance (a queued run has it before it drives); queue position surfaces on POST /runs and GET /runs", async () => {
  const dir = tmpDataDir("contract-queue");
  const cwd = scratchCwd("contract-queue-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0, poolSlots: 1 });
    const baseUrl = daemon.baseUrl;

    // A: approval pause holds the only slot (F1: paused runs keep their slot)
    const a = await api(baseUrl, "POST", "/runs", { blueprint: APPROVAL, cwd, delayMs: 0 });
    const aId = (a.json as SubmitRunResult).run_id;
    expect((a.json as SubmitRunResult).queue_position).toBeNull(); // started immediately
    await waitForStatus(baseUrl, aId, "paused");

    // B: queued behind A — the submit response carries its queue position
    const b = await api(baseUrl, "POST", "/runs", { blueprint: DEMO, cwd, delayMs: 0, args: ["--go", "fast"] });
    expect(b.status).toBe(201);
    const bId = (b.json as SubmitRunResult).run_id;
    expect((b.json as SubmitRunResult).queue_position).toBe(1);

    // GET /runs surfaces the queue position for the queued run, null for A
    const list = ((await api(baseUrl, "GET", "/runs")).json as {
      runs: RunListItem[];
    }).runs;
    expect(list.find((r) => r.id === aId)!.queue_position).toBeNull();
    expect(list.find((r) => r.id === bId)!.queue_position).toBe(1);

    // F2: B's ONLY event so far is run_submitted (acceptance) — no run_status
    // (that lands at drive start), no phase events
    const bEvents = await runEvents(baseUrl, bId);
    expect(bEvents.map((e) => e.type)).toEqual(["run_submitted"]);
    expect(bEvents[0]!.data).toMatchObject({ blueprint: "demo", cwd });

    // the snapshot records the submit-time args
    const snap = JSON.parse(readFileSync(join(runDirFor(dir, bId), "blueprint.json"), "utf8")) as { args: string[] };
    expect(snap.args).toEqual(["--go", "fast"]);

    // approve A → its slot frees → B starts: run_submitted (acceptance) came
    // FIRST, then submitted→running at drive start
    const ok = await api(baseUrl, "POST", `/runs/${aId}/approve`);
    expect(ok.status).toBe(200);
    await waitForStatus(baseUrl, bId, "success");
    const bAll = await runEvents(baseUrl, bId);
    expect(bAll[0]!.type).toBe("run_submitted");
    expect(bAll[1]!.type).toBe("run_status");
    expect((bAll[1]!.data as { from: string; to: string })).toMatchObject({ from: "submitted", to: "running" });

    // once started, B is no longer queued
    const after = ((await api(baseUrl, "GET", "/runs")).json as {
      runs: RunListItem[];
    }).runs;
    expect(after.find((r) => r.id === bId)!.queue_position).toBeNull();

    // the full queue-position cycle: a SECOND queued run gets position 1 while
    // a later one gets 2 (a slot-holding paused run + a running run)
    const c = await api(baseUrl, "POST", "/runs", { blueprint: APPROVAL, cwd, delayMs: 0 });
    expect(c.status).toBe(201);
    const cId = (c.json as SubmitRunResult).run_id;
    // wait: poolSlots=1 — B just finished, so C starts immediately. To get a
    // position-2, submit two; the second queues behind the paused first
    await waitForStatus(baseUrl, cId, "paused");
    const d = await api(baseUrl, "POST", "/runs", { blueprint: HAPPY, cwd, delayMs: 0 });
    const dId = (d.json as SubmitRunResult).run_id;
    expect((d.json as SubmitRunResult).queue_position).toBe(1);
    const e = await api(baseUrl, "POST", "/runs", { blueprint: HAPPY, cwd, delayMs: 0 });
    const eId = (e.json as SubmitRunResult).run_id;
    expect((e.json as SubmitRunResult).queue_position).toBe(2);
    // clean up the parked runs so the daemon closes without pending work
    await api(baseUrl, "POST", `/runs/${cId}/fail`);
    await waitForStatus(baseUrl, dId, "success");
    await waitForStatus(baseUrl, eId, "success");
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 40_000 });

// ── control verbs: approve, override (audited), restart-fresh, fail ───

test("control surface: approve + audited gate override + restart-fresh + fail, with human_action events and guardrails", async () => {
  const dir = tmpDataDir("contract-control");
  const cwd = scratchCwd("contract-control-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;

    // ── approve (require_approval pause) ──
    const ap = await api(baseUrl, "POST", "/runs", { blueprint: APPROVAL, cwd, delayMs: 0 });
    const apId = (ap.json as SubmitRunResult).run_id;
    await waitForStatus(baseUrl, apId, "paused");
    const viewer = (await api(baseUrl, "GET", `/runs/${apId}/pause`)).json as PauseView;
    expect(viewer).toMatchObject({ paused: true, kind: "approval", phase: "build" });
    expect(viewer.actions).toContain("approve");
    const approved = await api(baseUrl, "POST", `/runs/${apId}/approve`, { by: "operator" });
    expect(approved.status).toBe(200);
    await waitForStatus(baseUrl, apId, "success");
    const apEvents = await runEvents(baseUrl, apId);
    expect(apEvents.some((e) => e.type === "human_action" && e.data.action === "approve" && e.data.by === "operator")).toBe(true);

    // ── budget pause → override guardrails → audited override → success ──
    const pu = await api(baseUrl, "POST", "/runs", { blueprint: PAUSE, cwd, delayMs: 0 });
    const puId = (pu.json as SubmitRunResult).run_id;
    await waitForStatus(baseUrl, puId, "paused");
    const budgetView = (await api(baseUrl, "GET", `/runs/${puId}/pause`)).json as PauseView;
    expect(budgetView.kind).toBe("budget_exhausted");
    expect(budgetView.actions).toContain("override");

    // guardrails: override of a gate that never failed → 409; approve is not
    // on the budget menu → 409; the phase in the URL must match the paused one
    const badGate = await api(baseUrl, "POST", `/runs/${puId}/phases/build/override`, { gate: "nope", reason: "why" });
    expect(badGate.status).toBe(409);
    const badApprove = await api(baseUrl, "POST", `/runs/${puId}/approve`);
    expect(badApprove.status).toBe(409);
    const wrongPhase = await api(baseUrl, "POST", `/runs/${puId}/phases/other/override`, { gate: "alwaysFail", reason: "why" });
    expect(wrongPhase.status).toBe(409);

    // the audited override: who + why recorded, original gate_results row kept
    const over = await api(baseUrl, "POST", `/runs/${puId}/phases/build/override`, {
      gate: "alwaysFail",
      reason: "human inspection says it is fine",
      by: "operator",
    });
    expect(over.status).toBe(200);
    await waitForStatus(baseUrl, puId, "success");
    const gates = ((await api(baseUrl, "GET", `/runs/${puId}/phases/build/gates`)).json as {
      gates: { gate: string; pass: number; overridden: number; override_by: string | null; override_reason: string | null }[];
    });
    // two attempts, each with one alwaysFail gate result — the last is overridden
    expect(gates.gates).toHaveLength(2);
    const overridden = gates.gates.find((g) => g.overridden === 1)!;
    expect(overridden).toMatchObject({ gate: "alwaysFail", pass: 0, override_by: "operator", override_reason: "human inspection says it is fine" });
    const puEvents = await runEvents(baseUrl, puId);
    expect(puEvents.some((e) => e.type === "human_action" && e.data.action === "override_gate" && e.data.by === "operator")).toBe(true);

    // ── restart-fresh (new visit) then fail ──
    const rf = await api(baseUrl, "POST", "/runs", { blueprint: PAUSE, cwd, delayMs: 0 });
    const rfId = (rf.json as SubmitRunResult).run_id;
    await waitForStatus(baseUrl, rfId, "paused");
    const restarted = await api(baseUrl, "POST", `/runs/${rfId}/phases/build/restart-fresh`, { by: "human" });
    expect(restarted.status).toBe(200);
    // the new visit fails its gate again → the run re-pauses (visits=2)
    await waitForStatus(baseUrl, rfId, "paused");
    const rfDetail = (await api(baseUrl, "GET", `/runs/${rfId}`)).json as RunDetail;
    expect(rfDetail.phases[0]!.visits).toBe(2);
    const rfEvents = await runEvents(baseUrl, rfId);
    expect(rfEvents.some((e) => e.type === "human_action" && e.data.action === "restart")).toBe(true);

    const failed = await api(baseUrl, "POST", `/runs/${rfId}/fail`, { by: "human" });
    expect(failed.status).toBe(200);
    await waitForStatus(baseUrl, rfId, "failed");
    const failEvents = await runEvents(baseUrl, rfId);
    expect(failEvents.some((e) => e.type === "human_action" && e.data.action === "fail")).toBe(true);
    expect(failEvents.some((e) => e.type === "run_status" && (e.data as { to: string }).to === "failed")).toBe(true);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

// ── override audit: who — the daemon's default vs a named web client ────────

test("override audit: a request WITHOUT by records cli; with by:\"web\" records web on the gate_overrides row", async () => {
  const dir = tmpDataDir("contract-override-by");
  const cwd = scratchCwd("contract-override-by-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;

    // run 1: override WITHOUT by → the daemon's default ("cli") is audited
    const cliRun = await api(baseUrl, "POST", "/runs", { blueprint: PAUSE, cwd, delayMs: 0 });
    const cliId = (cliRun.json as SubmitRunResult).run_id;
    await waitForStatus(baseUrl, cliId, "paused");
    const cliOver = await api(baseUrl, "POST", `/runs/${cliId}/phases/build/override`, {
      gate: "alwaysFail",
      reason: "cli audit default",
    });
    expect(cliOver.status).toBe(200);
    await waitForStatus(baseUrl, cliId, "success");
    const cliGates = ((await api(baseUrl, "GET", `/runs/${cliId}/phases/build/gates`)).json as PhaseGates).gates;
    expect(cliGates.find((g) => g.overridden === 1)).toMatchObject({ gate: "alwaysFail", override_by: "cli" });
    const cliEvents = await runEvents(baseUrl, cliId);
    expect(cliEvents.some((e) => e.type === "human_action" && e.data.action === "override_gate" && e.data.by === "cli")).toBe(true);

    // run 2: override WITH by:"web" → the dashboard's identity is audited
    const webRun = await api(baseUrl, "POST", "/runs", { blueprint: PAUSE, cwd, delayMs: 0 });
    const webId = (webRun.json as SubmitRunResult).run_id;
    await waitForStatus(baseUrl, webId, "paused");
    const webOver = await api(baseUrl, "POST", `/runs/${webId}/phases/build/override`, {
      gate: "alwaysFail",
      reason: "dashboard override",
      by: "web",
    });
    expect(webOver.status).toBe(200);
    await waitForStatus(baseUrl, webId, "success");
    const webGates = ((await api(baseUrl, "GET", `/runs/${webId}/phases/build/gates`)).json as PhaseGates).gates;
    expect(webGates.find((g) => g.overridden === 1)).toMatchObject({
      gate: "alwaysFail",
      override_by: "web",
      override_reason: "dashboard override",
    });
    const webEvents = await runEvents(baseUrl, webId);
    expect(webEvents.some((e) => e.type === "human_action" && e.data.action === "override_gate" && e.data.by === "web")).toBe(true);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

// ── session steer, resume guardrails, fail guardrails ────────────────

test("session steer delivers between turns; resume and fail answer 409 outside their contract", async () => {
  const dir = tmpDataDir("contract-steer");
  const cwd = scratchCwd("contract-steer-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;

    // steer at a session that does not exist → 409
    const ghost = await api(baseUrl, "POST", "/sessions/nope/steer", { message: "hi" });
    expect(ghost.status).toBe(409);
    // empty message → 409
    const empty = await api(baseUrl, "POST", "/sessions/nope/steer", { message: "   " });
    expect(empty.status).toBe(409);

    // live-session steer: a slow blueprint run holds its session long enough
    const sub = await api(baseUrl, "POST", "/runs", { blueprint: DEMO, cwd, delayMs: 120 });
    const runId = (sub.json as SubmitRunResult).run_id;
    let piSessionId: string | null = null;
    await waitFor(async () => {
      const { json } = await api(baseUrl, "GET", `/runs/${runId}`);
      const d = json as RunDetail;
      if (d.run.status !== "running" || d.sessions.length === 0) return false;
      piSessionId = d.sessions[0]!.pi_session_id;
      return true;
    }, 15_000, "live session");
    const steered = await api(baseUrl, "POST", `/sessions/${piSessionId}/steer`, { message: "check the tests too", by: "reviewer" });
    expect(steered.status).toBe(200);
    expect((steered.json as ControlResult).ok).toBe(true);
    await waitForStatus(baseUrl, runId, "success");
    const evts = await runEvents(baseUrl, runId);
    expect(evts.some((e) => e.type === "human_action" && e.data.action === "steer" && e.data.by === "reviewer")).toBe(true);
    // waits are observed, not managed: tool_call rows carry duration_ms
    const tool = evts.find((e) => e.type === "tool_call");
    expect(tool).toBeDefined();
    expect(tool!.data.duration_ms).toBeTypeOf("number");

    // resume guardrails: only interrupted runs resume; missing runs 404
    const resumeSuccess = await api(baseUrl, "POST", `/runs/${runId}/resume`);
    expect(resumeSuccess.status).toBe(409);
    const resumeGhost = await api(baseUrl, "POST", "/runs/ghost/resume");
    expect(resumeGhost.status).toBe(404);

    // fail guardrail: a finished run is already terminal → 409
    const failFinished = await api(baseUrl, "POST", `/runs/${runId}/fail`);
    expect(failFinished.status).toBe(409);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

// ── resume over HTTP: an interrupted run continues to success ───────────

test("resume over HTTP: an interrupted run relaunches from its recorded phase and succeeds", async () => {
  const dir = tmpDataDir("contract-resume");
  const cwd = scratchCwd("contract-resume-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    // build an INTERRUPTED run directly (status interrupted + the
    // snapshot + pending phase rows) — prepareResume reads exactly this
    const runId = "bbbbbbbb-0000-4000-8000-000000000002";
    const seedDb = openDb(join(dir, "showrunner.db"));
    const startedAt = new Date().toISOString();
    insertRun(seedDb, { id: runId, blueprint: "happy-demo", status: "interrupted", cwd, needs_review: 0, started_at: startedAt, ended_at: null });
    insertPhase(seedDb, { id: "ph-build", run_id: runId, name: "build", agent: "builder", status: "pending", visits: 0, corrections: 0, budget: 3, spend_usd: 0, started_at: null, ended_at: null });
    const blueprint = await loadBlueprintModule(HAPPY);
    mkdirSync(runDirFor(dir, runId), { recursive: true });
    snapshotBlueprint(runDirFor(dir, runId), blueprint, 3, HAPPY);
    seedDb.close();

    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;

    // resume on a missing run → 404 (the ghost path above covers 409-on-non-interrupted)
    const ghost = await api(baseUrl, "POST", "/runs/ghost/resume");
    expect(ghost.status).toBe(404);

    const resumed = await api(baseUrl, "POST", `/runs/${runId}/resume`, { by: "operator" });
    expect(resumed.status).toBe(200);
    expect((resumed.json as ControlResult).needs_review).toBe(1); // any resume flags it (T04 pin)
    await waitForStatus(baseUrl, runId, "success");
    const done = (await api(baseUrl, "GET", `/runs/${runId}`)).json as RunDetail;
    expect(done.run.status).toBe("success");
    expect(done.run.needs_review).toBe(1);
    const evts = await runEvents(baseUrl, runId);
    expect(evts.some((e) => e.type === "human_action" && e.data.action === "resume" && e.data.by === "operator")).toBe(true);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 40_000 });

// ── hooks: fire points + failure pauses ─────────────────────────────────

test("hooks fire with ctx.shell() in the run cwd (onPhaseStart AND onPhaseEnd)", async () => {
  const dir = tmpDataDir("contract-hooks");
  const cwd = scratchCwd("contract-hooks-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;
    const sub = await api(baseUrl, "POST", "/runs", { blueprint: HOOK, cwd, delayMs: 0 });
    const runId = (sub.json as SubmitRunResult).run_id;
    await waitForStatus(baseUrl, runId, "success");
    const log = readFileSync(join(cwd, "hooks.log"), "utf8").trim().split("\n");
    // the shell's $PWD is the REAL path (macOS /var → /private/var)
    expect(log).toEqual([`start build in ${realpathSync(cwd)}`, "end build"]);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

test("a throwing onPhaseStart audits + parks the run at the hook_failed menu (never dies silently)", async () => {
  const dir = tmpDataDir("contract-hook-start");
  const cwd = scratchCwd("contract-hook-start-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;
    const sub = await api(baseUrl, "POST", "/runs", { blueprint: HOOK_START_FAIL, cwd, delayMs: 0 });
    const runId = (sub.json as SubmitRunResult).run_id;
    await waitForStatus(baseUrl, runId, "paused");

    const viewer = (await api(baseUrl, "GET", `/runs/${runId}/pause`)).json as PauseView & { actions: string[] };
    expect(viewer.kind).toBe("hook_failed");
    expect(viewer.phase).toBe("build");
    expect(viewer.reason).toContain("hook start boom");
    expect(viewer.actions.sort()).toEqual(["fail", "restart_fresh", "steer"]);

    const evts = await runEvents(baseUrl, runId);
    const types = evts.map((e) => e.type);
    expect(types).toEqual([
      "run_submitted", // acceptance (F2)
      "run_status", // submitted → running at drive start
      "phase_start",
      "human_action", // the audit event
      "phase_end", // status failed
      "run_status", // running → paused
    ]);
    const hookAudit = evts.find((e) => e.type === "human_action")!;
    expect(hookAudit.data.action).toBe("hook_error");
    expect(hookAudit.data.detail).toContain("hook start boom");
    const phaseEndEvt = evts.find((e) => e.type === "phase_end")!;
    expect((phaseEndEvt.data as { status: string }).status).toBe("failed");
    // no session ever spawned (the start hook threw before spawn)
    expect(types.includes("agent_start")).toBe(false);

    // the menu is live: fail ends the run
    const failed = await api(baseUrl, "POST", `/runs/${runId}/fail`);
    expect(failed.status).toBe(200);
    await waitForStatus(baseUrl, runId, "failed");
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

test("a throwing onPhaseEnd records the phase FAILED + audits, then parks at the hook_failed menu", async () => {
  const dir = tmpDataDir("contract-hook-end");
  const cwd = scratchCwd("contract-hook-end-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;
    const sub = await api(baseUrl, "POST", "/runs", { blueprint: HOOK_END_FAIL, cwd, delayMs: 0 });
    const runId = (sub.json as SubmitRunResult).run_id;
    await waitForStatus(baseUrl, runId, "paused");

    const viewer = (await api(baseUrl, "GET", `/runs/${runId}/pause`)).json as PauseView;
    expect(viewer.kind).toBe("hook_failed");
    expect(viewer.reason).toContain("hook end boom");

    // the envelope WAS accepted, then onPhaseEnd threw: phase_end says failed
    const evts = await runEvents(baseUrl, runId);
    const phaseEnd = evts.find((e) => e.type === "phase_end")!;
    expect((phaseEnd.data as { status: string }).status).toBe("failed");
    expect(evts.some((e) => e.type === "human_action" && e.data.action === "hook_error" && String(e.data.detail).includes("onPhaseEnd"))).toBe(true);
    expect(evts.some((e) => e.type === "envelope")).toBe(true);

    await api(baseUrl, "POST", `/runs/${runId}/fail`);
    await waitForStatus(baseUrl, runId, "failed");
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

// ── submit error semantics: missing module / invalid blueprint / bad args ─

test("submit errors are clean 400s: missing module, bad args, no fixture/blueprint", async () => {
  const dir = tmpDataDir("contract-submit400");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;

    const missing = await api(baseUrl, "POST", "/runs", { blueprint: "/nonexistent/blueprint.ts" });
    expect(missing.status).toBe(400);
    expect(typeof (missing.json as { error: string }).error).toBe("string");

    const badArgs = await api(baseUrl, "POST", "/runs", { blueprint: HAPPY, args: "nope" });
    expect(badArgs.status).toBe(400);

    const neither = await api(baseUrl, "POST", "/runs", {});
    expect(neither.status).toBe(400);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
}, { timeout: 30_000 });

// ── the typed client over the merged HTTP server ───────────────────────────

test("typed client over the merged HTTP server; ApiError carries 404/409/400", async () => {
  const dir = tmpDataDir("contract-client");
  const cwd = scratchCwd("contract-client-cwd");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    expect(daemon.port).toBeGreaterThan(0); // ephemeral port read back on the handle
    const client = new DaemonClient({ baseUrl: daemon.baseUrl });
    expect((await client.health()).ok).toBe(true);
    expect((await client.status()).data_dir).toBe(dir);

    const sub = await client.submitRun({ fixture: "happy", delayMs: 0 });
    expect(sub.run_id).toBeTypeOf("string");
    expect(sub.queue_position).toBeNull();
    await waitForStatus(daemon.baseUrl, sub.run_id, "success");
    const detail = await client.getRun(sub.run_id);
    expect(detail.run.status).toBe("success");
    expect(detail.envelope_count).toBeTypeOf("number");
    const page = await client.getEvents(sub.run_id, { cursor: 0, limit: 500 });
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.next_cursor).toBeGreaterThan(0);
    const runs = await client.listRuns();
    expect(runs.runs[0]!.id).toBe(sub.run_id);
    const raw = await client.getRaw(sub.run_id, { lines: 5 });
    expect(raw.line_count).toBeGreaterThan(0);

    // ApiError statuses over the new transport — the codes the UI relies on:
    // 404 missing run, 409 control conflict (resume on a non-interrupted run),
    // 400 bad submit body
    await expect(client.getRun("ghost")).rejects.toMatchObject({ name: "ApiError", status: 404 });
    await expect(client.resume(sub.run_id)).rejects.toMatchObject({ name: "ApiError", status: 409 });
    await expect(client.submitRun({} as SubmitRunBody)).rejects.toMatchObject({ name: "ApiError", status: 400 });
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 40_000 });

// ── the one shared wire contract (issue #23): the compiler, not a structural
// test, enforces conformance — these pins fail `tsc --noEmit` on drift ────────

/** Standard Equal helper — true exactly when A and B are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

// apiTimeline (server producer) and DaemonClient.getTimeline (client
// consumer) both honor the TimelineView contract.
type _ServerTimelinePin = Assert<Equal<ReturnType<typeof apiTimeline>, TimelineView>>;
type _ClientTimelinePin = Assert<Equal<Awaited<ReturnType<DaemonClient["getTimeline"]>>, TimelineView>>;
type _NeedsReviewPin = Assert<Equal<TimelineView["needs_review"], boolean>>;

test("server and client re-export the SAME ApiError class (one wire contract)", () => {
  // the class identity is the contract: in-process calls throw the real one,
  // and the UI's `instanceof ApiError` cannot miss across the boundary
  expect(ServerApiError).toBe(ClientApiError);
});
