import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { EventRow } from "@showrunner/core";
import { resolveDataDir, socketPathFor } from "@showrunner/core";

import type { AgentSessionRow, EnvelopeRow, GateResultWithOverride, PhaseRow, RunRow } from "./db.ts";

/**
 * The typed HTTP client for the daemon's §13 API — ships for the CLI and the
 * UI (the UI is a server-side client: remix actions fetch this API; the
 * browser never talks to the daemon directly, §16). One method per §13
 * endpoint, typed request/response.
 *
 * Transport: node:http over a unix socket by default (unix://~/.showrunner/
 * daemon.sock, honoring SHOWRUNNER_DATA_DIR). An http base URL — the
 * SHOWRUNNER_DAEMON_URL env override for dev, or an explicit `baseUrl` — uses
 * node:http's host/port path instead.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Distinguish "the daemon is down" (socket/connection errors) from API errors. */
export function isSocketDown(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EADDRNOTAVAIL";
}

// ── transport ────────────────────────────────────────────────────────────────

export type DaemonTransport = { kind: "unix"; socketPath: string } | { kind: "http"; baseUrl: string };

/**
 * Resolve the transport: explicit baseUrl > explicit socketPath >
 * SHOWRUNNER_DAEMON_URL (http dev override) > the default unix socket.
 */
export function resolveTransport(
  opts: { socketPath?: string; baseUrl?: string; env?: Record<string, string | undefined> } = {},
): DaemonTransport {
  const env = opts.env ?? process.env;
  const normalizeHttp = (u: string): string => u.replace(/\/+$/, "");
  if (opts.baseUrl !== undefined && opts.baseUrl !== "") {
    return { kind: "http", baseUrl: normalizeHttp(opts.baseUrl) };
  }
  if (opts.socketPath !== undefined && opts.socketPath !== "") {
    return { kind: "unix", socketPath: opts.socketPath };
  }
  const override = env.SHOWRUNNER_DAEMON_URL;
  if (override !== undefined && override.trim() !== "") {
    return { kind: "http", baseUrl: normalizeHttp(override) };
  }
  return { kind: "unix", socketPath: socketPathFor(resolveDataDir(env)) };
}

// ── §13 response shapes (the wire contract the server honors) ────────────────

export interface RunListItem extends RunRow {
  spend_usd: number;
  /** §13.1: 1-based spawn-queue position for pool-queued runs; null when not queued */
  queue_position: number | null;
  phase_counts: Record<string, number>;
}

export interface PhaseSummary extends PhaseRow {
  estimated_spend_usd: number;
}

export interface RunDetail {
  run: RunRow;
  spend_usd: number;
  estimated_spend_usd: number;
  envelope_count: number;
  phases: PhaseSummary[];
  sessions: AgentSessionRow[];
  event_count: number;
}

export interface EventsPage {
  events: EventRow[];
  /** §4.3: the last rowid returned (or the requested cursor when the page is
   * empty) — pass this as `cursor` on the next poll; the query is idempotent */
  next_cursor: number;
}

export interface PhaseEnvelopes {
  run_id: string;
  phase: string;
  phase_id: string;
  /** ALL attempts (valid and rejected), ordered visit → attempt (T03) */
  envelopes: EnvelopeRow[];
}

export interface PhaseGates {
  run_id: string;
  phase: string;
  phase_id: string;
  /** gate results incl. the §5.3 override badge (who + why + when) */
  gates: GateResultWithOverride[];
}

export interface SpendBreakdown {
  run_id: string;
  spend_usd: number;
  estimated_spend_usd: number;
  phases: { id: string; name: string; status: string; spend_usd: number; estimated_spend_usd: number }[];
}

export interface RawTail {
  run_id: string;
  /** the last N raw_output.jsonl lines, verbatim, newline-joined */
  raw: string;
  /** the FULL line count of the raw file */
  line_count: number;
  /** true when the tail dropped earlier lines (the file exceeds the requested N) */
  truncated: boolean;
}

export interface PauseView {
  run_id: string;
  paused: boolean;
  status: string;
  kind?: string;
  phase?: string;
  reason?: string | null;
  actions?: string[];
  queued_steers?: string[];
  live_session_id?: string | null;
  note?: string;
}

export interface DaemonStatus {
  ok: boolean;
  pid: number;
  data_dir: string;
  uptime_ms: number;
  pool: { slots: number; running: string[]; queued: string[] };
  runs: Record<string, number>;
}

export interface SubmitRunResult {
  run_id: string;
  queue_position: number | null;
  blueprint?: string; // blueprint runs
  phase_id?: string; // fixture runs
  agent_session_id?: string;
  fixture?: string;
}

export interface ControlResult {
  run_id: string;
  ok: boolean;
  status: string;
  needs_review?: number;
  queued_steers?: number;
  message?: string;
  verb?: string;
}

// ── the client ───────────────────────────────────────────────────────────────

export interface DaemonClientOptions {
  /** explicit unix socket path (e.g. from the CLI's --data-dir) */
  socketPath?: string;
  /** explicit http base URL (dev override) — wins over socketPath */
  baseUrl?: string;
}

export class DaemonClient {
  private readonly transport: DaemonTransport;

  constructor(opts: DaemonClientOptions = {}) {
    this.transport = resolveTransport(opts);
  }

  // ── the one low-level verb; every §13 method is a typed wrapper ───────────

