/**
 * @showrunner/core — the Showrunner SDK.
 *
 * Framework-agnostic: no pi, no UI, no SQLite client. zod is the only runtime
 * dependency. The daemon and CLI import everything from here.
 */

// Envelope
export { EnvelopeBase } from "./envelope.ts";
export type { Envelope, PhaseEnvelope } from "./envelope.ts";

// Agent
export { defineAgent } from "./agent.ts";
export type { Agent } from "./agent.ts";

// Gate
export type { Gate, GateContext, GateResult } from "./gate.ts";

// Shell escape hatch — the fallback `ctx.shell` for gates/hooks
// when the runtime does not provide one.
export { createShell, runCommand } from "./shell.ts";
export type { CreateShellOptions } from "./shell.ts";

// Blueprint
export {
  BlueprintValidationError,
  DEFAULT_BUDGET,
  defineBlueprint,
  validateBlueprint,
} from "./blueprint.ts";
export type { Blueprint, BlueprintPhase } from "./blueprint.ts";

// Run / domain types
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

// The 12 event types
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
  PhaseStartCause,
  PhaseStartCauseFlow,
  PhaseStartCauseHuman,
  PhaseStartCauseOnFail,
  RunStatusEvent,
  Spend,
  ToolCall,
} from "./events.ts";

// Raw pi event shapes
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

// Data dir resolution
export {
  DEFAULT_DATA_DIR_NAME,
  dbPathFor,
  resolveDataDir,
  runDirFor,
} from "./data-dir.ts";
