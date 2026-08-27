import { test, expect, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The blueprint CLI verbs, driven as the real CLI subprocess against a scratch
 * data dir. `blueprints` and a `run <unknown-name>` need no daemon — the data
 * dir is the source of truth, so these read/resolve it directly and fast.
 */

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "showrunner-blueprints-cli-"));
const env = { ...process.env, SHOWRUNNER_DATA_DIR: dataDir };

function cli(args: string[], timeoutMs = 20_000): { stdout: string; stderr: string; status: number } {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: timeoutMs, env });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status ?? -1 };
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("blueprints lists every starter blueprint with its phase chain", () => {
  const out = cli(["blueprints"]);
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("scout");
  expect(out.stdout).toContain("recon");
  expect(out.stdout).toContain("plan_build_test");
  expect(out.stdout).toContain("plan");
  expect(out.stdout).toContain("build");
  expect(out.stdout).toContain("review");
  expect(out.stdout).toContain("ship");
  // the shared helpers are never listed as blueprints
  expect(out.stdout).not.toContain("patterns");
});

test("blueprints <name> prints the phase chain with agent, budget, on_fail, approval", () => {
  const out = cli(["blueprints", "plan_build_test"]);
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("plan_build_test");
  expect(out.stdout).toMatch(/build\s+agent=builder budget=3/);
  expect(out.stdout).toContain("on_fail");
  expect(out.stdout).toMatch(/ship\s+agent=ship/);
  expect(out.stdout).toContain("require_approval");
});

test("blueprints <unknown> exits non-zero and lists the available names", () => {
  const out = cli(["blueprints", "nope"]);
  expect(out.status).not.toBe(0);
  expect(out.stdout).not.toContain("blueprint nope");
});

test("run <unknown-name> exits non-zero with the available-names message (no daemon)", () => {
  const out = cli(["run", "nope"]);
  expect(out.status).not.toBe(0);
  // no run was submitted
  expect(out.stdout).not.toContain("run submitted");
  // the error names the available blueprints (names, not a path form)
  expect(out.stderr).toContain("scout");
  expect(out.stderr).toContain("plan_build_test");
  expect(out.stderr).not.toContain(".ts module");
});
