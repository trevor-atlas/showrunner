import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { runDirFor } from "@showrunner/core";

import { insertEvent, listAgentSessions, listPhases, listRuns } from "./db.ts";
import { readAgentMap, sessionDirNameForCwd } from "./handoff.ts";
import { RawOutputFile } from "./rawfile.ts";
import { loadRoster } from "./roster.ts";
import { Tracer } from "./tracer.ts";

/**
 * §12.4 backfill — restore events the daemon missed while it was down.
 *
 * CHOICE (documented): re-read the pi session JSONL instead of `get_entries`.
 * After a SIGKILL the daemon owns no live pi process to query, and pi appends
 * every `message_end` to its session tree (<session-dir>/--<cwd>--/<ts>_<id>.jsonl)
 * — the same durable record `get_entries {since}` would serve — so the JSONL
 * is read directly and folded through the tracer. The dedup key is the run's
 * OWN raw_output.jsonl (§10, append-only, byte-identical): every raw line the
 * daemon already folded is in that file, so a restored line is one the daemon
 * never saw. That makes the sweep idempotent — the events table stays
 * append-only, no double-inserted events. (get_entries is the real-pi
 * alternative when the session tree's JSONL shape ever diverges from the RPC
 * stdout stream; the fold below keys off the raw line verbatim, which is exact
 * for the FakePi sessions the hermetic tests drive.)
 *
 * Runs the folded events through a fresh Tracer per agent session: usage
 * deltas → spend, tool calls → tool_call, and onEnd flushes any call left open
 * at the crash as ok:false truncated:true (§19) plus the agent_end verdict.
 */

export interface BackfillSessionReport {
  run_id: string;
  phase: string;
  pi_session_id: string;
  lines_restored: number;
  events_folded: number;
}

export interface BackfillSummary {
  /** the session root scanned (null when PI_CODING_AGENT_SESSION_DIR unset) */
  session_root: string | null;
  runs_scanned: number;
  sessions_scanned: number;
  lines_restored: number;
  events_folded: number;
  sessions: BackfillSessionReport[];
}

/** Every line currently in the run's raw file — the dedup set. */
function rawLinesSeen(rawPath: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(rawPath, "utf8");
  } catch {
    return new Set();
  }
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (line !== "") seen.add(line);
  }
  return seen;
}

/** The session JSONL for one pi session id: <sessionRoot>/--<sanitized-cwd>--/*_<id>.jsonl.
 * The ts prefix is pi's timestamp; a resumed run creates a NEW incarnation of
 * the same id, so the LAST match (chronological) is the current one.
 *
 * The child (pi / FakePi) sanitizes ITS OWN process.cwd() — the RESOLVED
 * path — so on symlinked roots (macOS /var → /private/var) the dir name can
 * differ from the run's cwd as submitted. Try the exact name first, then the
 * realpath-resolved one, then scan every session subdir as a fallback. */
function findSessionFile(sessionRoot: string, cwd: string, piSessionId: string): string | null {
  const wanted = `_${piSessionId}.jsonl`;
  const dirs = [join(sessionRoot, sessionDirNameForCwd(cwd))];
  try {
    const resolved = sessionDirNameForCwd(realpathSync(cwd));
    if (resolved !== dirs[0]) dirs.push(join(sessionRoot, resolved));
  } catch {
    // cwd gone — the exact name is all we have
  }
  for (const dir of dirs) {
    const hit = latestIn(dir, wanted);
    if (hit !== null) return hit;
  }
  // last resort: scan every session subdir (a moved/symlinked workspace)
  let roots: string[];
  try {
    roots = readdirSync(sessionRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(sessionRoot, e.name));
  } catch {
    return null;
  }
  for (const dir of roots) {
    const hit = latestIn(dir, wanted);
    if (hit !== null) return hit;
  }
  return null;
}

/** The newest `<ts>_<id>.jsonl` in a session dir, or null. */
function latestIn(dir: string, suffix: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const matches = entries.filter((e) => e.endsWith(suffix)).sort();
  const latest = matches[matches.length - 1];
  return latest === undefined ? null : join(dir, latest);
}

/** Lines of a session JSONL (LF framing, empty lines skipped). */
function sessionLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  } catch {
    return [];
  }
}

/**
 * Backfill the missed session tails for every INTERRUPTED run. Called on
 * daemon start AFTER orphan cleanup (§12.1: the children are reaped first, so
 * their session files are stable). Fully synchronous — events are inserted
 * directly (this is offline recovery, not live streaming, so the async
 * EventSink backpressure queue is not needed) and the daemon only reports up
 * once the restore is durable. Idempotent: restored lines land in the run's
 * raw file, so a second sweep finds nothing to do.
 */
export function backfillMissedEvents(
  db: Database,
  dataDir: string,
  opts: { sessionDir?: string } = {},
): BackfillSummary {
  const sessionRoot = opts.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? null;
  const summary: BackfillSummary = {
    session_root: sessionRoot,
    runs_scanned: 0,
    sessions_scanned: 0,
    lines_restored: 0,
    events_folded: 0,
    sessions: [],
  };
  if (sessionRoot === null) return summary; // no session tree — nothing to restore

  for (const run of listRuns(db)) {
    if (run.status !== "interrupted") continue;
    summary.runs_scanned += 1;
    const sessions = listAgentSessions(db, run.id);
    if (sessions.length === 0) continue;

    const runDir = runDirFor(dataDir, run.id);
    const rawPath = join(runDir, "raw_output.jsonl");
    const seen = rawLinesSeen(rawPath);
    const rawFile = new RawOutputFile(rawPath);
    const phaseById = new Map(listPhases(db, run.id).map((p) => [p.id, p]));
    const agentMap = readAgentMap(runDir);
    const roster = loadRoster(dataDir);

    for (const s of sessions) {
      const file = findSessionFile(sessionRoot, run.cwd, s.pi_session_id);
      if (file === null) continue;
      const phase = phaseById.get(s.phase_id);
      if (phase === undefined) continue;
      const mapEntry = agentMap[phase.name];
      const report: BackfillSessionReport = {
        run_id: run.id,
        phase: phase.name,
        pi_session_id: s.pi_session_id,
        lines_restored: 0,
        events_folded: 0,
      };
      const tracer = new Tracer({
        phase: phase.name,
        visit: s.visit,
        agent: phase.agent,
        model: mapEntry?.model ?? phase.agent, // agent_map carries the model (§10)
        roster,
        piSessionId: s.pi_session_id,
        sink: (evt) => {
          report.events_folded += 1;
          // direct insert: validated + durable before the daemon reports up
          insertEvent(db, {
            run_id: run.id,
            phase_id: phase.id,
            agent_session_id: s.id,
            type: evt.type,
            ts: new Date().toISOString(),
            data: evt.data,
          });
        },
        rawAppend: (line, final) => rawFile.append(line, final),
      });

      summary.sessions_scanned += 1;
      for (const line of sessionLines(file)) {
        if (seen.has(line)) continue; // already folded by the pre-crash daemon
        seen.add(line);
        report.lines_restored += 1;
        summary.lines_restored += 1;
        tracer.onLine(line);
      }
      if (report.lines_restored > 0) {
        // the stream is gone (the child was reaped): flush open tool calls as
        // truncated and emit the agent_end verdict (§19)
        tracer.onEnd({ exitCode: null }, { settled: false });
        summary.events_folded += report.events_folded;
        summary.sessions.push(report);
      }
    }
    rawFile.close();
  }
  return summary;
}
