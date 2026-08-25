import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GateContext, GateResult } from "../../core/index.ts";
import { createShell } from "../../core/index.ts";

/**
 * Shared helpers for the gate library. Each gate family module imports the
 * pieces it needs from here so the individual factories stay focused.
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

export function violation(label: string, detail: string): GateResult {
  return { pass: false, violations: [detail.trim() ? `${label}: ${detail.trim()}` : label] };
}

/** tail helper for keeping violation messages bounded */
export function tail(s: string, n = 20): string {
  const lines = s.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= n) return s;
  return `... (${lines.length - n} lines omitted)\n${lines.slice(-n).join("\n")}`;
}

/** Single-quote a shell token (paths can contain spaces). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Walk up from cwd looking for a file; returns the nearest hit's full path. */
export function findUp(cwd: string, name: string): string | null {
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
export function nearestScripts(cwd: string): { pkgPath: string | null; scripts: Record<string, string> } {
  const pkg = findUp(cwd, "package.json");
  if (pkg === null) return { pkgPath: null, scripts: {} };
  try {
    const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> };
    return { pkgPath: pkg, scripts: parsed.scripts ?? {} };
  } catch {
    return { pkgPath: pkg, scripts: {} };
  }
}
