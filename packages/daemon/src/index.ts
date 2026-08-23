/**
 * @showrunner/daemon — the daemon package's public surface.
 */

// SQLite (§4)
export {
  CURSOR_SQL,
  SCHEMA_VERSION,
  cursorEvents,
  deleteProcess,
  eventCount,
  getEnvelope,
  getGateResult,
  getPhaseById,
  getRun,
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
  listGateOverrides,
  listGateResults,
  listPhases,
  listProcesses,
  listRuns,
  listTables,
  migrate,
  openDb,
  sumRunSpend,
  updateAgentSession,
  updateEnvelope,
  updatePhase,
  updateRun,
} from "./db.ts";
export type {
  AgentSessionRow,
  EnvelopeRow,
  GateOverrideRow,
  GateOverrideWithGate,
  GateResultRow,
  GateResultWithOverride,
  NewEvent,
  PhaseRow,
  ProcessRow,
  RunRow,
  RunWithSpend,
} from "./db.ts";

// Tracer (§7)
export { DEFAULT_SNIPPET_CAP, Tracer, extractUsage, joinTextBlocks } from "./tracer.ts";
export type { FoldedEvent, FoldedEventType, TracerOptions, TracerSink } from "./tracer.ts";

// Raw records (§10)
export { RawOutputFile, tailRawFile } from "./rawfile.ts";

// Line framing (§7.1)
export { LineSplitter } from "./linesplit.ts";

// Event queue
export { EventSink } from "./queue.ts";
export type { EventIds } from "./queue.ts";

// Envelope/gate runner (T03 seam)
export { gateName, isEnvelopeApproved, overrideGateResult, recordEnvelopeAcceptance, runEnvelopeStage } from "./envelope-runner.ts";
export type {
  EnvelopeOutcome,
  EnvelopeStageOptions,
  GateOverrideResult,
  GateRun,
  OverrideGateOptions,
  RecordEnvelopeAcceptanceOptions,
} from "./envelope-runner.ts";

// The §5 run loop
export {
  DEFAULT_MAX_VISITS,
  composePrompt,
  drivePreparedRun,
  loadBlueprintModule,
  materializeInputs,
  prepareBlueprintRun,
  renderSchema,
  resolveContextEntries,
  resolveScriptedSessions,
  runBlueprint,
  slugFor,
  snapshotBlueprint,
  submitBlueprintRun,
} from "./runner.ts";
export type {
  BlueprintRun,
  PreparedRun,
  RunBlueprintOptions,
  RunResult,
  ScriptMap,
  ScriptedSession,
  ScriptedTurn,
} from "./runner.ts";

// §5.4 run pool
export { RunPool } from "./pool.ts";

// Driver (T01a minimal submit)
export {
  DEFAULT_FIXTURE_AGENT,
  DEFAULT_FIXTURE_DELAY_MS,
  DEFAULT_FIXTURE_MODEL,
  DEFAULT_FIXTURE_PHASE,
  MAX_CAPTURED_STDERR,
  sessionIdFor,
  submitFixture,
} from "./driver.ts";
export type { SubmittedRun, SubmitOptions } from "./driver.ts";

// pi session drivers (T02: real pi spawn behind the §8 seam)
export {
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_STDERR_CAP,
  FIRST_PROMPT_ACK_TIMEOUT_MS,
  FakeSessionDriver,
  PiSession,
  SESSION_ID_RE,
  SIGKILL_AFTER_MS,
  resolvePiBinary,
  sessionDriverKind,
} from "./pi/index.ts";
export type {
  FakeSessionDriverOptions,
  PiSessionOptions,
  RpcCommand,
  RpcResponse,
  SessionDriver,
  SessionDriverKind,
} from "./pi/index.ts";

// HTTP API (§13)
export { createDaemonServer } from "./server.ts";
export type { DaemonDeps } from "./server.ts";

// Daemon lifecycle
export { daemonEntryPath, installSignalHandlers, startDaemon } from "./daemon.ts";
export type { DaemonHandle } from "./daemon.ts";
