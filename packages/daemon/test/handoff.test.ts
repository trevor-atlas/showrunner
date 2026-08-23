import { test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint, runDirFor } from "@showrunner/core";
import type { Envelope, Gate } from "@showrunner/core";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import {
  composePrompt,
  inputsDirFor,
  materializeHandoff,
  openDb,
  outputsDirFor,
  readAgentMap,
  resolveContext,
  runBlueprint,
  sessionDirNameForCwd,
  sessionIdFor,
  submitBlueprintRun,
} from "../src/index.ts";
import type { ScriptMap, ScriptedTurn } from "../src/index.ts";
import handoffFixture from "./fixtures/handoff/handoff-blueprint.ts";

/**
 * The §9 context & handoff filesystem protocol (T05) — proven end to end on
 * FakePi only (spec §17): no pi binary, no tokens. The round-trip fixture
 * (handoff-blueprint.ts) exercises every branch: the predecessor's envelope +
 * artifacts land in the next phase's inputs (§9.3), context entries resolve
 * literal / path / module-dir-fallback / §19 collision, the raw record lands
 * verbatim (§10), agent_map.json tracks visits, and the pi v3 session tree
 * appears under an overridden session dir without touching ~/.pi.
 */

const QualityEnvelope = EnvelopeBase.extend({ quality: z.number().min(0).max(10) });

function agent(name = "builder"): ReturnType<typeof defineAgent> {
  return defineAgent({
    name,
    model: "fake-pi",
    prompt: "execute the phase",
    tools: ["bash"],
    context: [],
  });
}

const qualityGate: Gate = async (envelope: Envelope) => {
  const quality = (envelope as unknown as { quality: number }).quality;
  return quality >= 7 ? { pass: true } : { pass: false, violations: [`quality ${quality} below 7`] };
};

const alwaysFailGate: Gate = async () => ({ pass: false, violations: ["always failing"] });

/** A single-turn scripted session whose agent settles and writes an envelope. */
function settledTurn(extra: Record<string, unknown> = {}): ScriptedTurn {
  return {
    events: [
      { type: "agent_start", messageCount: 0, model: "fake-pi" },
      { type: "queue_update", queued: 0 },
      { type: "turn_start" },
      { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_end", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_start", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "message_update", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] }, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.0002 } } },
      { type: "turn_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ],
    envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 7, ...extra },
  };
}

function session(turns: ScriptedTurn[]): { turns: ScriptedTurn[] } {
  return { turns };
}

function openEnv(label: string): { dir: string; db: ReturnType<typeof openDb>; cwd: string } {
  const dir = tmpDataDir(label);
  const db = openDb(join(dir, "showrunner.db"));
  const cwd = mkdtempSync(join(tmpdir(), "showrunner-handoff-cwd-"));
  return { dir, db, cwd };
}

function closeEnv(env: { dir: string; db: { close(): void }; cwd: string }): void {
  env.db.close();
  rmSync(env.cwd, { recursive: true, force: true });
  cleanupDir(env.dir);
}

// ── the round trip: envelope + artifacts materialize into the next phase ─────

test("§9 round-trip on FakePi: plan's accepted envelope + plan.md land in build's inputs", async () => {
  const env = openEnv("handoff-roundtrip");
  try {
    const modulePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "handoff", "handoff-blueprint.ts");
    const run = await submitBlueprintRun(env.db, env.dir, { modulePath, cwd: env.cwd });
    const result = await run.done;
    expect(result).toEqual({ status: "success", needs_review: false });

    // build's inputs: the predecessor's ACCEPTED envelope (plan's corrected turn)
    const handoffEnvelope = JSON.parse(
      readFileSync(join(inputsDirFor(env.cwd, "build"), "envelope.json"), "utf8"),
    ) as { summary: string; quality: number };
    expect(handoffEnvelope).toMatchObject({ summary: "plan complete", quality: 8 });

    // §9.3 zero-friction: the artifact plan listed (plan.md) is in build's inputs
    expect(readFileSync(join(inputsDirFor(env.cwd, "build"), "plan.md"), "utf8")).toContain(
      "1. Scaffold the handoff module.",
    );

    // plan's outputs keep the AGENT's files untouched (the daemon never writes outputs/)
    expect(readFileSync(join(outputsDirFor(env.cwd, "plan"), "plan.md"), "utf8")).toContain(
      "1. Scaffold the handoff module.",
    );

    // the first phase has no predecessor: inputs/ was never materialized for it
    expect(existsSync(join(inputsDirFor(env.cwd, "plan"), "envelope.json"))).toBe(false);
  } finally {
    closeEnv(env);
  }
});

// ── §9.2 context resolution: literal / path / collision / fallback / no globs ─

