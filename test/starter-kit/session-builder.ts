/**
 * Scripted FakePi session builders (spec §17) — the deterministic, no-pi,
 * no-token stand-ins the starter-kit fixtures drive blueprints with. The same
 * builders generate the on-disk sessions under src/starter-kit/blueprints/fake-pi/ (the
 * CLI path) via scripts/generate-fake-pi-sessions.ts, so the two stay in sync.
 *
 * These are STARTER fixtures (the replace-this doctrine, spec §17): they are
 * the tests the kit ships, not the user's tests.
 */
import type { ScriptedSession, ScriptedTurn } from "../../src/daemon/runner.ts";

export interface TurnOptions {
  model?: string;
  /** include a realistic bash tool call in the turn's events */
  includeTool?: boolean;
  usage?: { input?: number; output?: number; cost?: number };
}

/** Base envelope fields every starter envelope extends (spec §3.2). */
export function baseEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "Starter turn summary.",
    artifacts: [],
    notes_for_next_agent: "Starter handoff.",
    ...extra,
  };
}

/**
 * One scripted turn: a full event stream ending in agent_settled, plus the
 * envelope the fake "writes" to envelope.json. Mirrors the raw event shapes
 * the daemon's own fixtures use (verified §7.1 shapes).
 */
export function turn(envelope: Record<string, unknown>, opts: TurnOptions = {}): ScriptedTurn {
  const model = opts.model ?? "fake-pi";
  const events: Record<string, unknown>[] = [
    { type: "agent_start", messageCount: 0, model },
    { type: "queue_update", queued: 0 },
    { type: "turn_start" },
    { type: "message_start", message: { id: "u1", role: "user", content: [{ type: "text", text: "go" }] } },
    { type: "message_end", message: { id: "u1", role: "user", content: [{ type: "text", text: "go" }] } },
    { type: "message_start", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "working" }] } },
    {
      type: "message_update",
      message: { id: "a1", role: "assistant", content: [{ type: "text", text: "working" }] },
      usage: {
        input: opts.usage?.input ?? 100,
        output: opts.usage?.output ?? 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: (opts.usage?.input ?? 100) + (opts.usage?.output ?? 20),
        ...(opts.usage?.cost !== undefined ? { cost: { total: opts.usage.cost } } : {}),
      },
    },
  ];
  if (opts.includeTool !== false) {
    events.push(
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: "ls" },
      { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "ok\n" }] } },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "ok\n" }] }, isError: false },
    );
  }
  events.push(
    { type: "message_end", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "working" }] } },
    { type: "turn_end", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "working" }] } },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  );
  return { events, envelope };
}

export function session(turns: ScriptedTurn[]): ScriptedSession {
  return { turns };
}

// ── per-agent envelopes (the starter schemas, §15) ───────────────────────────

/** prompt blueprint — EnvelopeBase, nothing extra. */
export function promptTurn(): ScriptedTurn {
  return turn(baseEnvelope({ summary: "Planner considered the goal." }));
}

/** scout — ScoutEnvelope: findings required. */
export function reconTurn(): ScriptedTurn {
  return turn(
    baseEnvelope({
      summary: "Recon done.",
      findings: ["src/index.ts is the entry point", "no tests exist yet"],
      touched: ["src/index.ts"],
    }),
  );
}

/** plan — PlanEnvelope: plan_path required; the plan file lands in outputs. */
export function planTurn(): ScriptedTurn {
  return {
    ...turn(
      baseEnvelope({
        summary: "Wrote the plan.",
        artifacts: ["plan.md"],
        notes_for_next_agent: "Follow plan.md; the first step is scaffolding.",
        plan_path: "plan.md",
        scope: "a demo feature",
        questions: [],
        assumptions: ["workspace is a bun project"],
      }),
    ),
    artifacts: { "plan.md": "# Plan\n\n1. Scaffold the feature.\n2. Implement it.\n3. Verify with tests.\n" },
  };
}

/** build — BuildEnvelope: changed required; references the plan (matchesPlan). */
export function buildTurn(overrides: Record<string, unknown> = {}): ScriptedTurn {
  return turn(
    baseEnvelope({
      summary: "Implemented the plan.",
      artifacts: ["plan.md"],
      notes_for_next_agent: "Built per plan.md; see changed files.",
      changed: ["src/feature.ts"],
      ...overrides,
    }),
  );
}

/** a build envelope that violates BuildEnvelope (missing `changed`) */
export function badBuildTurn(): ScriptedTurn {
  return turn(baseEnvelope({ summary: "Built something but reported no changed files." }));
}

/** review — ReviewEnvelope: approved + verdict required. */
export function reviewTurn(approved: boolean, verdict = approved ? "Approved." : "Not ready.", issues: string[] = []): ScriptedTurn {
  return turn(
    baseEnvelope({
      summary: `Review: ${verdict}`,
      artifacts: [],
      notes_for_next_agent: verdict,
      approved,
      verdict,
      issues,
    }),
  );
}

/** document — DocumentEnvelope: doc_paths required; filesExist wants artifacts. */
export function documentTurn(): ScriptedTurn {
  return turn(
    baseEnvelope({
      summary: "Documented the change.",
      artifacts: ["docs/CHANGELOG.md"],
      notes_for_next_agent: "Docs written; see docs/CHANGELOG.md.",
      doc_paths: ["docs/CHANGELOG.md"],
      audience: "both",
    }),
  );
}

/** ship — ShipEnvelope: outcome required. */
export function shipTurn(overrides: Record<string, unknown> = {}): ScriptedTurn {
  return turn(
    baseEnvelope({
      summary: "Shipped.",
      artifacts: [],
      notes_for_next_agent: "Shipped on a feature branch; PR open.",
      outcome: "shipped",
      commit_sha: "abc123",
      pr_url: "https://example.test/pr/1",
      ci_status: "passed",
      ...overrides,
    }),
  );
}
