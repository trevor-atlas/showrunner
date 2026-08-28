import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { EnvelopeBase } from "../../src/core/index.ts";
import type { Envelope, GateContext } from "../../src/core/index.ts";
import type { ReviewEnvelope } from "../../src/starter-kit/envelopes.ts";

import { envelopeShape, filesExist, lintClean, matchesPlan, reviewApproved, testsPass, workspaceShell } from "../../src/starter-kit/gates/index.ts";
import { failingWorkspace, passingWorkspace, rmDir, tmpDir, writeWorkspace } from "./helpers.ts";

/**
 * Gate unit tests — the shared gates library proven against real
 * commands in scratch workspaces and pure envelope inputs. STARTER tests:
 * replaceable by design (the fixtures-vs-smokes doctrine).
 */

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmDir(d);
});

function baseEnvelope(extra: Record<string, unknown> = {}): Envelope {
  return { summary: "s", artifacts: [], notes_for_next_agent: "n", ...extra } as Envelope;
}

function violationsOf(r: { pass: boolean; violations?: string[] }): string[] {
  return r.pass ? [] : (r.violations ?? []);
}

function ctx(cwd: string, phase = "build", overrides: Partial<GateContext> = {}): GateContext {
  return { run_id: "r", cwd, phase, visit: 1, ...overrides };
}

// ── command gates (real subprocesses, scratch workspaces) ────────────────────

test("testsPass passes when the suite is green and fails with the output tail when red", async () => {
  const green = tmpDir("gates-tests-pass");
  const red = tmpDir("gates-tests-fail");
  cleanups.push(green, red);
  passingWorkspace(green);
  failingWorkspace(red);

  const pass = await testsPass()(baseEnvelope(), ctx(green));
  expect(pass).toEqual({ pass: true });

  const fail = await testsPass()(baseEnvelope(), ctx(red));
  expect(fail.pass).toBe(false);
  expect(violationsOf(fail)[0]).toContain("tests failed");
});

test("lintClean passes when the typecheck is clean and fails with a type error", async () => {
  const clean = tmpDir("gates-lint-clean");
  const dirty = tmpDir("gates-lint-dirty");
  cleanups.push(clean, dirty);
  passingWorkspace(clean);
  // a deliberate type error on top of a valid project — tsc must exit non-zero
  passingWorkspace(dirty);
  writeWorkspace(dirty, {
    "src/boom.ts": "const n: number = \"not a number\";\nexport default n;\n",
  });

  const pass = await lintClean()(baseEnvelope(), ctx(clean));
  expect(pass).toEqual({ pass: true });

  const fail = await lintClean()(baseEnvelope(), ctx(dirty));
  expect(fail.pass).toBe(false);
  expect(violationsOf(fail)[0]).toContain("lint/typecheck failed");
});

test("FINDING-2: lintClean fails loudly when no tsconfig/typecheck target exists, and names the resolution", async () => {
  const empty = tmpDir("gates-lint-empty");
  cleanups.push(empty);

  const noTarget = await lintClean()(baseEnvelope(), ctx(empty));
  expect(noTarget.pass).toBe(false);
  const msg = violationsOf(noTarget)[0]!;
  expect(msg).toContain("no tsconfig found");
  expect(msg).toContain(empty); // the checked path is named — no opaque exit-1
  expect(msg).toContain("typecheck");

  // a package.json "typecheck" script (no tsconfig anywhere) is a valid target
  const scripted = tmpDir("gates-lint-script");
  cleanups.push(scripted);
  writeWorkspace(scripted, {
    "package.json": JSON.stringify({ name: "scripted", scripts: { typecheck: "echo typecheck-ok" } }),
  });
  const viaScript = await lintClean()(baseEnvelope(), ctx(scripted));
  expect(viaScript).toEqual({ pass: true });
});

