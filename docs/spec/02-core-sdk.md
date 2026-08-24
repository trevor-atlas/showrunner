# Showrunner — Specification · Core SDK (src/core)

> Part of the [Showrunner specification](README.md) — sections §3, §5, §14
> [index](README.md) · [01-overview](01-overview.md) · [02-core](02-core-sdk.md) · [03-data](03-data-and-events.md) · [04-daemon](04-daemon.md) · [05-ui](05-ui-dashboard.md) · [06-starter](06-starter-kit.md) · [07-tests](07-testing-and-rollout.md) · [08-verify](08-verification-record.md)

## 3 · Core SDK (`src/core`)

### 3.1 Dependencies

- `zod` (validation — the one validation story).
- Nothing else at runtime. No pi imports, no UI imports, no SQLite client in `core` (the daemon owns the DB; `core` owns shapes and the loop).

### 3.2 Envelope

```ts
// The base, extended per phase.
export const EnvelopeBase = z.object({
  summary: z.string(),                    // what this agent did, for humans
  artifacts: z.array(z.string()),         // paths in <run_id>/<phase>/outputs (run record dir, §9.1)
  notes_for_next_agent: z.string(),       // the handoff in prose
  blocked: z.boolean().optional(),        // agent asserts it cannot proceed
  blocked_reason: z.string().optional(),  // shown on the pause screen
});

export type Envelope = z.infer<typeof EnvelopeBase>;
export type PhaseEnvelope<S extends z.ZodTypeAny> = z.infer<S>;
```

**Semantics**: there is no `status` field. Outcome is determined by parse + gates, never by the agent's claim. `blocked` is the one agent-asserted signal: it short-circuits to the human pause *before* gates, burning no corrections, and is never routed through `on_fail`.

### 3.3 Agent

```ts
// A pure doer — no output contract of its own.
export interface Agent {
  name: string;
  model: string;                          // from the replaceable model roster
  prompt: string;
  tools: string[];                        // bash, edit, read, grep, find, poll…
  context: string[];                      // literal content or exact filepaths (§9)
}
export function defineAgent(a: Agent): Agent;
```

### 3.4 Gate

```ts
// Plain function, first-class.
export type Gate = (
  envelope: Envelope,
  ctx: GateContext,                       // workspace path, phase, run — see §3.7
) => Promise<{ pass: true } | { pass: false; violations: string[] }>;
```

Gates run **in the daemon process** (or a worker it controls — see §5.5), after parse succeeds and after the `blocked` short-circuit. Gate violations feed the correction message verbatim.

### 3.5 Blueprint

```ts
export interface BlueprintPhase {
  agent: Agent;                           // imported module, not a string
  envelope: z.ZodTypeAny;                 // extended from EnvelopeBase
  gates: Gate[];
  budget?: number;                        // max corrections per visit (default ~3)
  on_fail?: { to: string };               // phase name — fired after budget exhaustion
  require_approval?: boolean;             // pause for human before start
  context?: string[];                     // phase-level additions to the agent's defaults
}

export interface Blueprint {
  name: string;
  phases: BlueprintPhase[];               // index = execution order; on_fail may target any
  onPhaseStart?: (ctx: PhaseHookContext) => Promise<void>;
  onPhaseEnd?: (ctx: PhaseHookContext) => Promise<void>;
}

export function defineBlueprint(b: Blueprint): Blueprint;
```

**Validation at load time** (zod, in the daemon):
- `on_fail.to` must name a phase that exists (cycles allowed — the loop guard still terminates).
- Phase names unique.
- `envelope` must be assignable to `EnvelopeBase` (zod `.extend()` guarantees this structurally; check by building `EnvelopeBase.merge(phase.envelope)` and asserting it parses an `EnvelopeBase` instance).

### 3.6 Run / event types (domain)

```ts
export type RunStatus =
  | "running"        // at least one phase in flight
  | "paused"         // waiting on a human (approval, blocked, budget-exhausted, guard)
  | "success"
  | "failed"
  | "interrupted";   // daemon crashed; awaiting manual continue

export interface RunRecord {
  id: string;            // uuid
  blueprint: string;     // blueprint name (and module path at submit time)
  status: RunStatus;
  started_at: string;    // ISO-8601
  ended_at: string | null;
  cwd: string;           // the run's working directory
  pool_id: string | null;// which daemon pool slot owns it
  needs_review: boolean; // set when resumed after mid-tool-call death (§12)
}

export interface PhaseRecord {
  id: string;
  run_id: string;
  name: string;              // blueprint phase name
  agent: string;             // agent name
  status: "pending" | "in_progress" | "success" | "failed" | "skipped";
  started_at: string | null;
  ended_at: string | null;
  visits: number;            // executions of this phase (loop guard counter)
  corrections: number;       // re-prompts issued in the current visit
  budget: number;            // snapshot of the phase's budget
  spend_usd: number;         // accumulated from usage events
}

export interface AgentSessionRecord {
  id: string;
  run_id: string;
  phase_id: string;
  pi_session_id: string;     // the pi session key, create-or-continue
  visit: number;             // which visit of the phase this session belongs to
  pid: number;               // child pid (mirrored in processes)
  started_at: string;
  ended_at: string | null;
}
```

