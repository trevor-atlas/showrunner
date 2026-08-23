import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Envelope } from "../core/index.ts";

/**
 * The §9 context & handoff filesystem protocol (T05) — everything the harness
 * writes and reads under the run's raw record directory ({data_dir}/runs/<run_id>)
 * and under the run's cwd (the project the agent works on). Owned here so the
 * run loop only calls into one module.
 *
 * Run workspace layout (§9.1), all under the run's record dir — the harness
 * NEVER writes into the run's cwd, so a run can never dirty the checkout:
 *   <run_id>/<phase-slug>/inputs/   envelope.json + predecessor artifacts
 *   <run_id>/<phase-slug>/outputs/  envelope.json + artifacts (the AGENT's)
 *
 * Context resolution (§9.2): the prompt composer walks each `context` entry
 * (agent defaults, then phase additions); an entry that resolves to a readable
 * FILE (against the run's cwd, then the agent module's dir) is inlined into
 * the prompt's [Context] section, anything else is literal content. Exact paths
 * only, no globs. Collision rule (§19): a literal string that happens to match
 * a real filepath is read as a file — there is no escape syntax.
 *
 * Zero-friction handoff (§9.3): the predecessor's accepted envelope.json and
 * EVERY file it listed in `artifacts` are materialized into the next phase's
 * inputs/ automatically — no declaration required. Outputs of phase N become
 * inputs of phase N+1 by construction (materialized when phase N+1 starts, so
 * on_fail routing and pauses always hand the last ACCEPTED envelope).
 *
 * Raw record (§10) writes also live here: runDir/envelope.json (the last
 * accepted envelope, verbatim) and runDir/agent_map.json
 * ({ phase → { pi_session_id, pid, visit, model } }).
 */

/** §10 agent_map.json entry: enough to rebuild one session's DB row. */
export interface AgentMapEntry {
  pi_session_id: string;
  pid: number;
  visit: number;
  model: string;
}

/** The accepted handoff carried from one phase to the next (§9.3). */
export interface Handoff {
  /** the accepted envelope, parsed */
  envelope: Envelope;
  /** the accepted envelope's raw text, verbatim (§10) */
  raw: string;
  /** the phase that produced the accepted envelope — its outputs/ holds the artifacts */
  fromPhase: string;
}

/** Sanitize a phase name into a URL-safe slug for the run workspace (§9.1). */
export function slugFor(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ── §9.1 run workspace layout (under {data_dir}/runs/<run_id>) ──────────────

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
 * The pi session-directory name for a cwd (v3 layout, §8.1 — verified against
 * pi 0.84.2): `--<cwd with the leading separator stripped and [/\\:] → - >--`.
 * Real pi writes its session files to <sessionDir>/<this>/<ts>_<id>.jsonl.
 */
export function sessionDirNameForCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

// ── §9.3 materialization (envelope + artifacts, zero-friction) ───────────────

/** Materialize the predecessor handoff into <runDir>/<phase>/inputs/:
 * the accepted envelope.json (always present for phases > 0) plus every file
 * the predecessor's envelope listed in `artifacts`, copied from its outputs/.
 * The first phase has no predecessor (handoff === null). Artifacts that were
 * listed but are missing are skipped — the envelope was already accepted.
 */
export function materializeHandoff(runDir: string, phaseName: string, handoff: Handoff | null): void {
  if (handoff === null) return;
  const inputsDir = inputsDirFor(runDir, phaseName);
  mkdirSync(inputsDir, { recursive: true });
  writeFileSync(join(inputsDir, "envelope.json"), handoff.raw);

  const fromOutputs = outputsDirFor(runDir, handoff.fromPhase);
  for (const artifact of handoff.envelope.artifacts ?? []) {
    if (typeof artifact !== "string" || artifact === "") continue;
    const src = join(fromOutputs, artifact);
    // artifacts are relative to the predecessor's outputs/ — never read outside
    if (!isWithin(fromOutputs, src)) continue;
    if (!existsSync(src) || !statSync(src).isFile()) continue; // claimed but missing
    const dst = join(inputsDir, artifact);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

/** Is `p` a path strictly inside `dir`? (guards artifact path traversal) */
function isWithin(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * §8.2 prompt inlining: read the materialized §9.3 inputs back — each file's
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

// ── §9.2 context resolution ──────────────────────────────────────────────────

/**
 * Resolve context entries (§9.2): walk each entry (agent defaults, then phase
 * additions); a readable file (exact path, no globs — resolved against the
 * run's cwd, then the agent module's dir) is inlined; anything else is literal
 * content. §19 collision: a literal that matches a real filepath is read as a
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

// ── §10 raw record ───────────────────────────────────────────────────────────

/**
 * §10: the run's raw record keeps the last accepted envelope, verbatim. Called
 * right after acceptance (valid + gates passed) — the same file T04's resume
 * path updates after a gate override records acceptance (recordEnvelopeAcceptance).
 */
export function recordAcceptedEnvelope(runDir: string, raw: string): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "envelope.json"), raw);
}

/** §10: read agent_map.json; {} when absent or unparseable (per-run fresh). */
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

/** §10: agent_map.json — { phase → { pi_session_id, pid, visit, model } }. The
 * map is keyed by phase and per-visit entries overwrite, so a revisited phase
 * records its LATEST session; each run dir starts fresh. */
export function writeAgentMap(runDir: string, phaseName: string, entry: AgentMapEntry): void {
  const map = readAgentMap(runDir);
  map[phaseName] = entry;
  writeFileSync(join(runDir, "agent_map.json"), JSON.stringify(map, null, 2) + "\n");
}
