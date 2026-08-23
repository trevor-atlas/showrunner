import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Gate, GateContext, GateResult } from "@showrunner/core";
import { createShell } from "@showrunner/core";

/**
 * Shared gates library (PLAN §14, spec §3.4). Each export is a curried gate
 * factory: `testsPass()` returns a Gate you drop into a phase's `gates` array.
 * Gates are workspace-aware via ctx (cwd, phase, visit) and use `ctx.shell()`
 * where a command must run — falling back to core's `createShell` when the
 * runtime does not provide one.
 *
 * Replace-this: the defaults (test command, lint command, plan-file naming)
 * describe the demo project. Override them per phase or edit this file — that
 * is the point.
 */

/** The §9.1 handoff layout is a spec fact; the gates need it to read inputs. */
export function inputsDirFor(cwd: string, phase: string): string {
  const slug = phase.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(cwd, "context_handoff", slug, "inputs");
}

/** Run one shell command in the gate's workspace; honors ctx.shell when present. */
export function workspaceShell(ctx: GateContext, cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  if (ctx.shell) return ctx.shell(cmd);
  return createShell(ctx.cwd)(cmd);
}

function violation(label: string, detail: string): GateResult {
  return { pass: false, violations: [detail.trim() ? `${label}: ${detail.trim()}` : label] };
}

/** tail helper for keeping violation messages bounded */
function tail(s: string, n = 20): string {
  const lines = s.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= n) return s;
  return `... (${lines.length - n} lines omitted)\n${lines.slice(-n).join("\n")}`;
}

// ── command gates ────────────────────────────────────────────────────────────

export interface CommandGateOptions {
  /** the command to run in the workspace (default per gate) */
  command?: string;
}

/**
 * testsPass — the test suite must be green. Runs the phase's test command in
 * the workspace; a non-zero exit (or a command crash) is a violation with the
 * output tail attached. Default command: `bun test` (the demo project's test
 * runner — pass `{ command: "npm test" }` etc. to replace it).
 */
export function testsPass(opts: CommandGateOptions = {}): Gate {
  const command = opts.command ?? "bun test";
  return async function testsPass(envelope, ctx) {
    const res = await workspaceShell(ctx, command);
    if (res.code === 0) return { pass: true };
    return violation(`tests failed (exit ${res.code})`, `${res.stderr || res.stdout || "no output"}`);
  };
}

/**
 * lintClean — the linter/typecheck must be clean. Runs the phase's lint
 * command in the workspace; a non-zero exit is a violation with the output
 * tail attached. Default command: `bunx tsc --noEmit` (the demo project's
 * typecheck — pass `{ command: "bun run lint" }` to replace it).
 */
export function lintClean(opts: CommandGateOptions = {}): Gate {
  const command = opts.command ?? "bunx tsc --noEmit";
  return async function lintClean(envelope, ctx) {
    const res = await workspaceShell(ctx, command);
    if (res.code === 0) return { pass: true };
    return violation(`lint/typecheck failed (exit ${res.code})`, `${tail(res.stderr || res.stdout || "no output")}`);
  };
}

// ── envelope gates ───────────────────────────────────────────────────────────

export interface EnvelopeShapeOptions {  /** cap on how many zod issues become violations */
  maxIssues?: number;
}

/** The structural slice of zod's safeParse result the gate needs. */
interface ShapeParseResult {
  success: boolean;
  error?: { issues: { path: (string | number)[]; message: string }[] };
}

/**
 * envelopeShape — the envelope must satisfy a schema. Useful when a phase must
 * double-check a contract stricter than its own parse schema (the daemon
 * already parses against phase.envelope; this gate exists for the extra
 * contract the phase wants to enforce on top).
 */
export function envelopeShape<S extends { safeParse(input: unknown): ShapeParseResult }>(
  schema: S,
  opts: EnvelopeShapeOptions = {},
): Gate {
  const maxIssues = opts.maxIssues ?? 5;
  return async function envelopeShape(envelope) {
    const res = schema.safeParse(envelope);
    if (res.success) return { pass: true };
    const issues = res.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? [];
    const shown = issues.slice(0, maxIssues);
    if (issues.length > maxIssues) shown.push(`... and ${issues.length - maxIssues} more`);
    return { pass: false, violations: shown.length > 0 ? shown : ["envelope does not match the required shape"] };
  };
}

// ── handoff/plan gates ───────────────────────────────────────────────────────

export interface MatchesPlanOptions {
  /**
   * the exact plan file name to look for in context_handoff/<phase>/inputs/
   * (default: the first input file whose name contains "plan")
   */
  planFile?: string;
}

/**
 * matchesPlan — the envelope must reference the plan this phase was handed.
 * Reads the phase's materialized inputs (context_handoff/<phase>/inputs/),
 * finds the plan document (an earlier planner phase listed it in its
 * artifacts, §9.3), and passes only if the envelope names it — in its
 * artifacts, or in notes_for_next_agent/summary. Fails loudly when no plan
 * arrived, so a phase that assumed a plan exists cannot silently pass.
 */
export function matchesPlan(opts: MatchesPlanOptions = {}): Gate {
  return async function matchesPlan(envelope, ctx) {
    const inputs = inputsDirFor(ctx.cwd, ctx.phase);
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
  };
}

export interface FilesExistOptions {
  /** exact relative paths that envelope.artifacts must include (default: []) */
  paths?: string[];
  /** also require at least one artifact beyond the listed paths */
  requireAny?: boolean;
}

/**
 * filesExist — the envelope must list real files. With `paths`, each listed
 * path must appear in envelope.artifacts (and exist in the workspace). With
 * no paths, the envelope must carry at least one artifact — the phase must
 * have produced something, not just prose.
 */
export function filesExist(opts: FilesExistOptions = {}): Gate {
  const required = opts.paths ?? [];
  const requireAny = opts.requireAny ?? required.length === 0;
  return async function filesExist(envelope, ctx) {
    const violations: string[] = [];
    if (requireAny && envelope.artifacts.length === 0) {
      violations.push("envelope lists no artifacts — the phase must produce at least one file");
    }
    for (const rel of required) {
      if (!envelope.artifacts.includes(rel)) {
        violations.push(`artifact "${rel}" is missing from envelope.artifacts`);
        continue;
      }
      const full = join(ctx.cwd, rel);
      if (!existsSync(full)) violations.push(`artifact "${rel}" does not exist in the workspace`);
    }
    if (violations.length > 0) return { pass: false, violations };
    return { pass: true };
  };
}

export interface ReviewApprovedOptions {
  /** the field that must be true (default: "approved") */
  field?: string;
}

/**
 * reviewApproved — the reviewer's verdict gate: the envelope must assert
 * approval (default field `approved: true`). A rejected review becomes a
 * violation, which the phase budget turns into a correction or routes through
 * on_fail back to the builder (the bounded revise loop).
 */
export function reviewApproved(opts: ReviewApprovedOptions = {}): Gate {
  const field = opts.field ?? "approved";
  return async function reviewApproved(envelope) {
    const value = (envelope as unknown as Record<string, unknown>)[field];
    if (value === true) return { pass: true };
    const verdict = (envelope as unknown as Record<string, unknown>).verdict;
    return {
      pass: false,
      violations: [
        `review did not approve (${field} !== true)` + (typeof verdict === "string" && verdict !== "" ? ` — ${verdict}` : ""),
      ],
    };
  };
}
