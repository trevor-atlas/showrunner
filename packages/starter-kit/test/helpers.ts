import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlueprintRun, RunResult } from "../../daemon/src/runner.ts";
import { getControl } from "../../daemon/src/index.ts";

/**
 * Scratch helpers for the starter-kit tests (spec §17 fixtures-vs-smokes
 * doctrine): every test builds its own scratch dirs under the OS tmpdir and
 * removes them on teardown — no residue in the repo root.
 *
 * Note: the daemon is imported RELATIVELY, not as a package dep — bun 1.4
 * cannot resolve a `file:` dep's own `file:` deps, so the starter kit (like
 * the CLI) does not declare @showrunner/daemon (see cli/daemon-lifecycle.ts).
 */

export function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-starter-${label}-`));
}

export function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Where the repo's node_modules lives (for hermetic bunx/tsc resolution). */
export const repoNodeModules = join(import.meta.dir, "..", "..", "..", "node_modules");

export interface WorkspaceFiles {
  [rel: string]: string;
}

export function writeWorkspace(dir: string, files: WorkspaceFiles): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}

/** A workspace whose `bun test` is green and whose typecheck is clean. */
export function passingWorkspace(dir: string): void {
  // node_modules → repo root: lets bunx resolve tsc and tsc resolve bun-types
  symlinkSync(repoNodeModules, join(dir, "node_modules"), "dir");
  writeWorkspace(dir, {
    "package.json": JSON.stringify({ name: "starter-fixture", type: "module" }, null, 2),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: true,
          types: ["bun-types"],
        },
      },
      null,
      2,
    ),
    "src/index.ts": "export const version = 1;\n",
    "test/trivial.test.ts": 'import { test, expect } from "bun:test";\ntest("starts green", () => expect(1).toBe(1));\n',
  });
}

/** A workspace whose `bun test` is red (the testsPass gate must fail). */
export function failingWorkspace(dir: string): void {
  passingWorkspace(dir);
  writeWorkspace(dir, {
    "test/red.test.ts": 'import { test, expect } from "bun:test";\ntest("is red", () => expect(1).toBe(2));\n',
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** race a promise against a timeout — null when the timeout wins */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, sleep(ms).then(() => null)]);
}

/**
 * Drive a run to its terminal state, approving every require_approval pause
 * along the way (the fixture plays the human). Returns the terminal result.
 */
export async function runToTerminal(run: BlueprintRun, timeoutMs = 15_000): Promise<RunResult> {
  const first = await run.done;
  if (first.status !== "paused") return first;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const control = getControl(run.run_id);
    if (control && control.paused) control.approve("fixture");
    const terminal = await withTimeout(run.terminal, 25);
    if (terminal) return terminal;
    if (Date.now() > deadline) throw new Error(`run ${run.run_id} did not reach terminal in ${timeoutMs}ms`);
    await sleep(10);
  }
}
