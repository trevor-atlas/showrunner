import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Envelope } from "../../../core/index.ts";

/**
 * The context & handoff filesystem protocol (T05) — everything the harness
 * writes and reads under the run's raw record directory ({data_dir}/runs/<run_id>)
 * and under the run's cwd (the project the agent works on). Owned here so the
 * run loop only calls into one module.
 *
 * Run workspace layout, all under the run's record dir — the harness
 * NEVER writes into the run's cwd, so a run can never dirty the checkout:
 *   <run_id>/<phase-slug>/inputs/   envelope.json + predecessor artifacts
 *   <run_id>/<phase-slug>/outputs/  envelope.json + artifacts (the AGENT's)
 *
 * Context resolution: the prompt composer walks each `context` entry
 * (agent defaults, then phase additions); an entry that resolves to a readable
 * FILE (against the run's cwd, then the agent module's dir) is inlined into
 * the prompt's [Context] section, anything else is literal content. Exact paths
 * only, no globs. Collision rule: a literal string that happens to match
 * a real filepath is read as a file — there is no escape syntax.
 *
 * Zero-friction handoff: the predecessor's accepted envelope.json and
 * EVERY file it listed in `artifacts` are materialized into the next phase's
 * inputs/ automatically — no declaration required. Outputs of phase N become
 * inputs of phase N+1 by construction (materialized when phase N+1 starts, so
 * on_fail routing and pauses always hand the last ACCEPTED envelope).
 *
 * Raw record files also live here: runDir/envelope.json (the last
 * accepted envelope, verbatim) and runDir/agent_map.json
 * ({ phase → { pi_session_id, pid, visit, model } }).
 *
 * The read side lives here (readers.ts); the write side lives in writers.ts.
 * Both are re-exported from index.ts, and src/daemon/handoff.ts is a thin
 * re-export shim over this module so existing importers keep compiling.
 */

/** agent_map.json entry: enough to rebuild one session's DB row. */
export interface AgentMapEntry {
  pi_session_id: string;
  pid: number;
  visit: number;
  model: string;
}

/** The accepted handoff carried from one phase to the next. */
export interface Handoff {
  /** the accepted envelope, parsed */
  envelope: Envelope;
  /** the accepted envelope's raw text, verbatim */
  raw: string;
  /** the phase that produced the accepted envelope — its outputs/ holds the artifacts */
  fromPhase: string;
}

/** Sanitize a phase name into a URL-safe slug for the run workspace. */
export function slugFor(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ── run workspace layout (under {data_dir}/runs/<run_id>) ──────────────

export function phaseDirFor(runDir: string, phaseName: string): string {
  return join(runDir, slugFor(phaseName));
}

export function inputsDirFor(runDir: string, phaseName: string): string {
  return join(phaseDirFor(runDir, phaseName), "inputs");
}

export function outputsDirFor(runDir: string, phaseName: string): string {
  return join(phaseDirFor(runDir, phaseName), "outputs");
}

/**
 * The pi session-directory name for a cwd (v3 layout, — verified against
 * pi 0.84.2): `--<cwd with the leading separator stripped and [/\\:] → - >--`.
 * Real pi writes its session files to <sessionDir>/<this>/<ts>_<id>.jsonl.
 */
export function sessionDirNameForCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

// ── prompt inlining: read materialized inputs back ─────────────────────

/**
 * prompt inlining: read the materialized inputs back — each file's
 * path relative to <runDir>/<phase>/inputs/ plus its contents, so the composed
 * prompt can name the inputs path(s) and inline what was materialized.
 * Sorted and deterministic; [] when the inputs dir was never materialized
 * (first phase, or the run loop hasn't reached materialization yet).
 */
export function readHandoffInputs(
  runDir: string,
  phaseName: string,
): { rel: string; contents: string }[] {
  const out: { rel: string; contents: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // inputs dir absent/unreadable — nothing to inline
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        try {
          out.push({ rel, contents: readFileSync(join(dir, entry.name), "utf8") });
        } catch {
          // listed but unreadable — skip (best effort, mirrors resolveContext)
        }
      }
    }
  };
  walk(inputsDirFor(runDir, phaseName), "");
  return out;
}

// ── context resolution ──────────────────────────────────────────────────

/**
 * Resolve context entries: walk each entry (agent defaults, then phase
 * additions); a readable file (exact path, no globs — resolved against the
 * run's cwd, then the agent module's dir) is inlined; anything else is literal
 * content. collision: a literal that matches a real filepath is read as a
 * file — there is no escape syntax.
 */
export function resolveContext(
  cwd: string,
  moduleDir: string | null,
  entries: string[],
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const file = resolveContextFile(cwd, moduleDir, entry);
    if (file === null) {
      out.push(entry); // literal content
      continue;
    }
    try {
      out.push(readFileSync(file, "utf8")); // inlined file contents
    } catch {
      out.push(entry); // listed but unreadable → literal (best effort)
    }
  }
  return out;
}

/** Exact-path resolution: cwd first, then the agent module's dir. */
function resolveContextFile(cwd: string, moduleDir: string | null, entry: string): string | null {
  const candidates: string[] = [];
  if (isAbsolute(entry)) {
    candidates.push(entry);
  } else {
    candidates.push(join(cwd, entry));
    if (moduleDir) candidates.push(join(moduleDir, entry));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // keep walking
    }
  }
  return null;
}

// ── raw record (read side) ─────────────────────────────────────────────

/** read agent_map.json; {} when absent or unparseable (per-run fresh). */
export function readAgentMap(runDir: string): Record<string, AgentMapEntry> {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, "agent_map.json"), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, AgentMapEntry>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read the phase's outputs/ dir: the files the agent actually wrote (for
 * the ENVELOPE card's artifact-existence check) and FINDINGS.md when the
 * agent wrote one (rendered readably). Absent dir → empty listing;
 * unreadable files are skipped (best effort — this is display, not
 * validation). Ported from the UI drill-in controller — the api core's
 * phase-outputs endpoint reads it (the UI lost its last fs path past the
 * seam).
 */
export function readOutputsDir(
  runDir: string,
  phaseName: string,
): { files: string[]; findingsMd: string | null } {
  const dir = outputsDirFor(runDir, phaseName);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => {
      try {
        return statSync(join(dir, f)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return { files: [], findingsMd: null };
  }
  const findingsFile = files.find((f) => f.toLowerCase() === "findings.md");
  let findingsMd: string | null = null;
  if (findingsFile !== undefined) {
    try {
      const full = join(dir, findingsFile);
      if (existsSync(full)) findingsMd = readFileSync(full, "utf8");
    } catch {
      findingsMd = null;
    }
  }
  return { files, findingsMd };
}
