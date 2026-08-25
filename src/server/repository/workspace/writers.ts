import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { inputsDirFor, outputsDirFor, readAgentMap } from "./readers.ts";
import type { AgentMapEntry, Handoff } from "./readers.ts";

// ── materialization (envelope + artifacts, zero-friction) ───────────────

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

// ── raw record (write side) ────────────────────────────────────────────

/**
 * the run's raw record keeps the last accepted envelope, verbatim. Called
 * right after acceptance (valid + gates passed) — the same file T04's resume
 * path updates after a gate override records acceptance (recordEnvelopeAcceptance).
 */
export function recordAcceptedEnvelope(runDir: string, raw: string): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "envelope.json"), raw);
}

/** agent_map.json — { phase → { pi_session_id, pid, visit, model } }. The
 * map is keyed by phase and per-visit entries overwrite, so a revisited phase
 * records its LATEST session; each run dir starts fresh. */
export function writeAgentMap(runDir: string, phaseName: string, entry: AgentMapEntry): void {
  const map = readAgentMap(runDir);
  map[phaseName] = entry;
  writeFileSync(join(runDir, "agent_map.json"), JSON.stringify(map, null, 2) + "\n");
}
