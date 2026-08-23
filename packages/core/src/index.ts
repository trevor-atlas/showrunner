/**
 * @showrunner/core — the Showrunner SDK.
 *
 * Framework-agnostic: no pi, no UI, no SQLite client. zod is the only runtime
 * dependency (§3.1). The daemon and CLI import everything from here.
 */

// Envelope (§3.2)
export { EnvelopeBase } from "./envelope.ts";
export type { Envelope, PhaseEnvelope } from "./envelope.ts";

// Agent (§3.3)
export { defineAgent } from "./agent.ts";
export type { Agent } from "./agent.ts";

// Gate (§3.4)
export type { Gate, GateContext, GateResult } from "./gate.ts";

// Shell escape hatch (§3.7) — the fallback `ctx.shell` for gates/hooks
// when the runtime does not provide one.
export { createShell, runCommand } from "./shell.ts";
export type { CreateShellOptions } from "./shell.ts";

// Blueprint (§3.5)
export {
  BlueprintValidationError,
  DEFAULT_BUDGET,
  defineBlueprint,
  validateBlueprint,
} from "./blueprint.ts";
export type { Blueprint, BlueprintPhase } from "./blueprint.ts";

// Run / domain types (§3.6, §3.7)
export type {
  AgentSessionRecord,
  PhaseHookContext,
  PhaseRecord,
  PhaseStatus,
  RunContext,
  RunRecord,
  RunStatus,
  ShellResult,
} from "./run.ts";

// The 12 event types (§6)
export {
  EVENT_DATA_SCHEMAS,
  EVENT_TYPES,
  AgentEndData,
  AgentStartData,
  CorrectionData,
  EnvelopeData,
  GateResultData,
  HumanActionData,
  PhaseEndData,
  PhaseStartData,
  RunStatusData,
  RunSubmittedData,
  SpendData,
  ToolCallData,
  isEventType,
  parseEventData,
  serializeEventData,
} from "./events.ts";
export type {
  AgentEnd,
  AgentStart,
  EventRow,
  EventType,
  PhaseEnd,
  RunStatusEvent,
  Spend,
  ToolCall,
} from "./events.ts";

// Raw pi event shapes (§7.1)
export {
  ContentBlocks,
  MACHINERY_EVENT_TYPES,
  RawAgentEnd,
  RawAgentSettled,
  RawAgentStart,
  RawMessageEnd,
  RawMessageStart,
  RawMessageUpdate,
  RawToolExecutionEnd,
  RawToolExecutionStart,
  RawToolExecutionUpdate,
  RawTurnEnd,
  RawTurnStart,
  TextBlock,
} from "./rawevents.ts";

// Data dir resolution (§4.1)
export {
  DEFAULT_DATA_DIR_NAME,
  dbPathFor,
  resolveDataDir,
  runDirFor,
  socketPathFor,
} from "./data-dir.ts";