test("composePrompt [Context] renders literal, inlined-file, module-dir-fallback, and §19 collision entries in order", async () => {
  const env = openEnv("handoff-context");
  try {
    // cwd files for the cwd-resolve and collision branches (§9.2, §19)
    mkdirSync(join(env.cwd, "docs"), { recursive: true });
    writeFileSync(join(env.cwd, "docs", "context.md"), "CWD FILE: inlined from the run cwd.\n");
    writeFileSync(join(env.cwd, "quality.md"), "COLLISION: this file shadows the literal.\n");
    const moduleDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "handoff");

    const prompt = composePrompt(
      { blueprint: handoffFixture, cwd: env.cwd, moduleDir } as unknown as Parameters<typeof composePrompt>[0],
      handoffFixture.phases[0]!, // plan
      null,
    );
    const moduleNotes = readFileSync(join(moduleDir, "agent-notes.md"), "utf8");

    // each branch resolves exactly as §9.2/§19 prescribes, in agent order
    expect(prompt).toContain("Context literal: the plan must name the module, the slices, and the done criteria.");
    expect(prompt).toContain("CWD FILE: inlined from the run cwd."); // cwd file → inlined
    expect(prompt).toContain(moduleNotes); // module-dir fallback → inlined verbatim
    expect(prompt).toContain("COLLISION: this file shadows the literal."); // §19: file beats prose
    expect(prompt.indexOf("Context literal")).toBeLessThan(prompt.indexOf("CWD FILE:"));
    expect(prompt.indexOf("CWD FILE:")).toBeLessThan(prompt.indexOf("fallback-branch proof"));
    expect(prompt.indexOf("fallback-branch proof")).toBeLessThan(prompt.indexOf("COLLISION:"));
    // the resolved paths never leak into the prompt
    expect(prompt).not.toContain("docs/context.md");
    expect(prompt).not.toContain("quality.md");

    // build: agent defaults then phase additions; "*.md" stays literal (no globs)
    const buildPrompt = composePrompt(
      { blueprint: handoffFixture, cwd: env.cwd, moduleDir } as unknown as Parameters<typeof composePrompt>[0],
      handoffFixture.phases[1]!, // build
      null,
    );
    expect(buildPrompt).toContain("Build literal: ship the smallest thing that satisfies the plan.");
    expect(buildPrompt).toContain("Phase addition literal: prefer green CI over coverage.");
    expect(buildPrompt).toContain("*.md"); // a glob-looking literal is NOT expanded
    expect(buildPrompt.indexOf("Build literal")).toBeLessThan(buildPrompt.indexOf("Phase addition literal"));
  } finally {
    closeEnv(env);
  }
});

test("composePrompt inlines the materialized handoff inputs into [Context], naming each path (§8.2/§9.3)", () => {
  const env = openEnv("handoff-prompt-inputs");
  try {
    // mirror the run loop order: the predecessor's accepted envelope + artifacts
    // are materialized into build/inputs/ (§9.3) BEFORE the prompt is composed
    const planOutputs = outputsDirFor(env.cwd, "plan");
    mkdirSync(join(planOutputs, "sub"), { recursive: true });
    writeFileSync(join(planOutputs, "plan.md"), "# Plan\n1. Scaffold the handoff module.\n");
    writeFileSync(join(planOutputs, "sub", "nested.txt"), "nested artifact\n");
    const handoff = {
      envelope: { summary: "plan complete", artifacts: ["plan.md", "sub/nested.txt"], notes_for_next_agent: "n", quality: 8 },
      raw: JSON.stringify({ summary: "plan complete", artifacts: ["plan.md", "sub/nested.txt"], notes_for_next_agent: "n", quality: 8 }, null, 2) + "\n",
      fromPhase: "plan",
    };
    materializeHandoff(env.cwd, "build", handoff);

    const prompt = composePrompt(
      { blueprint: handoffFixture, cwd: env.cwd, moduleDir: null } as unknown as Parameters<typeof composePrompt>[0],
      handoffFixture.phases[1]!, // build — its predecessor's handoff is materialized
      handoff,
    );

    // (a) the inputs/ paths are named, not just outputs/envelope.json
    expect(prompt).toContain("context_handoff/build/inputs/envelope.json:");
    expect(prompt).toContain("context_handoff/build/inputs/plan.md:");
    expect(prompt).toContain("context_handoff/build/inputs/sub/nested.txt:");

    // (b) the materialized contents are inlined inside the [Context] section
    const ctx = prompt.indexOf("[Context]");
    const handoffSec = prompt.indexOf("[Handoff from previous phase]");
    expect(ctx).toBeGreaterThan(-1);
    expect(prompt.indexOf("context_handoff/build/inputs/envelope.json:")).toBeGreaterThan(ctx);
    expect(prompt.indexOf("context_handoff/build/inputs/envelope.json:")).toBeLessThan(handoffSec);
    expect(prompt).toContain('"quality": 8');
    expect(prompt).toContain("1. Scaffold the handoff module.");
    expect(prompt).toContain("nested artifact");

    // the §9.2 context entries still render, and the contract still names outputs
    expect(prompt).toContain("Build literal: ship the smallest thing that satisfies the plan.");
    expect(prompt).toContain("context_handoff/build/outputs/envelope.json");
  } finally {
    closeEnv(env);
  }
});

