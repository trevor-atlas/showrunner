import { dirname } from "node:path";

import { createController } from "remix/router";

import type { EventRow } from "@showrunner/core";

import { readBlueprintSnapshot } from "../../../lib/blueprint-snapshot.ts";
import {
  daemonAddress,
  DaemonUnreachable,
  getPhaseEnvelopes,
  getPhaseGates,
  getRaw,
  getRunDetail,
  getRunEvents,
  getSpend,
} from "../../../lib/daemon.ts";
import { routes } from "../../../routes.ts";
import { DrillInPage, NotFoundPage } from "./drill-in-page.tsx";

/**
 * Phase drill-in (T11, issue #16) — `/runs/:runId/phases/:phase` (spec §16.8).
 * Server-side only: every surface is fetched from the daemon through the typed
 * §13 client; the browser never talks to the daemon. The CONFIG card reads the
 * §13.3 blueprint snapshot file (there is no daemon endpoint for it) — what
 * actually ran, never the live module.
 *
 * Missing run OR missing phase → 404 with a back-link (§16.10). A down daemon
 * renders the shell with the DaemonDownBanner instead of 500ing. Read-only
 * page: no mutation controls (the override control is T10b's ticket; the
 * override DATA renders as badges here).
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
        if (err instanceof DaemonUnreachable) {
          return context.render(
            <DrillInPage
              runId={runId}
              run={{ blueprint: "", status: "", needs_review: 0, cwd: "" }}
              phase={{
                id: "",
                run_id: runId,
                name: phaseName,
                agent: "",
                status: "",
                visits: 0,
                corrections: 0,
                budget: 0,
                spend_usd: 0,
                started_at: null,
                ended_at: null,
              }}
              snapshotPhase={null}
              snapshotModuleDir={null}
              envelopes={[]}
              gates={[]}
              spend={emptySpend()}
              raw={{ run_id: runId, raw: "", line_count: 0, truncated: false }}
              daemonDown={true}
              daemonAddress={daemonAddress()}
            />,
          );
        }
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
      const [envelopes, gates, spend, raw, events, snapshot] = await Promise.all([
        getPhaseEnvelopes(runId, phaseName),
        getPhaseGates(runId, phaseName),
        getSpend(runId),
        getRaw(runId, { lines: RAW_TAIL_LINES }),
        collectSpendEvents(runId),
        readBlueprintSnapshot(runId),
      ]);

      const snapshotPhase = snapshot.doc?.phases.find((p) => p.name === phaseName) ?? null;
      const snapshotModuleDir = snapshot.doc?.module !== null && snapshot.doc?.module !== undefined && snapshot.doc?.module !== "" ? dirname(snapshot.doc.module) : null;

      const spendPhase = spend.phases.find((p) => p.id === phase.id);
      const tokens = sumPhaseSpendTokens(events, phase.id);

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
          gates={gates.gates}
          spend={{
            tokensIn: tokens.tokens_in,
            tokensOut: tokens.tokens_out,
            cacheRead: tokens.cache_read,
            cacheWrite: tokens.cache_write,
            spendUsd: spendPhase?.spend_usd ?? 0,
            estimatedUsd: spendPhase?.estimated_spend_usd ?? 0,
          }}
          raw={raw}
          daemonDown={false}
          daemonAddress={daemonAddress()}
        />,
      );
    },
  },
});

/** The raw tail size for the OUTPUT card (the endpoint caps at 5000). */
const RAW_TAIL_LINES = 100;

/**
 * Collect the run's §6 #12 spend events (all pages of the §4.3 cursor query).
 * Token totals per phase come from these deltas — the spend endpoint only
 * breaks down USD, not tokens (§13.1).
 */
async function collectSpendEvents(runId: string): Promise<EventRow[]> {
  const out: EventRow[] = [];
  let cursor: number | undefined = undefined;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const res = await getRunEvents(runId, { cursor, limit: 500 });
    for (const ev of res.events) {
      if (ev.type === "spend") out.push(ev);
    }
    if (res.events.length < 500) break;
    cursor = res.next_cursor;
  }
  return out;
}

const MAX_EVENT_PAGES = 10;

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

function emptySpend(): { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; spendUsd: number; estimatedUsd: number } {
  return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, spendUsd: 0, estimatedUsd: 0 };
}

/** A §13 client 404 (run/phase missing) — the drill-in's "missing" case. */
function isApi404(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ApiError" &&
    (err as { status?: number }).status === 404
  );
}
