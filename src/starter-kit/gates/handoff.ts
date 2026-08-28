import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Gate } from "../../core/index.ts";
import { defineGate } from "../../core/index.ts";
import { inputsDirFor, violation } from "./shared.ts";

// ── handoff/plan gates ───────────────────────────────────────────────────────

export interface MatchesPlanOptions {
  /**
   * the exact plan file name to look for in this phase's inputs/ dir
   * (default: the first input file whose name contains "plan")
   */
  planFile?: string;
}

/**
 * matchesPlan — the envelope must reference the plan this phase was handed.
 * Reads the phase's materialized inputs (ctx.inputs_dir — <runDir>/<phase>/inputs),
 * finds the plan document (an earlier planner phase listed it in its
 * artifacts), and passes only if the envelope names it — in its
 * artifacts, or in notes_for_next_agent/summary. Fails loudly when no plan
 * arrived, so a phase that assumed a plan exists cannot silently pass.
 */
export function matchesPlan(opts: MatchesPlanOptions = {}): Gate {
  return defineGate("matchesPlan", async function matchesPlan(envelope, ctx) {
    const inputs = inputsDirFor(ctx);
    if (inputs === "") {
      return violation("no inputs dir", "the server did not provide ctx.inputs_dir — cannot verify the phase was handed a plan");
    }
    if (!existsSync(inputs)) {
      return violation("no plan to match", `no inputs materialized at ${inputs} — a planner phase must run first`);
    }
    let planName: string | null = opts.planFile ?? null;
    if (planName === null) {
      const candidates = readdirSync(inputs).filter((f) => /plan/i.test(f));
      planName = candidates[0] ?? null;
    }
    if (planName === null) {
      return violation("no plan to match", `no file named like a plan (or "${opts.planFile}") in ${inputs}`);
    }
    if (planName.includes("/")) {
      // allow "docs/plan.md" style values that name a nested path under inputs
      const full = join(inputs, planName);
      if (!existsSync(full) || !statSync(full).isFile()) {
        return violation("no plan to match", `plan file ${planName} not found in ${inputs}`);
      }
    } else {
      const full = join(inputs, planName);
      if (!existsSync(full) || !statSync(full).isFile()) {
        return violation("no plan to match", `plan file ${planName} not found in ${inputs}`);
      }
    }
    const haystack = [envelope.summary, envelope.notes_for_next_agent, ...envelope.artifacts].join("\n").toLowerCase();
    if (!haystack.includes(planName.toLowerCase())) {
      return violation(
        "work does not reference the plan",
        `envelope must name "${planName}" in its artifacts or notes_for_next_agent`,
      );
    }
    return { pass: true };
  });
}

/**
 * findingsReported — a read-only recon phase must have REPORTED something.
 * The scout writes its findings to a file in its own outputs/ dir (FINDINGS.md)
 * and lists it in envelope.artifacts; the gate fails an envelope whose
 * artifacts do not name the file, or whose file is missing or empty — the
 * scout skill's "a scout that reported nothing cannot pass" promise, actually
 * enforced (the old envelopeShape gate re-parsed the same schema and always
 * passed).
 */
export function findingsReported(opts: { file?: string } = {}): Gate {
  const fileName = opts.file ?? "FINDINGS.md";
  return defineGate("findingsReported", async function findingsReported(envelope, ctx) {
    if (!envelope.artifacts.includes(fileName)) {
      return violation(
        "findings file not listed",
        `envelope.artifacts must list "${fileName}" — write your findings to your outputs/${fileName} and list it there`,
      );
    }
    if (ctx.outputs_dir === undefined || ctx.outputs_dir === "") {
      return violation("outputs dir unavailable", `cannot verify outputs/${fileName} — the gate context carries no outputs_dir`);
    }
    const full = join(ctx.outputs_dir, fileName);
    if (!existsSync(full)) {
      return violation("findings file missing", `${fileName} is listed in artifacts but not found in ${ctx.outputs_dir}`);
    }
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      return violation("findings file unreadable", `cannot stat ${full}`);
    }
    if (size === 0) {
      return violation("findings file empty", `${fileName} exists but is empty — report at least one finding`);
    }
    return { pass: true };
  });
}