### 3.7 Contexts passed to hooks and gates

```ts
export interface RunContext { run_id: string; cwd: string; }
export interface PhaseHookContext extends RunContext {
  phase: string;
  shell(cmd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}
export interface GateContext extends RunContext {
  phase: string;
  visit: number;
}
```

`ctx.shell()` runs one subprocess one-liner (git status, install, test) and returns the full result; used by hooks (`onPhaseStart`/`onPhaseEnd`) and available to gates. It is the *only* escape hatch to the host shell — agents get their own `bash` tool; hooks/gates get `shell()`.



---

## 5 · The run loop (state machine)

This is the normative version of `docs/diagrams/run-loop.md`. The loop is **linear + `on_fail` pointers**; no parallelism in v1.

### 5.1 States

Per-run: `submitted → running → {success | failed | paused | interrupted}`.
Per-phase: `pending → in_progress → {success | failed | skipped}`.

A run is `running` while a phase is `in_progress`; `paused` when parked on a human decision; `interrupted` only via the crash path (§12).

### 5.2 Transitions (in order of evaluation, per visit)

```
1. require_approval? ── yes → PAUSE(approve) → (approve) → 2
2. materialize <run_id>/<phase>/inputs/ (the run record dir, §9) + rendered predecessor envelope
   (the "context transfers in code" step, §9)
3. visits >= max_visits? ── yes → PAUSE(guard exhausted)   [loop guard]
4. spawn pi: `--mode rpc --session-id <id> --approve`, cwd = run.cwd, then send the
   composed prompt as the first RPC command (§8.1) — prompt = phase prompt + rendered
   envelope schema + handoff + context (§8.2)
5. tail events → SQLite (live feed) until `agent_settled` (§8.3)
6. zod-validate envelope.json
   ── invalid → correction (same session, one message naming the failure) → step 6
   ── valid → 7
7. envelope.blocked? ── yes → PAUSE(blocked)   [never routed through on_fail]
8. run gates
   ── violations → correction (same session) → step 6
   ── pass → 9
9. record envelope (envelopes row + envelope.json) → next phase (or success)
```

**Correction budget** (`budget`, default 3): counts *corrections within the visit*. Exhaustion → `on_fail` if wired, else PAUSE(menu). **Visit guard** (`max_visits`, default 3): counts *visits*, so `reviewer → builder → reviewer` cycles always terminate or pause.

### 5.3 The pause menu (any pause)

| Action | Effect | Audited as |
|---|---|---|
| **steer** | inject a corrective instruction into the *same* pi session (rpc steer), between turns; then the visit continues at step 5 | `human_action` |
| **override gate** | mark the gate result overridden; record the envelope and continue to step 9 | `human_action` (keeps the original `gate_results` row — the audit trail is the point) |
| **restart phase fresh** | new pi session, same agent config, same phase; counts as a new visit | `human_action` |
| **fail run** | run → `failed` | `run_failed` |

`blocked` and guard pauses offer the same menu minus override (nothing was rejected; there is nothing to override).

### 5.4 Concurrency

- Pool of N run slots (default 2), configurable via daemon config/env.
- A run holds a slot from first spawn to terminal state. `paused` runs keep their slot (cheap — no pi process is alive while paused).
- Spawns beyond the pool queue at the daemon; `list-runs` shows queue position.

### 5.5 Gate execution

Gates are arbitrary TS in the blueprint module. v1 runs them **in the daemon process** (the blueprint is trusted code by construction). Isolation via a worker/`node:vm` boundary is deferred unless a blueprint needs it; the failure mode is a thrown gate, which is caught and treated as a violation with the error text (so a crashing gate never crashes the daemon).



---

## 14 · Hooks & waits

- Hooks: `onPhaseStart(ctx)` / `onPhaseEnd(ctx)` in the blueprint module; `ctx.shell()` for git/install one-liners (§3.7). Thrown hook errors → `phase_end` with `failed` + a `human_action`-style audit event; the run pauses (menu) rather than dying silently.
- Waits: the starter toolset ships a `poll`/`wait_for` tool with its own timeout, used by agents (e.g. `ship` watching CI). The harness does not manage external waits; it just observes the long tool call (`tool_call` with large `duration_ms`).



