#!/usr/bin/env bun
import { resolve } from "node:path";
import { resolveDataDir, socketPathFor } from "@showrunner/core";
import { FIXTURE_NAMES, isFixtureName } from "@showrunner/core/test/fixtures";

// cli -> daemon is a relative import (see daemon-lifecycle.ts for why)
import { installSignalHandlers, startDaemon } from "../../daemon/src/daemon.ts";
import { getJson, isSocketDown, postJson } from "./client.ts";
import { ensureDaemon, stopDaemon } from "./daemon-lifecycle.ts";
import { formatEvent } from "./render.ts";
import { watchRun } from "./watch.ts";

/**
 * showrunner — the CLI (submit, list, watch, detail).
 *
 *   showrunner daemon                  run the daemon in the foreground
 *   showrunner run <fixture>           submit a scripted fixture run (T01a observation path)
 *   showrunner run <blueprint.ts>      submit a blueprint run (T01b §5 loop; FakePi sessions)
 *   showrunner runs                    list runs with status + phase counts
 *   showrunner show <run_id>           run detail: phases with status/visits/corrections/spend
 *   showrunner watch <run_id> [--interval N]
 *   showrunner steer <run_id> <msg>    send a corrective instruction to the run's session (§8.4)
 *   showrunner pause <run_id>          pause-state viewer + pause menu (pauses are automatic)
 *   showrunner approve <run_id>        approve a require_approval pause
 *   showrunner resume <run_id>         continue an interrupted run (flags needs_review)
 *   showrunner fail <run_id>           fail the run (kills children, §8.3)
 *   showrunner restart-fresh <run_id> [phase]
 *   showrunner override <run_id> --gate <name> --reason <why> [--phase <name>]
 *   showrunner stop                    SIGTERM the daemon (removes socket + pidfile)
 *
 * Global flags: --data-dir <dir> (env SHOWRUNNER_DATA_DIR is honored everywhere).
 * The CLI talks only to the daemon's HTTP API over the unix socket (§13).
 */

interface Flags {
  dataDir: string | undefined;
  positionals: string[];
  rest: Record<string, string | undefined>;
}

function parseArgs(argv: string[]): Flags {
  const positionals: string[] = [];
  const rest: Record<string, string | undefined> = {};
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--data-dir") {
      dataDir = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith("--data-dir=")) {
      dataDir = a.slice("--data-dir=".length);
      continue;
    }
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) {
      rest[m[1]!] = m[2] ?? argv[i + 1];
      if (m[2] === undefined) i++;
      continue;
    }
    positionals.push(a);
  }
  return { dataDir, positionals, rest };
}

function usage(): void {
  console.log(
    [
      "showrunner - agent orchestration, observable by construction",
      "",
      "usage:",
      "  showrunner daemon                        run the daemon in the foreground",
      "  showrunner run <fixture>                 submit a scripted fixture run (fixture: " + FIXTURE_NAMES.join("|") + ")",
      "  showrunner run <blueprint.ts> [--delay] submit a blueprint run (driven by FakePi sessions)",
      "  showrunner runs                          list runs with status + phase counts",
      "  showrunner show <run_id>                run detail: phases, visits, corrections, spend",
      "  showrunner watch <run_id> [--interval N] stream a run's folded events",
      "  showrunner steer <run_id> <msg>          steer the run's session (works paused or running)",
      "  showrunner pause <run_id>                pause-state viewer + pause menu",
      "  showrunner approve <run_id>              approve a require_approval pause",
      "  showrunner resume <run_id>               continue an interrupted run (flags needs_review)",
      "  showrunner fail <run_id>                 fail the run (kills children)",
      "  showrunner restart-fresh <run_id> [phase] restart the paused phase with a new session",
      "  showrunner override <run_id> --gate <g> --reason <r>  override a failed gate on the pause",
      "  showrunner stop                          stop the daemon",
      "",
      "flags: --data-dir <dir>   data directory (default ~/.showrunner, env SHOWRUNNER_DATA_DIR)",
    ].join("\n"),
  );
}

