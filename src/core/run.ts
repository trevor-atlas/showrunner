/**
 * Run/phase/session domain types and the contexts passed to hooks and gates
 * (spec §3.6, §3.7).
 */

export type RunStatus =
  | "running" // at least one phase in flight
  | "paused" // waiting on a human (approval, blocked, budget-exhausted, guard)
  | "success"
  | "failed"
  | "interrupted"; // daemon crashed; awaiting manual continue

export interface RunRecord {
  id: string; // uuid
  blueprint: string; // blueprint name (and module path at submit time)
  status: RunStatus;
  started_at: string; // ISO-8601
  ended_at: string | null;
  cwd: string; // the run's working directory
  pool_id: string | null; // which daemon pool slot owns it
  needs_review: boolean; // set when resumed after mid-tool-call death (§12)
}

export type PhaseStatus = "pending" | "in_progress" | "success" | "failed" | "skipped";

export interface PhaseRecord {
  id: string;
  run_id: string;
  name: string; // blueprint phase name
  agent: string; // agent name
  status: PhaseStatus;
  started_at: string | null;
  ended_at: string | null;
  visits: number; // executions of this phase (loop guard counter)
  corrections: number; // re-prompts issued in the current visit
  budget: number; // snapshot of the phase's budget
  spend_usd: number; // accumulated from usage events
}

export interface AgentSessionRecord {
  id: string;
  run_id: string;
  phase_id: string;
  pi_session_id: string; // the pi session key, create-or-continue
  visit: number; // which visit of the phase this session belongs to
  pid: number; // child pid (mirrored in processes)
  started_at: string;
  ended_at: string | null;
}

/** RunContext (spec §3.7). */
export interface RunContext {
  run_id: string;
  cwd: string;
}

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** PhaseHookContext (spec §3.7): hooks get ctx.shell() for subprocess one-liners. */
export interface PhaseHookContext extends RunContext {
  phase: string;
  shell(cmd: string): Promise<ShellResult>;
}
