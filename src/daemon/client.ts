import { request } from "node:http";
import type { IncomingMessage } from "node:http";

/**
 * The typed HTTP client for the daemon's API — ships for the CLI and the
 * UI (the UI is a server-side client: remix actions fetch this API; the
 * browser never talks to the daemon directly). One method per
 * endpoint, typed request/response.
 *
 * Transport: node:http over TCP only — the daemon's merged web server serves
 * the API under `/api/*` on ONE listener (default 127.0.0.1:44100, port
 * overridable via SHOWRUNNER_PORT). The unix socket is gone; `baseUrl`
 * defaults to http://127.0.0.1:${SHOWRUNNER_PORT ?? 44100}.
 *
 * The wire shapes and ApiError live in contract.ts — the client re-exports
 * them here so the CLI (cli/index.ts, cli/daemon-lifecycle.ts, cli/watch.ts)
 * compiles unchanged.
 */

// The one error class — shared with the server core and the UI.
import { ApiError } from "../server/contract.ts";
// The one wire contract — imported locally (the class body uses them)
// and re-exported so consumers (the CLI, the UI) keep their imports.
import type {
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
} from "../server/contract.ts";

export { ApiError };
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
};

/** Distinguish "the daemon is down" (connection errors) from API errors. */
export function isDaemonDown(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EADDRNOTAVAIL";
}

// ── the client ───────────────────────────────────────────────────────────────

export interface DaemonClientOptions {
  /** explicit http base URL (e.g. the CLI's configured port) — defaults to
   * http://127.0.0.1:${SHOWRUNNER_PORT ?? 44100} */
  baseUrl?: string;
}

export class DaemonClient {
  private readonly baseUrl: string;

  constructor(opts: DaemonClientOptions = {}) {
    const base = opts.baseUrl ?? `http://127.0.0.1:${process.env.SHOWRUNNER_PORT ?? 44100}`;
    this.baseUrl = base.replace(/\/+$/, "");
  }

  // ── the one low-level verb; every method is a typed wrapper ───────────

