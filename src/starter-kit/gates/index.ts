import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Gate, GateContext, GateResult } from "../../core/index.ts";
import { createShell } from "../../core/index.ts";

/**
 * Shared gates library. Each export is a curried gate
 * factory: `testsPass()` returns a Gate you drop into a phase's `gates` array.
 * Gates are workspace-aware via ctx (cwd, phase, visit) and use `ctx.shell()`
 * where a command must run — falling back to core's `createShell` when the
 * runtime does not provide one.
 *
 * Replace-this: the defaults (test command, lint command, plan-file naming)
 * describe the demo project. Override them per phase or edit this file — that
 * is the point.
 */

/** The workspace layout is a spec fact; the daemon hands the gate its
 * phase's inputs/outputs dirs via the context. These helpers make the
 * starter gates read them through one place. */
export function inputsDirFor(ctx: GateContext): string {
  return ctx.inputs_dir ?? "";
}

/** The outputs dir — where this phase's agent wrote its files. */
export function outputsDirFor(ctx: GateContext): string {
  return ctx.outputs_dir ?? "";
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

// ── command-gate target resolution (FINDING-2) ───────────────────────────────

/** Single-quote a shell token (paths can contain spaces). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Walk up from cwd looking for a file; returns the nearest hit's full path. */
function findUp(cwd: string, name: string): string | null {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The nearest package.json's script map ({} when none exists). */
function nearestScripts(cwd: string): { pkgPath: string | null; scripts: Record<string, string> } {
  const pkg = findUp(cwd, "package.json");
  if (pkg === null) return { pkgPath: null, scripts: {} };
  try {
    const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> };
    return { pkgPath: pkg, scripts: parsed.scripts ?? {} };
  } catch {
    return { pkgPath: pkg, scripts: {} };
  }
}

/** Test files under cwd (project subtree; node_modules/.git/build excluded). */
function findTestFiles(root: string, limit = 2_000): string[] {
  const found: string[] = [];
  const stack = [root];
  let scanned = 0;
  while (stack.length > 0 && scanned < limit) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      scanned += 1;
      if (scanned > limit) break;
      if (name === "node_modules" || name === ".git" || name === "build" || name === "dist" || name === ".hg") continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (/[._-](test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(name)) {
        found.push(full);
      }
    }
  }
  return found;
}

/** The lint/typecheck resolution the gate runs when no `command` override is given. */
function resolveLintCommand(cwd: string): { cmd: string; source: string } | null {
  // 1. the nearest tsconfig.json UP from the run cwd — typecheck that project
  const tsconfig = findUp(cwd, "tsconfig.json");
  if (tsconfig !== null) return { cmd: `bunx tsc -p ${shq(tsconfig)} --noEmit`, source: tsconfig };
  // 2. otherwise the nearest package.json's "typecheck" script (monorepo roots
  //    often have one instead of a root tsconfig)
  const { pkgPath, scripts } = nearestScripts(cwd);
  if (pkgPath !== null && typeof scripts.typecheck === "string" && scripts.typecheck !== "") {
    return { cmd: "bun run typecheck", source: `${pkgPath} ("typecheck" script)` };
  }
  return null;
}

/** The test resolution the gate runs when no `command` override is given. */
function resolveTestCommand(cwd: string): { cmd: string; source: string } | null {
  // 1. the nearest package.json's "test" script (the project's own runner)
  const { pkgPath, scripts } = nearestScripts(cwd);
  if (pkgPath !== null && typeof scripts.test === "string" && scripts.test !== "") {
    return { cmd: "bun run test", source: `${pkgPath} ("test" script)` };
  }
  // 2. otherwise any test files under the run cwd → bun's auto-discovery
  if (findTestFiles(cwd).length > 0) {
    return { cmd: "bun test", source: `test files under ${cwd}` };
  }
  return null;
}

// ── command gates ────────────────────────────────────────────────────────────

export interface CommandGateOptions {
  /** the command to run in the workspace (default per gate) */
  command?: string;
}

/**
 * testsPass — the test suite must be green. Runs the phase's test command in
 * the workspace; a non-zero exit (or a command crash) is a violation with the
 * output tail attached.
 *
 * Default resolution (FINDING-2 — replace-this friendly): an explicit
 * `testsPass({ command })` wins; otherwise the nearest package.json UP from
 * the run cwd with a "test" script runs as `bun run test`; otherwise any
 * `*.test.ts` / `*.spec.ts` files under the run cwd run as `bun test` (bun's
 * auto-discovery); otherwise the gate FAILS LOUDLY — "no test target" — so a
 * project without a suite can never silently pass (nor fail with an opaque
 * `bun test` exit-1).
 */