test("resolveContext: exact-path branches — absolute, cwd, module-dir, collision, literal, no-globs", () => {
  const env = openEnv("handoff-resolve");
  try {
    mkdirSync(join(env.cwd, "a"), { recursive: true });
    writeFileSync(join(env.cwd, "a", "notes.txt"), "from cwd\n");
    writeFileSync(join(env.cwd, "notes.txt"), "collision: cwd file wins over prose\n");
    const moduleDir = join(env.cwd, "module");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "fallback.txt"), "from module dir\n");

    const out = resolveContext(env.cwd, moduleDir, [
      "plain prose", // literal
      "a/notes.txt", // cwd resolve
      "fallback.txt", // module-dir fallback
      "notes.txt", // §19 collision: a literal that IS a real path → file
      join(env.cwd, "a", "notes.txt"), // absolute path
      "*.md", // no glob semantics: no file named "*.md" → literal
    ]);
    expect(out).toEqual([
      "plain prose",
      "from cwd\n",
      "from module dir\n",
      "collision: cwd file wins over prose\n",
      "from cwd\n",
      "*.md",
    ]);
  } finally {
    closeEnv(env);
  }
});

// ── §10 raw record: envelope.json verbatim + agent_map.json ──────────────────

test("raw record: runDir/envelope.json is the last accepted envelope verbatim; agent_map.json maps phases to sessions", async () => {
  const env = openEnv("handoff-raw");
  try {
    const modulePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "handoff", "handoff-blueprint.ts");
    const run = await submitBlueprintRun(env.db, env.dir, { modulePath, cwd: env.cwd });
    expect((await run.done).status).toBe("success");

    const runDir = runDirFor(env.dir, run.run_id);
    // verbatim: build's accepted envelope, byte-for-byte (the fake pretty-prints + newline)
    const expectedRaw =
      JSON.stringify(
        { summary: "built", artifacts: ["result.md"], notes_for_next_agent: "done", quality: 9 },
        null,
        2,
      ) + "\n";
    expect(readFileSync(join(runDir, "envelope.json"), "utf8")).toBe(expectedRaw);

    // agent_map: one entry per phase, derived ids per §8.1
    const map = readAgentMap(runDir);
    expect(Object.keys(map).sort()).toEqual(["build", "plan"]);
    expect(map.plan).toMatchObject({ visit: 1, model: "fake-pi" });
    expect(map.build).toMatchObject({ visit: 1, model: "fake-pi" });
    expect(map.plan!.pi_session_id).toBe(sessionIdFor(run.run_id, "plan", 1));
    expect(map.build!.pi_session_id).toBe(sessionIdFor(run.run_id, "build", 1));
    expect(map.plan!.pid).toBeTypeOf("number");
    expect(map.plan!.pid).toBeGreaterThan(0);

    // raw_output.jsonl: every scripted line, verbatim, with the session id injected
    const raw = readFileSync(join(runDir, "raw_output.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(30); // plan 2 turns × 10 events + build 1 turn × 10
    expect(lines.filter((l) => l.includes('"type":"agent_settled"'))).toHaveLength(3);
    expect(lines[0]).toBe(
      JSON.stringify({ type: "agent_start", messageCount: 0, model: "fake-pi", sessionId: sessionIdFor(run.run_id, "plan", 1) }),
    );
  } finally {
    closeEnv(env);
  }
});

test("agent_map.json tracks the LATEST visit per phase and stays fresh per run", async () => {
  const env = openEnv("handoff-map");
  try {
    const blueprint = defineBlueprint({
      name: "cycle",
      phases: [
        { name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1, on_fail: { to: "review" } },
        { name: "review", agent: agent("reviewer"), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1, on_fail: { to: "build" } },
      ],
    });
    const scripts: ScriptMap = {
      build: session([settledTurn(), settledTurn()]),
      review: session([settledTurn(), settledTurn()]),
    };
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts, maxVisits: 2 });
    expect((await run.done).status).toBe("paused"); // the visit guard fires

    const runDir = runDirFor(env.dir, run.run_id);
    const map = readAgentMap(runDir);
    // each phase was visited twice; the map holds the LATEST visit's session
    expect(map.build).toMatchObject({ visit: 2, model: "fake-pi" });
    expect(map.review).toMatchObject({ visit: 2, model: "fake-pi" });
    expect(map.build!.pi_session_id).toBe(sessionIdFor(run.run_id, "build", 2));
    expect(map.review!.pi_session_id).toBe(sessionIdFor(run.run_id, "review", 2));

    // a second run has its own run dir → its own fresh map (restart-fresh)
    const run2 = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts, maxVisits: 1 });
    expect((await run2.done).status).toBe("paused");
    const map2 = readAgentMap(runDirFor(env.dir, run2.run_id));
    expect(map2.build).toBeDefined();
    expect(map2.build!.visit).toBe(1); // fresh run, first visit
    expect(readAgentMap(runDir).build!.visit).toBe(2); // run 1's map untouched
  } finally {
    closeEnv(env);
  }
});

