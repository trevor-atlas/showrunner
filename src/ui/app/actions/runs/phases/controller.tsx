import { dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";
import { parseSafe } from "remix/data-schema";

import type { EventRow } from "../../../../../core/index.ts";

import { readBlueprintSnapshot } from "../../../lib/blueprint-snapshot.ts";
import { resolveDataDir, runDirFor } from "../../../../../core/index.ts";
import { outputsDirFor } from "../../../../../daemon/handoff.ts";
import {
  controlOverrideGate,
  controlRestartFresh,
  getPhaseEnvelopes,
  getPhaseGates,
  getRaw,
  getRunDetail,
  getRunEvents,
  getSpend,
  isApiError,
} from "../../../lib/daemon.ts";
import { routes } from "../../../routes.ts";
import { apiControlError, overrideFormSchema, validationError } from "../control-forms.ts";
import { renderRunDetail } from "../controller.tsx";
import { DrillInPage, NotFoundPage } from "./drill-in-page.tsx";

/**
 * Phase drill-in (T11, issue #16) — `/runs/:runId/phases/:phase` (spec §16.8).
 * Server-side only: every surface is fetched from the daemon through the typed
 * §13 client; the browser never talks to the daemon. The CONFIG card reads the
 * §13.3 blueprint snapshot file (there is no daemon endpoint for it) — what
 * actually ran, never the live module.
 *
 * Missing run OR missing phase → 404 with a back-link (§16.10). Read-only
 * page: no mutation controls (the override control is T10b's ticket; the
 * override DATA renders as badges here).
 *
 * T10b adds the phase-scoped control VERBS (the pause menu's override gate +
 * restart-fresh): the forms live on the RUN DETAIL page (§16.9) and post
 * here. Each validates with data-schema (no zod in the UI), posts to the
 * §13.2 daemon endpoint server-side, and on success redirects (303) to the
 * fresh run detail page — the re-render comes from daemon state. A validation
 * failure or a daemon 409/4xx re-renders run detail with the error on the
 * form that submitted it (the override/restart forms are run-detail mounts).
 */
export default createController(routes.runs.phases, {
  actions: {
    async show(context) {
      const runId = context.params.runId;
      const phaseName = context.params.phase;

      let detail;
      try {
        detail = await getRunDetail(runId);
      } catch (err) {
        if (isApi404(err)) {
          return context.render(<NotFoundPage runId={runId} />, { status: 404 });
        }
        throw err;
      }

      const phase = detail.phases.find((p) => p.name === phaseName);
      if (phase === undefined) {
        return context.render(
          <NotFoundPage runId={runId} phase={phaseName} blueprint={detail.run.blueprint} />,
          { status: 404 },
        );
      }

      // everything after the 404 checks is independent — fetch in parallel
      const [envelopes, gates, spend, raw, spendEvents, snapshot] = await Promise.all([
        getPhaseEnvelopes(runId, phaseName),
        getPhaseGates(runId, phaseName),
        getSpend(runId),
        getRaw(runId, { lines: RAW_TAIL_LINES }),
        collectSpendEvents(runId),
        readBlueprintSnapshot(runId),
      ]);

      const snapshotPhase = snapshot.doc?.phases.find((p) => p.name === phaseName) ?? null;
      const snapshotModuleDir = snapshot.doc?.module !== null && snapshot.doc?.module !== undefined && snapshot.doc?.module !== "" ? dirname(snapshot.doc.module) : null;

      // the phase's outputs/ dir — what the agent actually wrote (for the
      // ENVELOPE card's artifact existence check + FINDINGS.md content). The
      // workspace lives under the RUN's record dir ({data_dir}/runs/<run_id>/<phase>/outputs),
      // never the run cwd (§9.1).
      const runDir = runDirFor(resolveDataDir(), runId);
      const outputs = readOutputsDir(runDir, phaseName);

      const spendPhase = spend.phases.find((p) => p.id === phase.id);
      const tokens = sumPhaseSpendTokens(spendEvents.events, phase.id);

      return context.render(
        <DrillInPage
          runId={runId}
          run={{
            blueprint: detail.run.blueprint,
            status: detail.run.status,
            needs_review: detail.run.needs_review,
            cwd: detail.run.cwd,
          }}
          phase={phase}
          snapshotPhase={snapshotPhase}
          snapshotModuleDir={snapshotModuleDir}
          envelopes={envelopes.envelopes}
          outputs={outputs}
          gates={gates.gates}
          spend={{
            tokensIn: tokens.tokens_in,
            tokensOut: tokens.tokens_out,
            cacheRead: tokens.cache_read,
            cacheWrite: tokens.cache_write,
            spendUsd: spendPhase?.spend_usd ?? 0,
            estimatedUsd: spendPhase?.estimated_spend_usd ?? 0,
            truncated: spendEvents.truncated,
          }}
          raw={raw}
        />,
      );
    },
    /**
     * The envelopes.json proxy (R5) — GET .../phases/:phase/envelopes.json
     * through the §13 api core in-process, returned as JSON (mirrors the
     * events.json cursor proxy pattern: the browser never talks to the
     * daemon). The run-detail panel fetches a selected phase's envelope
     * history here lazily on selection; the initial selection's data is
     * server-rendered by renderRunDetail instead.
     */
    async envelopes(context) {
      const runId = context.params.runId;
      const phase = context.params.phase;
      try {
        const envelopes = await getPhaseEnvelopes(runId, phase);
        return Response.json(envelopes);
      } catch (err) {
        if (isApi404(err)) {
          return Response.json({ error: `run ${runId} phase ${phase} not found` }, { status: 404 });
        }
        throw err;
      }
    },

    /** The gates.json proxy (R5) — mirror of `envelopes`, for gate results. */
    async gates(context) {
      const runId = context.params.runId;
      const phase = context.params.phase;
      try {
        const gates = await getPhaseGates(runId, phase);
        return Response.json(gates);
      } catch (err) {
        if (isApi404(err)) {
          return Response.json({ error: `run ${runId} phase ${phase} not found` }, { status: 404 });
        }
        throw err;
      }
    },

    /** §16.9 override — POST .../phases/:phase/override → the daemon §13.2 verb. */
    async override(context) {
      const runId = context.params.runId;
      const phase = context.params.phase;
      const formData = await context.request.formData();
      const parsed = parseSafe(overrideFormSchema, formData);
      if (!parsed.success) {
        return renderRunDetail(context, runId, validationError("override", parsed.issues), 400);
      }
      try {
        await controlOverrideGate(runId, phase, parsed.value.gate, parsed.value.reason);
      } catch (err) {
        if (isApiError(err)) {
          return renderRunDetail(context, runId, apiControlError("override", err), 400);
        }
        throw err;
      }
      return redirect(routes.runs.show.href({ runId }), 303);
    },

    /** §16.9 restart phase fresh — POST .../phases/:phase/restart-fresh (no data). */
    async restart(context) {
      const runId = context.params.runId;
      const phase = context.params.phase;
      try {
        await controlRestartFresh(runId, phase);
      } catch (err) {
        if (isApiError(err)) {
          return renderRunDetail(context, runId, apiControlError("restart", err), 400);
        }
        throw err;
      }
      return redirect(routes.runs.show.href({ runId }), 303);
    },
  },
});

/** The raw tail size for the OUTPUT card (the endpoint caps at 5000). */
const RAW_TAIL_LINES = 100;

/**
 * Collect the run's §6 #12 spend events by sweeping the §4.3 cursor query to
 * the TRUE tail (polish, T10b): the drill-in token totals are honest for very
 * long runs (>5000 spend events) instead of silently capping at 10×500. A
 * hard safety cap (200 pages = 100k events) still bounds pathological runs,
 * and `truncated` reports when that cap was hit so the card can say so.
 */
async function collectSpendEvents(
  runId: string,
): Promise<{ events: EventRow[]; truncated: boolean }> {
  const out: EventRow[] = [];
  let cursor: number | undefined = undefined;
  let truncated = false;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const res = await getRunEvents(runId, { cursor, limit: 500 });
    for (const ev of res.events) {
      if (ev.type === "spend") out.push(ev);
    }
    if (res.events.length < 500) {
      // a short page is the true tail — everything collected, nothing dropped
      break;
    }
    if (page === MAX_EVENT_PAGES - 1) {
      // the final page was FULL — more events may exist past the safety cap
      truncated = true;
    }
    cursor = res.next_cursor;
  }
  return { events: out, truncated };
}