export function testsPass(opts: CommandGateOptions = {}): Gate {
  const command = opts.command;
  return async function testsPass(envelope, ctx) {
    let cmd: string;
    let source: string;
    if (command !== undefined && command !== "") {
      cmd = command;
      source = `command "${command}"`;
    } else {
      const resolved = resolveTestCommand(ctx.cwd);
      if (resolved === null) {
        return violation(
          "no test target",
          `no test suite found at ${ctx.cwd} or any ancestor (no "test" script in the nearest package.json, no *.test.ts/*.spec.ts files under the workspace) — expected one of them, or configure the gate explicitly: testsPass({ command: \"bun test test/\" })`,
        );
      }
      cmd = resolved.cmd;
      source = resolved.source;
    }
    const res = await workspaceShell(ctx, cmd);
    if (res.code === 0) return { pass: true };
    return violation(`tests failed (exit ${res.code})`, `${tail(res.stderr || res.stdout || "no output")} (${source})`);
  };
}

/**
 * lintClean — the linter/typecheck must be clean. Runs the phase's lint
 * command in the workspace; a non-zero exit is a violation with the output
 * tail attached.
 *
 * Default resolution (FINDING-2 — replace-this friendly): an explicit
 * `lintClean({ command })` wins; otherwise an explicit `lintClean({ tsconfig })`;
 * otherwise the nearest tsconfig.json UP from the run cwd runs as
 * `bunx tsc -p <tsconfig> --noEmit`; otherwise the nearest package.json's
 * "typecheck" script runs as `bun run typecheck` (monorepo roots usually have
 * one instead of a root tsconfig); otherwise the gate FAILS LOUDLY —
 * "no tsconfig found at <path>" — instead of the opaque bare `tsc` exit-1.
 */
export function lintClean(opts: CommandGateOptions & { tsconfig?: string } = {}): Gate {
  const command = opts.command;
  const tsconfig = opts.tsconfig;
  return async function lintClean(envelope, ctx) {
    let cmd: string;
    let source: string;
    if (command !== undefined && command !== "") {
      cmd = command;
      source = `command "${command}"`;
    } else if (tsconfig !== undefined && tsconfig !== "") {
      cmd = `bunx tsc -p ${shq(tsconfig)} --noEmit`;
      source = `tsconfig ${tsconfig}`;
    } else {
      const resolved = resolveLintCommand(ctx.cwd);
      if (resolved === null) {
        return violation(
          "no tsconfig found",
          `no tsconfig.json found at ${ctx.cwd} or any ancestor (and no \"typecheck\" script in the nearest package.json) — expected a tsconfig.json (the nearest one up from the run cwd is used), or configure the gate explicitly: lintClean({ tsconfig: \"…\" }) / lintClean({ command: \"bun run lint\" })`,
        );
      }
      cmd = resolved.cmd;
      source = resolved.source;
    }
    const res = await workspaceShell(ctx, cmd);
    if (res.code === 0) return { pass: true };
    return violation(`lint/typecheck failed (exit ${res.code})`, `${tail(res.stderr || res.stdout || "no output")} (${source})`);
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
  return async function matchesPlan(envelope, ctx) {
    const inputs = inputsDirFor(ctx);
    if (inputs === "") {
      return violation("no inputs dir", "the daemon did not provide ctx.inputs_dir — cannot verify the phase was handed a plan");
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
  };
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
  return async function findingsReported(envelope, ctx) {
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
 * path must appear in envelope.artifacts (and exist in the phase's outputs
 * dir). With no paths, the envelope must carry at least one artifact — the
 * phase must have produced something, not just prose.
 */
export function filesExist(opts: FilesExistOptions = {}): Gate {
  const required = opts.paths ?? [];
  const requireAny = opts.requireAny ?? required.length === 0;
  return async function filesExist(envelope, ctx) {
    const out = outputsDirFor(ctx);
    const violations: string[] = [];
    if (requireAny && envelope.artifacts.length === 0) {
      violations.push("envelope lists no artifacts — the phase must produce at least one file");
    }
    for (const rel of required) {
      if (!envelope.artifacts.includes(rel)) {
        violations.push(`artifact "${rel}" is missing from envelope.artifacts`);
        continue;
      }
      if (out === "") {
        violations.push(`cannot verify artifact "${rel}" — the daemon did not provide ctx.outputs_dir`);
        continue;
      }
      const full = join(out, rel);
      if (!existsSync(full)) violations.push(`artifact "${rel}" does not exist in your outputs directory (${out})`);
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