test("FINDING-2: lintClean finds the NEAREST tsconfig up from the run cwd and honors the explicit tsconfig option", async () => {
  const ws = tmpDir("gates-lint-up");
  cleanups.push(ws);
  passingWorkspace(ws); // ws/tsconfig.json + src + node_modules symlink
  writeWorkspace(ws, { "sub/deep/.keep": "" });

  // the run cwd is a subdirectory — the gate walks UP to the project tsconfig
  const viaWalkUp = await lintClean()(baseEnvelope(), ctx(join(ws, "sub", "deep")));
  expect(viaWalkUp).toEqual({ pass: true });

  // an explicit tsconfig wins over the walk-up
  const boom = tmpDir("gates-lint-explicit");
  cleanups.push(boom);
  passingWorkspace(boom);
  writeWorkspace(boom, { "src/boom.ts": "const n: number = \"not a number\";\nexport default n;\n" });
  const viaOption = await lintClean({ tsconfig: join(boom, "tsconfig.json") })(baseEnvelope(), ctx(boom));
  expect(viaOption.pass).toBe(false);
  expect(violationsOf(viaOption)[0]).toContain("lint/typecheck failed");

  // an explicit command wins over everything
  const viaCommand = await lintClean({ command: "echo lint-cmd" })(baseEnvelope(), ctx(boom));
  expect(viaCommand).toEqual({ pass: true });
});

test("FINDING-2: testsPass fails loudly without a suite, and resolves test script / test files", async () => {
  // no suite anywhere → a clear violation, not an opaque `bun test` exit-1
  const empty = tmpDir("gates-tests-empty");
  cleanups.push(empty);
  const noTarget = await testsPass()(baseEnvelope(), ctx(empty));
  expect(noTarget.pass).toBe(false);
  const msg = violationsOf(noTarget)[0]!;
  expect(msg).toContain("no test target");
  expect(msg).toContain(empty);

  // only test files (no package.json) → bun's auto-discovery
  const files = tmpDir("gates-tests-files");
  cleanups.push(files);
  writeWorkspace(files, {
    "test/trivial.test.ts": 'import { test, expect } from "bun:test";\ntest("green", () => expect(1).toBe(1));\n',
  });
  const viaFiles = await testsPass()(baseEnvelope(), ctx(files));
  expect(viaFiles).toEqual({ pass: true });

  // a package.json "test" script is the project's own runner
  const scripted = tmpDir("gates-tests-script");
  cleanups.push(scripted);
  writeWorkspace(scripted, {
    "package.json": JSON.stringify({ name: "scripted", scripts: { test: "echo tests-ok" } }),
  });
  const viaScript = await testsPass()(baseEnvelope(), ctx(scripted));
  expect(viaScript).toEqual({ pass: true });

  // an explicit command wins over the resolution
  const viaCommand = await testsPass({ command: "echo tests-cmd" })(baseEnvelope(), ctx(empty));
  expect(viaCommand).toEqual({ pass: true });
});

test("workspaceShell honors ctx.shell when provided and falls back to a real subprocess otherwise", async () => {
  const cwd = tmpDir("gates-shell");
  cleanups.push(cwd);
  // fallback path (the v1 daemon passes no ctx.shell): a real command runs
  const viaFallback = await workspaceShell(ctx(cwd), "printf 'hello'");
  expect(viaFallback).toMatchObject({ code: 0, stdout: "hello" });

  // ctx.shell wins when the runtime provides it
  let sawCtx = false;
  const viaCtx = await workspaceShell(ctx(cwd, "build", { shell: async () => { sawCtx = true; return { code: 0, stdout: "", stderr: "" }; } }), "anything");
  expect(viaCtx.code).toBe(0);
  expect(sawCtx).toBe(true);
});

// ── envelope gates ───────────────────────────────────────────────────────────

test("envelopeShape passes a conforming envelope and lists violations for a non-conforming one", async () => {
  const schema = EnvelopeBase.extend({ quality: z.number().min(0).max(10) });
  const gate = envelopeShape(schema);

  const pass = await gate(baseEnvelope({ quality: 9 }), ctx("/tmp"));
  expect(pass).toEqual({ pass: true });

  const fail = await gate(baseEnvelope({ quality: 11 }), ctx("/tmp"));
  expect(fail.pass).toBe(false);
  expect(violationsOf(fail).join("; ")).toContain("quality");
});