  private request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const req = request(
        {
          hostname: url.hostname,
          port: url.port === "" ? undefined : url.port,
          method,
          path: url.pathname + url.search,
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

  // ── read endpoints ──────────────────────────────────────────────────

  /** GET /api/health — daemon up probe. */
  health(): Promise<{ ok: boolean }> {
    return this.typed("GET", "/api/health");
  }

  /** GET /api/status — health + pool utilization + run status counts (T07). */
  status(): Promise<DaemonStatus> {
    return this.typed("GET", "/api/status");
  }

  /** POST /api/shutdown — ask the daemon to stop itself gracefully (the CLI's
   * `stop` verb). Replaces the old file-based SIGTERM dance. */
  shutdown(): Promise<{ ok: boolean }> {
    return this.typed("POST", "/api/shutdown");
  }

  /** GET /api/stats — the all-time landing KPI/chart aggregate. */
  getStats(): Promise<RunStats> {
    return this.typed("GET", "/api/stats");
  }

  /** GET /api/runs — the run list, each with queue position. */
  listRuns(): Promise<{ runs: RunListItem[] }> {
    return this.typed("GET", "/api/runs");
  }

  /** GET /api/runs/:id — run detail: phases, spend, envelope count, sessions. */
  getRun(runId: string): Promise<RunDetail> {
    return this.typed("GET", `/api/runs/${encodeURIComponent(runId)}`);
  }

  /**
   * GET /api/runs/:id/events?cursor=&limit= — the cursor query. `cursor`
   * is the last rowid seen (0 for the start); `limit` defaults to 500 (capped
   * at 500). The response's next_cursor is the cursor for the next poll.
   */
  getEvents(runId: string, opts: { cursor?: number; limit?: number } = {}): Promise<EventsPage> {
    const q = new URLSearchParams();
    if (opts.cursor !== undefined) q.set("cursor", String(opts.cursor));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.typed("GET", `/api/runs/${encodeURIComponent(runId)}/events${qs === "" ? "" : `?${qs}`}`);
  }

  /** GET /api/runs/:id/phases/:phase/envelopes — a phase's envelope history. */
  getPhaseEnvelopes(runId: string, phase: string): Promise<PhaseEnvelopes> {
    return this.typed("GET", `/api/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phase)}/envelopes`);
  }

  /** GET /api/runs/:id/phases/:phase/gates — gate results incl. overridden. */
  getPhaseGates(runId: string, phase: string): Promise<PhaseGates> {
    return this.typed("GET", `/api/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phase)}/gates`);
  }

  /** GET /api/runs/:id/phases/:phase/outputs — what the agent wrote in the
   * phase's outputs dir: the file listing + FINDINGS.md content. */
  getPhaseOutputs(runId: string, phase: string): Promise<PhaseOutputs> {
    return this.typed("GET", `/api/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phase)}/outputs`);
  }

  /** GET /api/runs/:id/spend — per-phase spend breakdown (+ estimated markers). */
  getSpend(runId: string): Promise<SpendBreakdown> {
    return this.typed("GET", `/api/runs/${encodeURIComponent(runId)}/spend`);
  }

  /** GET /api/runs/:id/timeline (R3) — per-visit segments derived from the
   * run's phase_start/phase_end events, in blueprint order. */
  getTimeline(runId: string): Promise<TimelineView> {
    return this.typed("GET", `/api/runs/${encodeURIComponent(runId)}/timeline`);
  }

  /** GET /api/runs/:id/raw?lines=N — the raw_output.jsonl tail (drill-in feed). */
  getRaw(runId: string, opts: { lines?: number } = {}): Promise<RawTail> {
    const q = opts.lines !== undefined ? `?lines=${Math.max(1, Math.floor(opts.lines))}` : "";
    return this.typed("GET", `/api/runs/${encodeURIComponent(runId)}/raw${q}`);
  }

  /** GET /api/runs/:id/pause — the pause viewer (T04; not in the API table). */
  pause(runId: string): Promise<PauseView> {
    return this.typed("GET", `/api/runs/${encodeURIComponent(runId)}/pause`);
  }

  // ── control endpoints ───────────────────────────────────────────────

  /** POST /api/runs — submit a blueprint module or an observation fixture. */
  submitRun(body: SubmitRunBody): Promise<SubmitRunResult> {
    return this.typed("POST", "/api/runs", body);
  }

  /** POST /api/runs/:id/resume — continue an interrupted run from its last completed phase. */
  resume(runId: string, body?: { by?: string }): Promise<ControlResult> {
    return this.typed("POST", `/api/runs/${encodeURIComponent(runId)}/resume`, body ?? {});
  }

  /** POST /api/runs/:id/fail — fail the run and kill its children. */
  failRun(runId: string, body?: { by?: string }): Promise<ControlResult> {
    return this.typed("POST", `/api/runs/${encodeURIComponent(runId)}/fail`, body ?? {});
  }

  /** POST /api/sessions/:pi_session_id/steer — steer the live session by pi session id. */
  steerSession(piSessionId: string, message: string, by?: string): Promise<ControlResult> {
    return this.typed("POST", `/api/sessions/${encodeURIComponent(piSessionId)}/steer`, { message, ...(by ? { by } : {}) });
  }

  /** POST /api/runs/:id/steer — run-keyed steer (T04; not in the API table). */
  steerRun(runId: string, message: string, by?: string): Promise<ControlResult> {
    return this.typed("POST", `/api/runs/${encodeURIComponent(runId)}/steer`, { message, ...(by ? { by } : {}) });
  }

  /** POST /api/runs/:id/approve — approve a require_approval pause. */
  approve(runId: string, body?: { by?: string }): Promise<ControlResult> {
    return this.typed("POST", `/api/runs/${encodeURIComponent(runId)}/approve`, body ?? {});
  }

  /** POST /api/runs/:id/phases/:phase/override — override a failed gate (audited). */
  overrideGate(runId: string, phase: string, body: { gate: string; reason: string; by?: string }): Promise<ControlResult> {
    return this.typed(
      "POST",
      `/api/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phase)}/override`,
      body,
    );
  }

  /** POST /api/runs/:id/phases/:phase/restart-fresh — new pi session, same config. */
  restartFresh(runId: string, phase: string, body?: { by?: string }): Promise<ControlResult> {
    return this.typed(
      "POST",
      `/api/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phase)}/restart-fresh`,
      body ?? {},
    );
  }
}

// SubmitRunBody is re-exported from contract.ts above.

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return fallback;
}
