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
    event_count: number;
    phases: { name: string; status: string; visits: number; corrections: number; budget: number; spend_usd: number }[];
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
  console.log(`  spend: $${detail.spend_usd.toFixed(4)}  events: ${detail.event_count}`);
  console.log("phases:");
  for (const p of detail.phases) {
    console.log(
      `  ${p.name.padEnd(16)} ${p.status.padEnd(12)} visits=${p.visits} corrections=${p.corrections} budget=${p.budget} spend=$${p.spend_usd.toFixed(4)}`,
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
