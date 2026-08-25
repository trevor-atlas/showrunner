/**
 * @showrunner/daemon — the daemon package's public surface.
 */

// SQLite
export {
  CURSOR_SQL,
  SCHEMA_VERSION,
  countUnoverriddenFailedGates,
  cursorEvents,
  deleteProcess,
  eventCount,
  getEnvelope,
  getGateResult,
  getPhaseById,
  getRun,
  hasGateOverride,
  insertAgentSession,
  insertEnvelope,
  insertEvent,
  insertGateOverride,
  insertGateResult,
  insertPhase,
  insertProcess,
  insertRun,
  listAgentSessions,
  listEnvelopes,
  listFailedGateResults,
  listGateNamesByIds,
  listGateOverrides,
  listGateResults,
  listPhaseSpend,
  listPhases,
  listProcesses,
  listRuns,
  listTables,
  migrate,
  openDb,
  phaseStatusCounts,
  sumEstimatedPhaseSpend,
  sumRunSpend,
  sumSpendTokenTotals,
  sweepRunEvents,
  updateAgentSession,
  updateEnvelope,
  updatePhase,
  updateRun,
} from "./db.ts";
export type {
  AgentSessionRow,
  EnvelopeRow,
  FailedGateRow,
  GateOverrideRow,
  GateOverrideWithGate,
  GateResultRow,
  GateResultWithOverride,
  NewEvent,
  PhaseRow,
  PhaseSpendRow,
  ProcessRow,
  RunRow,
  RunWithSpend,
} from "./db.ts";

// Tracer
export { DEFAULT_SNIPPET_CAP, Tracer, extractUsage, joinTextBlocks } from "../server/engine/tracer.ts";
export type { FoldedEvent, FoldedEventType, TracerOptions, TracerSink } from "../server/engine/tracer.ts";

// Price roster
export { PRICES_FILE, RosterEntrySchema, RosterSchema, estimateUsd, loadRoster, pricesPathFor } from "../server/engine/roster.ts";
export type { Roster, RosterEntry } from "../server/engine/roster.ts";

// Raw records
export { RawOutputFile, tailRawFile } from "./rawfile.ts";

// context & handoff filesystem protocol (T05)
export {
  inputsDirFor,
  materializeHandoff,
  outputsDirFor,
  phaseDirFor,
  readAgentMap,
  readHandoffInputs,
  recordAcceptedEnvelope,
  resolveContext,
  sessionDirNameForCwd,
  slugFor,
  writeAgentMap,
} from "./workspace/index.ts";
export type { AgentMapEntry, Handoff } from "./workspace/index.ts";

// Line framing
export { LineSplitter } from "../server/engine/linesplit.ts";

// Event queue
export { EventSink } from "../server/engine/queue.ts";
export type { EventIds } from "../server/engine/queue.ts";

// Envelope/gate runner (T03 seam)
export { gateName, isEnvelopeApproved, overrideGateResult, recordEnvelopeAcceptance, runEnvelopeStage } from "../server/engine/envelope-runner.ts";
export type {
  EnvelopeOutcome,
  EnvelopeStageOptions,
  GateOverrideResult,
  GateRun,
  OverrideGateOptions,
  RecordEnvelopeAcceptanceOptions,
} from "../server/engine/envelope-runner.ts";

// The run loop
export {
  DEFAULT_MAX_VISITS,
  composeContinuePrompt,
  composePrompt,
  drivePreparedRun,
  driveResumedRun,
  loadBlueprintModule,
  materializeInputs,
  prepareBlueprintRun,
  prepareResume,
  renderSchema,
  resolveContextEntries,
  resolveScriptedSessions,
  runBlueprint,
  snapshotBlueprint,
  submitBlueprintRun,
} from "../server/engine/runner.ts";
export type {
  BlueprintRun,
  PreparedResume,
  PreparedRun,
  ResumeSpec,
  RunBlueprintOptions,
  RunResult,
  ScriptMap,
  ScriptedSession,
  ScriptedTurn,
} from "../server/engine/runner.ts";

