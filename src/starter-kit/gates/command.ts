import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Gate } from "../../core/index.ts";
import { findUp, nearestScripts, shq, tail, violation, workspaceShell } from "./shared.ts";

// ── command-gate target resolution (FINDING-2) ───────────────────────────────

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
