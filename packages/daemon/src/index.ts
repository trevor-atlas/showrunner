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
  getRun,
  insertAgentSession,
  insertEnvelope,
  insertEvent,
  insertGateResult,
  insertPhase,
  insertProcess,
  insertRun,
  listAgentSessions,
  listEnvelopes,
  listGateResults,
  listPhases,
  listProcesses,
  listRuns,
  listTables,
  migrate,
  openDb,
  sumRunSpend,
  updateAgentSession,
  updatePhase,
  updateRun,
} from "./db.ts";
export type {
  AgentSessionRow,
  EnvelopeRow,
  GateResultRow,
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

// HTTP API (§13)
export { createDaemonServer } from "./server.ts";
export type { DaemonDeps } from "./server.ts";

// Daemon lifecycle
export { daemonEntryPath, installSignalHandlers, startDaemon } from "./daemon.ts";
export type { DaemonHandle } from "./daemon.ts";