test("matchesPlan fails loudly when no plan arrived, and passes only when the envelope references it", async () => {
  const cwd = tmpDir("gates-matches-plan");
  const runDir = tmpDir("gates-matches-plan-run");
  cleanups.push(cwd, runDir);
  const inputs = join(runDir, "build", "inputs");

  // no ctx.inputs_dir → hard fail with a hint
  const noCtx = await matchesPlan()(baseEnvelope(), ctx(cwd));
  expect(noCtx.pass).toBe(false);
  expect(violationsOf(noCtx)[0]).toContain("no inputs dir");

  // inputs dir named but never materialized → fail
  const noInputs = await matchesPlan()(baseEnvelope(), ctx(cwd, "build", { inputs_dir: inputs }));
  expect(noInputs.pass).toBe(false);
  expect(violationsOf(noInputs)[0]).toContain("no plan");

  // inputs exist but no plan file → fail
  writeWorkspace(runDir, { "build/inputs/notes.txt": "not a plan\n" });
  const noPlan = await matchesPlan()(baseEnvelope(), ctx(cwd, "build", { inputs_dir: inputs }));
  expect(noPlan.pass).toBe(false);
  expect(violationsOf(noPlan)[0]).toContain("no plan");

  // plan file present but the envelope never names it → fail
  writeWorkspace(runDir, { "build/inputs/plan.md": "# Plan\n" });
  const notReferenced = await matchesPlan()(baseEnvelope({ artifacts: [] }), ctx(cwd, "build", { inputs_dir: inputs }));
  expect(notReferenced.pass).toBe(false);
  expect(violationsOf(notReferenced)[0]).toContain("plan.md");

  // envelope names the plan in artifacts → pass
  const referenced = await matchesPlan()(baseEnvelope({ artifacts: ["plan.md"] }), ctx(cwd, "build", { inputs_dir: inputs }));
  expect(referenced).toEqual({ pass: true });

  // an explicit planFile option names a different file
  const explicit = await matchesPlan({ planFile: "docs/roadmap.md" })(baseEnvelope({ artifacts: [] }), ctx(cwd, "build", { inputs_dir: inputs }));
  expect(explicit.pass).toBe(false);
  expect(violationsOf(explicit)[0]).toContain("roadmap.md");
});

test("filesExist requires at least one artifact by default, and exact paths when asked", async () => {
  const cwd = tmpDir("gates-files-exist");
  const runDir = tmpDir("gates-files-exist-run");
  cleanups.push(cwd, runDir);
  const outputs = join(runDir, "build", "outputs");

  const empty = await filesExist()(baseEnvelope({ artifacts: [] }), ctx(cwd, "build", { outputs_dir: outputs }));
  expect(empty.pass).toBe(false);
  expect(violationsOf(empty)[0]).toContain("artifacts");

  const any = await filesExist()(baseEnvelope({ artifacts: ["docs/x.md"] }), ctx(cwd, "build", { outputs_dir: outputs }));
  expect(any).toEqual({ pass: true });

  const missing = await filesExist({ paths: ["docs/x.md"] })(baseEnvelope({ artifacts: [] }), ctx(cwd, "build", { outputs_dir: outputs }));
  expect(missing.pass).toBe(false);
  expect(violationsOf(missing)[0]).toContain("docs/x.md");

  // listed artifact exists in the phase's outputs dir → pass
  writeWorkspace(runDir, { "build/outputs/docs/x.md": "hi" });
  const withFile = await filesExist({ paths: ["docs/x.md"] })(baseEnvelope({ artifacts: ["docs/x.md"] }), ctx(cwd, "build", { outputs_dir: outputs }));
  expect(withFile).toEqual({ pass: true });
});

test("reviewApproved passes an approved review and reports the verdict when rejected", async () => {
  const approved = await reviewApproved()(baseEnvelope({ approved: true }) as ReviewEnvelope, ctx("/tmp"));
  expect(approved).toEqual({ pass: true });

  const rejected = await reviewApproved()(baseEnvelope({ approved: false, verdict: "scope creep" }) as ReviewEnvelope, ctx("/tmp"));
  expect(rejected.pass).toBe(false);
  expect(violationsOf(rejected)[0]).toContain("scope creep");

  const missing = await reviewApproved()(baseEnvelope() as ReviewEnvelope, ctx("/tmp"));
  expect(missing.pass).toBe(false);
  expect(violationsOf(missing)[0]).toContain("approved");
});
