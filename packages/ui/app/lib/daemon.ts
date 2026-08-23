/**
 * The dashboard's server-side daemon access (spec §16.10 `app/lib/daemon.ts`).
 *
 * A thin typed wrapper over the §13 typed client (`packages/daemon`). The
 * browser NEVER imports this module and NEVER talks to the daemon: actions
 * fetch the daemon here, server-side, and the browser only receives rendered
 * HTML (§16.4/§16.5 — no CORS, no daemon credentials in the browser).
 *
 * Import shape: the daemon is imported relatively (not as a `file:` package
 * dep) because bun 1.4 cannot resolve a `file:` dep's own `file:` deps — the
 * CLI uses the same pattern (packages/cli/src/daemon-lifecycle.ts). The
 * client handles unix-socket (default) and SHOWRUNNER_DAEMON_URL http
 * transports itself.
 */

import { DaemonClient, isSocketDown, resolveTransport } from "../../../daemon/src/client.ts";
import type {
  DaemonTransport,
  EventsPage,
  PhaseEnvelopes,
  PhaseGates,
  RawTail,
  RunDetail,
  RunListItem,
  SpendBreakdown,
} from "../../../daemon/src/client.ts";

/** What the daemon-down banner reports as "expected at <…>". */
export function daemonAddress(): string {
  return describeTransport(resolveTransport());
}

/** The run list rows, or a DaemonUnreachable error when the daemon is down. */
export async function listRuns(): Promise<{ runs: RunListItem[] }> {
  const client = new DaemonClient();
  try {
    return await client.listRuns();
  } catch (err) {
    if (isSocketDown(err)) {
      throw new DaemonUnreachable(resolveTransport(), err);
    }
    throw err;
  }
}

/** The run detail — phases, spend, envelope count, sessions (§13.1). */
export async function getRunDetail(runId: string): Promise<RunDetail> {
  return fetchDaemon((client) => client.getRun(runId));
}

/** GET /runs/:id/phases/:phase/envelopes — a phase's envelope history. */
export async function getPhaseEnvelopes(runId: string, phase: string): Promise<PhaseEnvelopes> {
  return fetchDaemon((client) => client.getPhaseEnvelopes(runId, phase));
}

/** GET /runs/:id/phases/:phase/gates — gate results incl. overridden. */
export async function getPhaseGates(runId: string, phase: string): Promise<PhaseGates> {
  return fetchDaemon((client) => client.getPhaseGates(runId, phase));
}

/** GET /runs/:id/spend — per-phase spend breakdown (+ estimated markers). */
export async function getSpend(runId: string): Promise<SpendBreakdown> {
  return fetchDaemon((client) => client.getSpend(runId));
}

/** GET /runs/:id/raw?lines=N — the raw_output.jsonl tail (drill-in feed). */
export async function getRaw(runId: string, opts: { lines?: number } = {}): Promise<RawTail> {
  return fetchDaemon((client) => client.getRaw(runId, opts));
}

/** GET /runs/:id/events — the §4.3 cursor page (drill-in sums §6 #12 spend). */
export async function getRunEvents(runId: string, opts: { cursor?: number; limit?: number } = {}): Promise<EventsPage> {
  return fetchDaemon((client) => client.getEvents(runId, opts));
}

/** Run one daemon call, translating socket-down into DaemonUnreachable. */
async function fetchDaemon<T>(call: (client: DaemonClient) => Promise<T>): Promise<T> {
  const client = new DaemonClient();
  try {
    return await call(client);
  } catch (err) {
    if (isSocketDown(err)) {
      throw new DaemonUnreachable(resolveTransport(), err);
    }
    throw err;
  }
}

/**
 * The daemon is unreachable (socket/connection refused) — distinct from an
 * API error so pages can render the shell with the DaemonDownBanner instead
 * of 500ing (§16.10).
 */
export class DaemonUnreachable extends Error {
  readonly transport: DaemonTransport;

  constructor(transport: DaemonTransport, cause: unknown) {
    super(`showrunner daemon is not running (expected at ${describeTransport(transport)})`, { cause });
    this.name = "DaemonUnreachable";
    this.transport = transport;
  }
}

function describeTransport(t: DaemonTransport): string {
  return t.kind === "unix" ? t.socketPath : t.baseUrl;
}