// run pool
export { RunPool } from "../server/engine/pool.ts";

// T04 pause & control surface (pause menu, resume, F1 slot hold)
export {
  RunControl,
  cleanupProcesses,
  effectiveMenu,
  getControl,
  getControlByLiveSession,
  isPidAlive,
  killRunProcesses,
  reconcileInterruptedRuns,
  registerControl,
  resumeInterruptedRun,
  statelessFailRun,
  stopRecordedChildren,
  unregisterControl,
} from "../server/engine/pause-control.ts";
export type {
  ControlAction,
  ControlState,
  LiveSessionRef,
  PauseInfo,
  PauseKind,
  RunControlResult,
} from "../server/engine/pause-control.ts";

// Driver (T01a minimal submit)
export {
  DEFAULT_FIXTURE_AGENT,
  DEFAULT_FIXTURE_DELAY_MS,
  DEFAULT_FIXTURE_MODEL,
  DEFAULT_FIXTURE_PHASE,
  MAX_CAPTURED_STDERR,
  sessionIdFor,
  submitFixture,
} from "../server/engine/driver.ts";
export type { SubmittedRun, SubmitOptions } from "../server/engine/driver.ts";

// pi session drivers (T02: real pi spawn behind the seam)
export {
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_STDERR_CAP,
  FIRST_PROMPT_ACK_TIMEOUT_MS,
  FakeSessionDriver,
  PiSession,
  SESSION_ID_RE,
  SIGKILL_AFTER_MS,
  findPiBinary,
  resolvePiBinary,
  sessionDriverKind,
} from "../server/engine/pi/index.ts";
export type {
  FakeSessionDriverOptions,
  PiSessionOptions,
  RpcCommand,
  RpcResponse,
  SessionDriver,
  SessionDriverKind,
} from "../server/engine/pi/index.ts";

// backfill (T07: session-JSONL re-read, deduped against the run's raw file)
export { backfillMissedEvents } from "../server/engine/backfill.ts";
export type { BackfillSessionReport, BackfillSummary } from "../server/engine/backfill.ts";

// HTTP API
export { createWebServer } from "./web.ts";
// The api core: exported per-endpoint functions the wire dispatcher and the
// UI actions (in-process, T4) share. ApiError is re-exported here from
// contract.ts (see below) — one class for the whole daemon.
export {
  apiApprove,
  apiEvents,
  apiFailRun,
  apiHealth,
  apiListRuns,
  apiOverrideGate,
  apiPause,
  apiPhaseEnvelopes,
  apiPhaseGates,
  apiPhaseOutputs,
  apiRaw,
  apiResume,
  apiRestartFresh,
  apiRunDetail,
  apiSessionSteer,
  apiSpend,
  apiStats,
  apiStatus,
  apiSteerRun,
  apiSubmitRun,
  handleApiRequest,
} from "./server.ts";
export type { ApiState } from "./server.ts";

// The one shared wire contract — the shapes server.ts (producer),
// client.ts (consumer), and the UI all import from the same module.
export { ApiError } from "./contract.ts";
export type {
  ControlResult,
  DaemonStatus,
  EventsPage,
  EventsQuery,
  PauseView,
  PhaseEnvelopes,
  PhaseGates,
  PhaseOutputs,
  PhaseSummary,
  RawQuery,
  RawTail,
  RunDetail,
  RunListItem,
  RunStats,
  SegmentCause,
  SpendBreakdown,
  SteerBody,
  SubmitRunBody,
  SubmitRunResult,
  TimelinePhase,
  TimelineSegment,
  TimelineView,
} from "./contract.ts";

// The typed client (ships for the CLI and the UI; http-only — the daemon
// serves the API under /api/* on one TCP listener). The shapes it moves
// are the contract's — re-exported above; client.ts carries the transport.
export {
  DaemonClient,
  isDaemonDown,
} from "./client.ts";
export type { DaemonClientOptions } from "./client.ts";

// Daemon lifecycle
export { daemonEntryPath, installSignalHandlers, startDaemon } from "./daemon.ts";
export type { DaemonHandle } from "./daemon.ts";