  private request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const reqOptions =
        this.transport.kind === "unix"
          ? { socketPath: this.transport.socketPath, method, path }
          : (() => {
              const url = new URL(this.transport.baseUrl + path);
              return { hostname: url.hostname, port: url.port === "" ? undefined : url.port, method, path: url.pathname + url.search };
            })();
      const req = request(
        {
          ...reqOptions,
          headers: body === undefined ? {} : { "content-type": "application/json" },
        },
        (res: IncomingMessage) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            let parsed: unknown = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              // keep the raw text
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.setTimeout(15_000, () => req.destroy(new Error("request timed out")));
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private async typed<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, body: res } = await this.request(method, path, body);
    if (status < 200 || status >= 300) {
      throw new ApiError(status, errorMessage(res, `${status} ${method} ${path}`));
    }
    return res as T;
  }

  // ── §13.1 read endpoints ──────────────────────────────────────────────────

  /** GET /health — daemon up probe. */
  health(): Promise<{ ok: boolean }> {
    return this.typed("GET", "/health");
  }

  /** GET /status — health + pool utilization + run status counts (T07). */
  status(): Promise<DaemonStatus> {
    return this.typed("GET", "/status");
  }

  /** GET /runs — the run list, each with queue position (§13.1). */
  listRuns(): Promise<{ runs: RunListItem[] }> {
    return this.typed("GET", "/runs");
  }

  /** GET /runs/:id — run detail: phases, spend, envelope count, sessions. */
  getRun(runId: string): Promise<RunDetail> {
    return this.typed("GET", `/runs/${encodeURIComponent(runId)}`);
  }

  /**
   * GET /runs/:id/events?cursor=&limit= — the §4.3 cursor query. `cursor` is
   * the last rowid seen (0 for the start); `limit` defaults to 500 (capped at
   * 500). The response's next_cursor is the cursor for the next poll.
   */
  getEvents(runId: string, opts: { cursor?: number; limit?: number } = {}): Promise<EventsPage> {
    const q = new URLSearchParams();
    if (opts.cursor !== undefined) q.set("cursor", String(opts.cursor));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.typed("GET", `/runs/${encodeURIComponent(runId)}/events${qs === "" ? "" : `?${qs}`}`);
  }

  /** GET /runs/:id/phases/:phase/envelopes — a phase's envelope history. */
  getPhaseEnvelopes(runId: string, phase: string): Promise<PhaseEnvelopes> {
    return this.typed("GET", `/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phase)}/envelopes`);
  }

  /** GET /runs/:id/phases/:phase/gates — gate results incl. overridden. */
  getPhaseGates(runId: string, phase: string): Promise<PhaseGates> {
    return this.typed("GET", `/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phase)}/gates`);
  }

  /** GET /runs/:id/spend — per-phase spend breakdown (+ estimated markers). */
  getSpend(runId: string): Promise<SpendBreakdown> {
    return this.typed("GET", `/runs/${encodeURIComponent(runId)}/spend`);
  }

  /** GET /runs/:id/raw?lines=N — the raw_output.jsonl tail (drill-in feed). */
  getRaw(runId: string, opts: { lines?: number } = {}): Promise<RawTail> {
    const q = opts.lines !== undefined ? `?lines=${Math.max(1, Math.floor(opts.lines))}` : "";
    return this.typed("GET", `/runs/${encodeURIComponent(runId)}/raw${q}`);
  }

  /** GET /runs/:id/pause — the pause viewer (T04; not in §13's table). */
  pause(runId: string): Promise<PauseView> {
    return this.typed("GET", `/runs/${encodeURIComponent(runId)}/pause`);
  }

  // ── §13.2 control endpoints ───────────────────────────────────────────────

  /** POST /runs — submit a blueprint module (§13.3) or an observation fixture. */
  submitRun(body: SubmitRunBody): Promise<SubmitRunResult> {
    return this.typed("POST", "/runs", body);
  }

  /** POST /runs/:id/resume — continue an interrupted run from its last completed phase. */
  resume(runId: string, body?: { by?: string }): Promise<ControlResult> {
    return this.typed("POST", `/runs/${encodeURIComponent(runId)}/resume`, body ?? {});
  }

  /** POST /runs/:id/fail — fail the run and kill its children (§8.3). */
  failRun(runId: string, body?: { by?: string }): Promise<ControlResult> {
    return this.typed("POST", `/runs/${encodeURIComponent(runId)}/fail`, body ?? {});
  }

  /** POST /sessions/:pi_session_id/steer — steer the live session by pi session id. */
  steerSession(piSessionId: string, message: string, by?: string): Promise<ControlResult> {
    return this.typed("POST", `/sessions/${encodeURIComponent(piSessionId)}/steer`, { message, ...(by ? { by } : {}) });
  }

  /** POST /runs/:id/steer — run-keyed steer (T04; not in §13's table). */
  steerRun(runId: string, message: string, by?: string): Promise<ControlResult> {
    return this.typed("POST", `/runs/${encodeURIComponent(runId)}/steer`, { message, ...(by ? { by } : {}) });
  }

  /** POST /runs/:id/approve — approve a require_approval pause. */
  approve(runId: string, body?: { by?: string }): Promise<ControlResult> {
    return this.typed("POST", `/runs/${encodeURIComponent(runId)}/approve`, body ?? {});
  }

  /** POST /runs/:id/phases/:phase/override — override a failed gate (audited). */
  overrideGate(runId: string, phase: string, body: { gate: string; reason: string; by?: string }): Promise<ControlResult> {
    return this.typed(
      "POST",
      `/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phase)}/override`,
      body,
    );
  }

  /** POST /runs/:id/phases/:phase/restart-fresh — new pi session, same config. */
  restartFresh(runId: string, phase: string, body?: { by?: string }): Promise<ControlResult> {
    return this.typed(
      "POST",
      `/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phase)}/restart-fresh`,
      body ?? {},
    );
  }
}

export type SubmitRunBody =
  | { blueprint: string; cwd?: string; args?: string[] }
  | { fixture: string; cwd?: string; delayMs?: number; agent?: string; model?: string; phase?: string };

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return fallback;
}
