import { dirname } from "node:path";

import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";
import { parseSafe } from "remix/data-schema";

import { readBlueprintSnapshot } from "../../../lib/blueprint-snapshot.ts";
import {
  controlOverrideGate,
  controlRestartFresh,
  getPhaseEnvelopes,
  getPhaseGates,
  getPhaseOutputs,
  getRaw,
  getRunDetail,
  getSpend,
  isApiError,
} from "../../../lib/daemon.ts";
import { routes } from "../../../routes.ts";
import { apiControlError, overrideFormSchema, validationError } from "../control-forms.ts";
import { renderRunDetail } from "../controller.tsx";
import { DrillInPage, NotFoundPage } from "./drill-in-page.tsx";

/**
 * Phase drill-in (T11, issue #16) — `/runs/:runId/phases/:phase`.
 * Server-side only: every surface is fetched from the daemon through the typed
 * client; the browser never talks to the daemon. The CONFIG card reads the
 * blueprint snapshot file (there is no daemon endpoint for it) — what
 * actually ran, never the live module.
 *
 * Missing run OR missing phase → 404 with a back-link. Read-only
 * page: no mutation controls (the override control is T10b's ticket; the
 * override DATA renders as badges here).
 *
 * T10b adds the phase-scoped control VERBS (the pause menu's override gate +
 * restart-fresh): the forms live on the RUN DETAIL page and post
 * here. Each validates with data-schema (no zod in the UI), posts to the
 * daemon endpoint server-side, and on success redirects (303) to the
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
      const [envelopes, gates, spend, raw, outputs, snapshot] = await Promise.all([
        getPhaseEnvelopes(runId, phaseName),
        getPhaseGates(runId, phaseName),
        getSpend(runId),
        getRaw(runId, { lines: RAW_TAIL_LINES }),
        getPhaseOutputs(runId, phaseName),
        readBlueprintSnapshot(runId),
      ]);

      const snapshotPhase = snapshot.doc?.phases.find((p) => p.name === phaseName) ?? null;
      const snapshotModuleDir = snapshot.doc?.module !== null && snapshot.doc?.module !== undefined && snapshot.doc?.module !== "" ? dirname(snapshot.doc.module) : null;

      const spendPhase = spend.phases.find((p) => p.id === phase.id);

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
          outputs={{ files: outputs.files, findingsMd: outputs.findings_md }}
          gates={gates.gates}
          spend={{
            // token totals come straight off the spend endpoint — SQL SUM
            // is exact, so there is no sweep cap and no truncated flag
            tokensIn: spendPhase?.tokens_in ?? 0,
            tokensOut: spendPhase?.tokens_out ?? 0,
            cacheRead: spendPhase?.cache_read ?? 0,
            cacheWrite: spendPhase?.cache_write ?? 0,
            spendUsd: spendPhase?.spend_usd ?? 0,
            estimatedUsd: spendPhase?.estimated_spend_usd ?? 0,
          }}
          raw={raw}
        />,
      );
    },
    /**
     * The envelopes.json proxy (R5) — GET .../phases/:phase/envelopes.json
     * through the api core in-process, returned as JSON (mirrors the
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

    /** override — POST .../phases/:phase/override → the daemon verb. */
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

    /** restart phase fresh — POST .../phases/:phase/restart-fresh (no data). */
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

/** A ApiError 404 (run/phase missing) — the drill-in's "missing" case. */
function isApi404(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ApiError" &&
    (err as { status?: number }).status === 404
  );
}