async function cmdRun(flags: Flags): Promise<number> {
  const arg = flags.positionals[0];
  if (!arg) {
    console.error("usage: showrunner run <fixture> | <blueprint.ts>");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);

  const submit = async (body: Record<string, unknown>): Promise<unknown> => {
    try {
      return await postJson(socketPath, "/runs", body);
    } catch (err) {
      if (isSocketDown(err)) throw err;
      // the daemon rejected the submit (bad blueprint, missing scripts, ...)
      console.error(`run rejected: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  if (isFixtureName(arg)) {
    const body: Record<string, unknown> = { fixture: arg };
    if (flags.rest.delay !== undefined) body.delayMs = Number(flags.rest.delay);
    if (flags.rest.cwd !== undefined) body.cwd = flags.rest.cwd;
    if (flags.rest.agent !== undefined) body.agent = flags.rest.agent;
    if (flags.rest.model !== undefined) body.model = flags.rest.model;
    if (flags.rest.phase !== undefined) body.phase = flags.rest.phase;

    const res = (await submit(body)) as {
      run_id: string;
      phase_id: string;
      agent_session_id: string;
      fixture: string;
    } | null;
    if (res === null) return 1;
    console.log(`run submitted: ${res.run_id}`);
    console.log(`  fixture: ${res.fixture}  phase: ${res.phase_id}  session: ${res.agent_session_id}`);
    console.log(`watch it with: showrunner watch ${res.run_id}`);
    return 0;
  }

  if (arg.endsWith(".ts")) {
    const body: Record<string, unknown> = { blueprint: resolve(arg) };
    if (flags.rest.cwd !== undefined) body.cwd = flags.rest.cwd;
    if (flags.rest.delay !== undefined) body.delayMs = Number(flags.rest.delay);
    const res = (await submit(body)) as { run_id: string; blueprint: string } | null;
    if (res === null) return 1;
    console.log(`run submitted: ${res.run_id}`);
    console.log(`  blueprint: ${res.blueprint}`);
    console.log(`watch it with: showrunner watch ${res.run_id}`);
    console.log(`detail with:  showrunner show ${res.run_id}`);
    return 0;
  }

  console.error(`unknown fixture or blueprint: ${arg} (fixtures: ${FIXTURE_NAMES.join("|")}; blueprints: a path to a .ts module)`);
  return 2;
}

async function cmdRuns(flags: Flags): Promise<number> {
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);
  const { runs } = (await getJson(socketPath, "/runs")) as {
    runs: {
      id: string;
      blueprint: string;
      status: string;
      started_at: string;
      ended_at: string | null;
      spend_usd: number;
      needs_review: number;
      phase_counts: Record<string, number>;
    }[];
  };
  if (runs.length === 0) {
    console.log("no runs yet - submit one with: showrunner run happy");
    return 0;
  }
  console.log("id                                   blueprint         status       phases       spend      started");
  for (const r of runs) {
    const review = r.needs_review ? " (needs review)" : "";
    const phases = `${r.phase_counts.success ?? 0}/${r.phase_counts.total ?? 0}`;
    console.log(
      `${r.id}  ${r.blueprint.padEnd(16)} ${r.status.padEnd(12)} ${phases.padStart(9)} $${r.spend_usd.toFixed(4).padStart(8)}  ${r.started_at}${review}`,
    );
  }
  return 0;
}

async function cmdShow(flags: Flags): Promise<number> {
  const runId = flags.positionals[0];
  if (!runId) {
    console.error("usage: showrunner show <run_id>");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);

  let detail: {
    run: { id: string; blueprint: string; status: string; cwd: string; started_at: string; ended_at: string | null; needs_review: number };
    spend_usd: number;
    estimated_spend_usd: number;
    event_count: number;
    phases: { name: string; status: string; visits: number; corrections: number; budget: number; spend_usd: number; estimated_spend_usd: number }[];
  };
  try {
    detail = (await getJson(socketPath, `/runs/${runId}`)) as typeof detail;
  } catch (err) {
    if (!isSocketDown(err)) {
      console.error(`run ${runId}: not found`);
      return 1;
    }
    throw err;
  }

  const { run } = detail;
  console.log(`run ${run.id}`);
  console.log(`  blueprint: ${run.blueprint}`);
  console.log(`  status: ${run.status}${run.needs_review ? " (needs review)" : ""}`);
  console.log(`  cwd: ${run.cwd}`);
  console.log(`  started: ${run.started_at}`);
  if (run.ended_at) console.log(`  ended: ${run.ended_at}`);
  const estTotal = detail.estimated_spend_usd > 0 ? ` (est ${detail.estimated_spend_usd.toFixed(4)})` : "";
  console.log(`  spend: $${detail.spend_usd.toFixed(4)}${estTotal}  events: ${detail.event_count}`);
  console.log("phases:");
  for (const p of detail.phases) {
    const est = p.estimated_spend_usd > 0 ? ` est=$${p.estimated_spend_usd.toFixed(4)}` : "";
    console.log(
      `  ${p.name.padEnd(16)} ${p.status.padEnd(12)} visits=${p.visits} corrections=${p.corrections} budget=${p.budget} spend=$${p.spend_usd.toFixed(4)}${est}`,
    );
  }
  return 0;
}

async function cmdWatch(flags: Flags): Promise<number> {
  const runId = flags.positionals[0];
  if (!runId) {
    console.error("usage: showrunner watch <run_id> [--interval N]");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);

  // fail fast on an unknown run id
  try {
    await getJson(socketPath, `/runs/${runId}`);
  } catch (err) {
    if (!isSocketDown(err)) {
      console.error(`run ${runId}: not found`);
      return 1;
    }
    throw err;
  }

  await watchRun({
    runId,
    socketPath,
    intervalMs: flags.rest.interval !== undefined ? Number(flags.rest.interval) : 500,
    onEvent: (e) => console.log(formatEvent(e)),
  });
  return 0;
}

async function cmdDaemon(flags: Flags): Promise<number> {
  const dataDir = flags.dataDir ?? resolveDataDir();
  try {
    const handle = startDaemon({ dataDir });
    installSignalHandlers(handle);
    console.log(`showrunner daemon listening on ${handle.socketPath} (pid ${process.pid})`);
    // keep the process alive; SIGINT/SIGTERM handled inside the daemon module
    await new Promise<never>(() => {});
  } catch (err) {
    console.error(`showrunner daemon: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return 0;
}

async function cmdStop(flags: Flags): Promise<number> {
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  try {
    await stopDaemon(socketPath, dataDir);
    console.log("daemon stopped");
    return 0;
  } catch (err) {
    console.error(`showrunner stop: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// ── T04 control verbs: steer / pause / resume / approve (+ the full pause
// menu: fail, restart-fresh, override). Each maps to a §13.2 daemon control
// endpoint and surfaces the resulting run state. `pause` has no manual-pause
// endpoint (pauses are automatic, §13) — it is the pause-state viewer / menu
// trigger for a paused run. ───────────────────────────────────────────────────

interface RunSummary {
  id: string;
  status: string;
  needs_review: number;
  ended_at: string | null;
}

async function fetchRun(socketPath: string, runId: string): Promise<RunSummary | null> {
  try {
    const body = (await getJson(socketPath, `/runs/${runId}`)) as { run: RunSummary };
    return body.run;
  } catch (err) {
    if (!isSocketDown(err)) return null; // unknown run → caller reports
    throw err;
  }
}

/** Poll /runs/:id until the status leaves the pre-action state (timeout ~10s). */
async function pollStatus(
  socketPath: string,
  runId: string,
  until: (s: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await fetchRun(socketPath, runId);
    if (run !== null && until(run.status)) return run.status;
    if (Date.now() > deadline) return (await fetchRun(socketPath, runId))?.status ?? "?";
    await new Promise((r) => setTimeout(r, 50));
  }
}

function printRunState(run: RunSummary): void {
  console.log(`  status: ${run.status}${run.needs_review ? " (needs review)" : ""}`);
  if (run.ended_at) console.log(`  ended: ${run.ended_at}`);
}

function bodyBy(flags: Flags): Record<string, unknown> {
  return flags.rest.by !== undefined ? { by: flags.rest.by } : {};
}

async function cmdSteer(flags: Flags): Promise<number> {
  const runId = flags.positionals[0];
  const message = flags.positionals.slice(1).join(" ").trim();
  if (!runId || message === "") {
    console.error("usage: showrunner steer <run_id> <message> [--by NAME]");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);
  try {
    const res = (await postJson(socketPath, `/runs/${runId}/steer`, {
      message,
      ...bodyBy(flags),
    })) as { ok: boolean; status: string; queued_steers: number; message: string };
    console.log(`steer queued for run ${runId} (${res.queued_steers} queued): ${message}`);
    console.log(res.message);
    const run = await fetchRun(socketPath, runId);
    if (run) printRunState(run);
    return 0;
  } catch (err) {
    console.error(`showrunner steer: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function cmdPause(flags: Flags): Promise<number> {
  const runId = flags.positionals[0];
  if (!runId) {
    console.error("usage: showrunner pause <run_id>");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);
  try {
    const body = (await getJson(socketPath, `/runs/${runId}/pause`)) as {
      run_id: string;
      paused: boolean;
      status: string;
      kind?: string;
      phase?: string;
      reason?: string | null;
      actions?: string[];
      queued_steers?: string[];
      live_session_id?: string | null;
    };
    if (!body.paused) {
      console.log(`run ${runId} is ${body.status} — not paused${body.reason ? ` (last reason: ${body.reason})` : ""}`);
      console.log("pauses are automatic (approval, budget, guard, blocked); see showrunner help");
      return 0;
    }
    console.log(`run ${runId} — PAUSED${body.kind ? ` (${body.kind})` : ""}`);
    if (body.phase) console.log(`  phase: ${body.phase}`);
    console.log(`  reason: ${body.reason}`);
    console.log(`  menu: ${(body.actions ?? []).join(" | ")}`);
    if ((body.queued_steers ?? []).length > 0) {
      console.log("  queued steers:");
      for (const s of body.queued_steers ?? []) console.log(`    - ${s}`);
    }
    console.log(`  live session: ${body.live_session_id ?? "none (no pi process while paused)"}`);
    console.log("recent events:");
    const events = (await getJson(socketPath, `/runs/${runId}/events?cursor=0&limit=12`)) as {
      events: import("@showrunner/core").EventRow[];
    };
    for (const e of events.events) console.log(`  ${formatEvent(e)}`);
    return 0;
  } catch (err) {
    console.error(`showrunner pause: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function cmdApprove(flags: Flags): Promise<number> {
  const runId = flags.positionals[0];
  if (!runId) {
    console.error("usage: showrunner approve <run_id> [--by NAME]");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);
  try {
    await postJson(socketPath, `/runs/${runId}/approve`, bodyBy(flags));
    const status = await pollStatus(socketPath, runId, (s) => s !== "paused");
    console.log(`run ${runId} approved — status: ${status}`);
    const run = await fetchRun(socketPath, runId);
    if (run) printRunState(run);
    return 0;
  } catch (err) {
    console.error(`showrunner approve: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function cmdResume(flags: Flags): Promise<number> {
  const runId = flags.positionals[0];
  if (!runId) {
    console.error("usage: showrunner resume <run_id> [--by NAME]");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);
  try {
    const res = (await postJson(socketPath, `/runs/${runId}/resume`, bodyBy(flags))) as {
      run_id: string;
      status: string;
      needs_review: number;
    };
    console.log(`run ${runId} resume recorded — status: ${res.status}, needs_review: ${res.needs_review === 1 ? "yes" : "no"}`);
    console.log("the resume attempt + needs_review flag are recorded; the relaunch+backfill continuation is T07");
    return 0;
  } catch (err) {
    console.error(`showrunner resume: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function cmdFail(flags: Flags): Promise<number> {
  const runId = flags.positionals[0];
  if (!runId) {
    console.error("usage: showrunner fail <run_id> [--by NAME]");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);
  try {
    await postJson(socketPath, `/runs/${runId}/fail`, bodyBy(flags));
    const status = await pollStatus(socketPath, runId, (s) => s === "failed" || s === "success");
    console.log(`run ${runId} failed — status: ${status}`);
    const run = await fetchRun(socketPath, runId);
    if (run) printRunState(run);
    return 0;
  } catch (err) {
    console.error(`showrunner fail: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Resolve the paused phase (explicit arg, else the pause viewer's phase). */
async function pausedPhase(socketPath: string, runId: string, explicit: string | undefined): Promise<string | null> {
  if (explicit !== undefined && explicit !== "") return explicit;
  try {
    const body = (await getJson(socketPath, `/runs/${runId}/pause`)) as { paused: boolean; phase?: string };
    return body.paused && body.phase ? body.phase : null;
  } catch {
    return null;
  }
}

async function cmdRestartFresh(flags: Flags): Promise<number> {
  const runId = flags.positionals[0];
  if (!runId) {
    console.error("usage: showrunner restart-fresh <run_id> [phase] [--by NAME]");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);
  try {
    const phase = await pausedPhase(socketPath, runId, flags.positionals[1]);
    if (phase === null) {
      console.error(`run ${runId} is not paused — restart-fresh is a pause-menu verb`);
      return 1;
    }
    await postJson(socketPath, `/runs/${runId}/phases/${encodeURIComponent(phase)}/restart-fresh`, bodyBy(flags));
    const status = await pollStatus(socketPath, runId, (s) => s !== "paused");
    console.log(`run ${runId} phase "${phase}" restarted fresh — status: ${status}`);
    const run = await fetchRun(socketPath, runId);
    if (run) printRunState(run);
    return 0;
  } catch (err) {
    console.error(`showrunner restart-fresh: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function cmdOverride(flags: Flags): Promise<number> {
  const runId = flags.positionals[0];
  const gate = flags.rest.gate;
  const reason = flags.rest.reason;
  if (!runId || !gate || !reason) {
    console.error("usage: showrunner override <run_id> --gate <name> --reason <why> [--phase <name>] [--by NAME]");
    return 2;
  }
  const dataDir = flags.dataDir ?? resolveDataDir();
  const socketPath = socketPathFor(dataDir);
  await ensureDaemon(socketPath, dataDir);
  try {
    const phase = await pausedPhase(socketPath, runId, flags.rest.phase);
    if (phase === null) {
      console.error(`run ${runId} is not paused — override is a pause-menu verb`);
      return 1;
    }
    await postJson(socketPath, `/runs/${runId}/phases/${encodeURIComponent(phase)}/override`, {
      gate,
      reason,
      ...bodyBy(flags),
    });
    const status = await pollStatus(socketPath, runId, (s) => s !== "paused");
    console.log(`run ${runId} gate "${gate}" overridden — status: ${status}`);
    const run = await fetchRun(socketPath, runId);
    if (run) printRunState(run);
    return 0;
  } catch (err) {
    console.error(`showrunner override: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv);
  const cmd = flags.positionals[0];
  flags.positionals.shift();
  switch (cmd) {
    case "run":
      return cmdRun(flags);
    case "runs":
      return cmdRuns(flags);
    case "show":
      return cmdShow(flags);
    case "watch":
      return cmdWatch(flags);
    case "daemon":
      return cmdDaemon(flags);
    case "stop":
      return cmdStop(flags);
    case "steer":
      return cmdSteer(flags);
    case "pause":
      return cmdPause(flags);
    case "approve":
      return cmdApprove(flags);
    case "resume":
      return cmdResume(flags);
    case "fail":
      return cmdFail(flags);
    case "restart-fresh":
      return cmdRestartFresh(flags);
    case "override":
      return cmdOverride(flags);
    case "help":
    case "-h":
    case "--help":
    case undefined:
      usage();
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