/** Safety cap on the spend sweep: 200 × 500 = 100k events. */
const MAX_EVENT_PAGES = 200;

/** Sum the spend-event token deltas for one phase (phase_id filter). */
function sumPhaseSpendTokens(events: readonly EventRow[], phaseId: string): {
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
} {
  let tokens_in = 0;
  let tokens_out = 0;
  let cache_read = 0;
  let cache_write = 0;
  for (const ev of events) {
    if (ev.phase_id !== phaseId) continue;
    const data = ev.data as {
      tokens_in?: unknown;
      tokens_out?: unknown;
      cache_read?: unknown;
      cache_write?: unknown;
    };
    tokens_in += num(data.tokens_in);
    tokens_out += num(data.tokens_out);
    cache_read += num(data.cache_read);
    cache_write += num(data.cache_write);
  }
  return { tokens_in, tokens_out, cache_read, cache_write };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Read the phase's outputs/ dir: the files the agent actually wrote (for the
 * ENVELOPE card's artifact-existence check) and FINDINGS.md when the agent
 * wrote one (rendered readably). Absent dir → empty listing; unreadable files
 * are skipped (best effort — this is display, not validation).
 */
function readOutputsDir(
  runDir: string,
  phaseName: string,
): { files: string[]; findingsMd: string | null } {
  const dir = outputsDirFor(runDir, phaseName);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => {
      try {
        return statSync(join(dir, f)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return { files: [], findingsMd: null };
  }
  const findingsFile = files.find((f) => f.toLowerCase() === "findings.md");
  let findingsMd: string | null = null;
  if (findingsFile !== undefined) {
    try {
      const full = join(dir, findingsFile);
      if (existsSync(full)) findingsMd = readFileSync(full, "utf8");
    } catch {
      findingsMd = null;
    }
  }
  return { files, findingsMd };
}

/** A §13 ApiError 404 (run/phase missing) — the drill-in's "missing" case. */
function isApi404(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ApiError" &&
    (err as { status?: number }).status === 404
  );
}
