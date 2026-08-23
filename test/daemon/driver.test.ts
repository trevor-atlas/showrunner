import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventRow } from "../../src/core/index.ts";
import { fixturePath } from "../core/fixtures.ts";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import {
  cursorEvents,
  eventCount,
  getRun,
  listAgentSessions,
  listPhases,
  listProcesses,
  openDb,
  submitFixture,
} from "../../src/daemon/index.ts";
import { runDirFor } from "../../src/core/index.ts";

const HAPPY_SPEND = 0.00102 + 0.00189 + 0.00172; // 0.00463, from the fixture's cumulative usage

function openTmp(label: string) {
  const dir = tmpDataDir(label);
  const db = openDb(join(dir, "showrunner.db"));
  return { dir, db };
}

/** A scratch run cwd for fixture submissions — the agent works there, but the
 * §9 workspace (inputs/outputs) lives under the run's record dir, never the
 * repo root (the test runner's working directory). Mirrors the server/e2e
 * scratch-cwd pattern. */
function tmpCwd(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-driver-cwd-${label}-`));
}

test("happy fixture: full lifecycle lands as folded events, in order", async () => {
  const { dir, db } = openTmp("driver-happy");
  const cwd = tmpCwd("happy");
  try {
    const sub = submitFixture(db, dir, { fixture: "happy", delayMs: 0, cwd });
    const outcome = await sub.done;

    expect(outcome).toEqual({ status: "success", needs_review: false });

    const events = cursorEvents(db, sub.run_id, 0, 1000);
    const types = events.map((e) => e.type);
    // §5/§6 lifecycle, in fixture order (usage arrives before the tool call it paid for;
    // call_03's streamed updates carry no usage, so two tool_calls land adjacently)
    expect(types).toEqual([
      "run_submitted",
      "run_status", // submitted -> running
      "phase_start",
      "agent_start",
      "spend",
      "tool_call",
      "spend",
      "tool_call",
      "tool_call",
      "spend",
      "agent_end",
      "phase_end",
      "run_status", // running -> success
    ]);

    const statuses = events.filter((e) => e.type === "run_status").map((e) => (e.data as { from: string; to: string }).to);
    expect(statuses).toEqual(["running", "success"]);

    const toolCalls = events.filter((e) => e.type === "tool_call").map((e) => e.data as { tool: string; tool_call_id: string; ok: boolean; result_snippet: string });
    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0]).toMatchObject({ tool: "bash", tool_call_id: "call_01", ok: true });
    expect(toolCalls[0]!.result_snippet).toBe("src/\nindex.ts\n");
    expect(toolCalls[1]).toMatchObject({ tool: "edit", tool_call_id: "call_02", args: { filePath: "packages/daemon/src/db.ts" } });
    // the two updates REPLACED: the folded snippet is the final accumulated text
    expect(toolCalls[2]!.result_snippet).toBe("# pass 12\n# fail 0\n");

    const spends = events.filter((e) => e.type === "spend").map((e) => e.data as { usd: number; tokens_in: number; tokens_out: number });
    expect(spends.reduce((s, x) => s + (x.usd ?? 0), 0)).toBeCloseTo(HAPPY_SPEND);
    // deltas sum to the cumulative total (§7.3 diffs per (phase, visit))
    expect(spends.reduce((s, x) => s + x.tokens_in, 0)).toBe(1400);
    expect(spends.reduce((s, x) => s + x.tokens_out, 0)).toBe(380);

    const agentEnd = events.find((e) => e.type === "agent_end")!.data as { agent: string; pi_session_id: string; ok: boolean; exit: number };
    expect(agentEnd).toMatchObject({ ok: true, exit: 0, agent: "builder", pi_session_id: `${sub.run_id.slice(0, 8)}_build_v1` });

    const phaseEnd = events.find((e) => e.type === "phase_end")!.data as { status: string; spend_usd: number };
    expect(phaseEnd.status).toBe("success");
    expect(phaseEnd.spend_usd).toBeCloseTo(HAPPY_SPEND);

    // rows
    const run = getRun(db, sub.run_id)!;
    expect(run.status).toBe("success");
    expect(run.needs_review).toBe(0);
    expect(run.blueprint).toBe("fixture:happy");
    const phases = listPhases(db, sub.run_id);
    expect(phases[0]).toMatchObject({ name: "build", agent: "builder", status: "success", visits: 1, corrections: 0, budget: 3 });
    expect(phases[0]!.spend_usd).toBeCloseTo(HAPPY_SPEND);
    const sessions = listAgentSessions(db, sub.run_id);
    expect(sessions[0]).toMatchObject({ pi_session_id: `${sub.run_id.slice(0, 8)}_build_v1`, visit: 1 });
    // the child is gone: no live processes remain
    expect(listProcesses(db)).toHaveLength(0);
    // event ids are the rowid cursor, ascending from 1
    expect(events[0]!.id).toBe(1);
    expect(eventCount(db, sub.run_id)).toBe(13);
  } finally {
    db.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("raw_output.jsonl captures the fixture byte-identically (§10)", async () => {
  const { dir, db } = openTmp("driver-raw");
  const cwd = tmpCwd("raw");
  try {
    const sub = submitFixture(db, dir, { fixture: "happy", delayMs: 0, cwd });
    await sub.done;
    const rawPath = join(runDirFor(dir, sub.run_id), "raw_output.jsonl");
    const raw = readFileSync(rawPath, "utf8");
    expect(raw).toBe(readFileSync(fixturePath("happy"), "utf8"));
  } finally {
    db.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("agent_map.json records phase -> session mapping (§10)", async () => {
  const { dir, db } = openTmp("driver-map");
  const cwd = tmpCwd("map");
  try {
    const sub = submitFixture(db, dir, { fixture: "happy", delayMs: 0, cwd, agent: "scout", model: "gpt-x", phase: "recon" });
    await sub.done;
    const map = JSON.parse(readFileSync(join(runDirFor(dir, sub.run_id), "agent_map.json"), "utf8")) as Record<string, unknown>;
    expect(map["recon"]).toMatchObject({ pi_session_id: `${sub.run_id.slice(0, 8)}_recon_v1`, visit: 1, model: "gpt-x" });
    expect((map["recon"] as { pid: number }).pid).toBeGreaterThan(0);
  } finally {
    db.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stderr diagnostics are captured per run (§8.3)", async () => {
  const { dir, db } = openTmp("driver-stderr");
  const cwd = tmpCwd("stderr");
  try {
    const sub = submitFixture(db, dir, { fixture: "happy", delayMs: 0, cwd, stderrLine: "fake-pi: warning: model catalog slow" });
    await sub.done;
    const log = readFileSync(join(runDirFor(dir, sub.run_id), "stderr.log"), "utf8");
    expect(log).toContain("fake-pi: warning: model catalog slow");
  } finally {
    db.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("crash fixture: run fails, needs_review set, open tool call flushed truncated (§12.5)", async () => {
  const { dir, db } = openTmp("driver-crash");
  const cwd = tmpCwd("crash");
  try {
    const sub = submitFixture(db, dir, { fixture: "crash", delayMs: 0, cwd });
    const outcome = await sub.done;
    expect(outcome).toEqual({ status: "failed", needs_review: true });

    const events = cursorEvents(db, sub.run_id, 0, 1000);
    const agentEnd = events.find((e) => e.type === "agent_end")!.data as { ok: boolean; exit: number | null };
    expect(agentEnd.ok).toBe(false);
    expect(agentEnd.exit).toBe(1);

    const truncated = events.filter((e) => e.type === "tool_call" && (e.data as { truncated?: boolean }).truncated);
    expect(truncated.length).toBeGreaterThanOrEqual(1);
    expect((truncated[0]!.data as { tool: string }).tool).toBe("bash"); // call_c1 was open at death

    const run = getRun(db, sub.run_id)!;
    expect(run.status).toBe("failed");
    expect(run.needs_review).toBe(1);

    const statuses = events.filter((e) => e.type === "run_status").map((e) => e.data as { from: string; to: string; reason?: string });
    const final = statuses[statuses.length - 1]!;
    expect(final.to).toBe("failed");
    expect(final.reason).toMatch(/agent_settled/);
  } finally {
    db.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate-fail fixture settles cleanly (scenario replay; gates run in T01b)", async () => {
  const { dir, db } = openTmp("driver-gatefail");
  const cwd = tmpCwd("gatefail");
  try {
    const sub = submitFixture(db, dir, { fixture: "gate-fail", delayMs: 0, cwd });
    const outcome = await sub.done;
    expect(outcome.status).toBe("success");
    // 5 tool calls in that fixture
    expect(cursorEvents(db, sub.run_id, 0, 1000).filter((e) => e.type === "tool_call")).toHaveLength(5);
    const bad = cursorEvents(db, sub.run_id, 0, 1000).filter((e) => e.type === "tool_call" && !(e.data as { ok: boolean }).ok);
    expect(bad).toHaveLength(2); // the failing grep and edit
  } finally {
    db.close();
    cleanupDir(dir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("submitFixture rejects unknown fixtures", () => {
  const { dir, db } = openTmp("driver-bad");
  try {
    expect(() => submitFixture(db, dir, { fixture: "nope" as never, delayMs: 0 })).toThrow(/unknown fixture/);
  } finally {
    db.close();
    cleanupDir(dir);
  }
});