// ── materializeHandoff edge cases (adversarial) ──────────────────────────────

test("materializeHandoff: nested artifacts keep their path; missing + traversal artifacts are skipped", () => {
  const env = openEnv("handoff-materialize");
  try {
    // the "predecessor's outputs" — artifacts resolve relative to these
    const fromOutputs = outputsDirFor(env.cwd, "plan");
    mkdirSync(join(fromOutputs, "sub"), { recursive: true });
    writeFileSync(join(fromOutputs, "flat.txt"), "flat\n");
    writeFileSync(join(fromOutputs, "sub", "nested.txt"), "nested\n");

    const handoff = {
      envelope: {
        summary: "s",
        artifacts: ["flat.txt", "sub/nested.txt", "missing.txt", "../escape.txt", "/etc/hostname"],
        notes_for_next_agent: "n",
        quality: 9,
      },
      raw: "{\"quality\":9}\n",
      fromPhase: "plan",
    };
    materializeHandoff(env.cwd, "build", handoff);

    const inputs = inputsDirFor(env.cwd, "build");
    expect(readFileSync(join(inputs, "envelope.json"), "utf8")).toBe("{\"quality\":9}\n");
    expect(readFileSync(join(inputs, "flat.txt"), "utf8")).toBe("flat\n");
    expect(readFileSync(join(inputs, "sub", "nested.txt"), "utf8")).toBe("nested\n");
    // missing + path-traversal artifacts are skipped, never read outside outputs/
    expect(existsSync(join(inputs, "missing.txt"))).toBe(false);
    expect(existsSync(join(inputs, "escape.txt"))).toBe(false);
    expect(existsSync(join(inputs, "hostname"))).toBe(false);

    // the first phase (null handoff) materializes nothing
    materializeHandoff(env.cwd, "plan", null);
    expect(existsSync(inputsDirFor(env.cwd, "plan"))).toBe(false);
  } finally {
    closeEnv(env);
  }
});

// ── the pi v3 session tree (hermetic, no ~/.pi pollution) ────────────────────

test("sessionDirNameForCwd matches pi's verified sanitization (§8.1 v3 layout)", () => {
  expect(sessionDirNameForCwd("/Users/me/my repo/proj")).toBe("--Users-me-my repo-proj--");
  expect(sessionDirNameForCwd("/a/b:c")).toBe("--a-b-c--");
  expect(sessionDirNameForCwd("/a/b\\c")).toBe("--a-b-c--");
});

test("a fake session writes its v3 session file under the overridden session dir; run records coexist", async () => {
  const env = openEnv("handoff-session");
  const sessionRoot = tmpDataDir("handoff-sessions");
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionRoot;
  try {
    const blueprint = defineBlueprint({
      name: "session",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
    });
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts: { build: session([settledTurn()]) } });
    expect((await run.done).status).toBe("success");

    // v3 tree: <sessionDir>/--<sanitized-cwd>--/<ts>_<sessionId>.jsonl. The
    // child's cwd is the symlink-resolved path (macOS /var → /private/var), the
    // same resolution real pi applies — mirror it for the expected directory.
    const resolvedCwd = realpathSync(env.cwd);
    const sessionSubdir = join(sessionRoot, sessionDirNameForCwd(resolvedCwd));
    const files = readdirSync(sessionSubdir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const piSessionId = sessionIdFor(run.run_id, "build", 1);
    expect(files[0]!.endsWith(`_${piSessionId}.jsonl`)).toBe(true);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?Z_.+\.jsonl$/);
    expect(readFileSync(join(sessionSubdir, files[0]!), "utf8")).toContain('"sessionId"');

    // the daemon does not fight pi's tree: the run's own raw record coexists
    expect(existsSync(join(runDirFor(env.dir, run.run_id), "raw_output.jsonl"))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    cleanupDir(sessionRoot);
    closeEnv(env);
  }
});
