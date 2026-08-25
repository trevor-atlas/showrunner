import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";
import { parseSafe } from "remix/data-schema";

import { controlOverrideGate, controlRestartFresh, getPhaseRecord, isApiError } from "../../../lib/daemon.ts";
import type { PhaseRecordModel } from "../../../services/phase-record.ts";
import { routes } from "../../../routes.ts";
import { apiControlError, overrideFormSchema, validationError } from "../control-forms.ts";
import { renderRunDetail } from "../controller.tsx";

/**
 * Phase data group (issue #16 → folded by #41) — the phase-scoped JSON
 * proxies (envelopes/gates + the four card proxies) and the control VERBS
 * (override gate + restart-fresh). Server-side only: every surface is fetched
 * from the daemon (or the shared lib/phase-data.ts gather module) through the
 * typed client; the browser never talks to the daemon.
 *
 * Issue #41 folded the standalone drill-in PAGE into the run page: the
 * `GET /runs/:runId/phases/:phase` HTML route is gone (no redirect — the run
 * page renders the phase record as a card grid on selection). The JSON proxies
 * below stay: the run page's live region fetches a selected phase's data
 * through them lazily; the initial selection is server-rendered by
 * renderRunDetail from the same gather module.
 *
 * The control VERBS (the pause menu's override gate + restart-fresh): the
 * forms live on the RUN DETAIL page and post here. Each validates with
 * data-schema (no zod in the UI), posts to the daemon endpoint server-side,
 * and on success redirects (303) to the fresh run detail page — the re-render
 * comes from daemon state. A validation failure or a daemon 409/4xx re-renders
 * run detail with the error on the form that submitted it.
 */
export default createController(routes.runs.phases, {
  actions: {
    /**
     * The envelopes.json proxy (R5) — GET .../phases/:phase/envelopes.json
     * through the api core in-process, returned as JSON (mirrors the
     * events.json cursor proxy pattern: the browser never talks to the
     * daemon). The run-detail panel fetches a selected phase's envelope
     * history here lazily on selection; the initial selection's data is
     * server-rendered by renderRunDetail instead.
     */
    async envelopes(context) {
      const record = loadPhaseRecord(context.params.runId, context.params.phase);
      if (record === null) return notFoundJson(context.params.runId, context.params.phase);
      return Response.json(record.envelopes);
    },

    /** The gates.json proxy (R5) — mirror of `envelopes`, for gate results. */
    async gates(context) {
      const record = loadPhaseRecord(context.params.runId, context.params.phase);
      if (record === null) return notFoundJson(context.params.runId, context.params.phase);
      return Response.json(record.gates);
    },

    /**
     * The snapshot.json proxy (#35) — the CONFIG card's data: the phase's
     * blueprint-snapshot config with its context entries pre-resolved to
     * {raw, kind, entry} (the card never touches disk). Ghost run/phase → 404
     * JSON; a real run with no snapshot file → 200 with phase: null.
     */
    async snapshot(context) {
      const record = loadPhaseRecord(context.params.runId, context.params.phase);
      if (record === null) return notFoundJson(context.params.runId, context.params.phase);
      return Response.json(record.snapshot);
    },

    /** The inputs.json proxy (#35) — the materialized predecessor handoff. */
    async inputs(context) {
      const record = loadPhaseRecord(context.params.runId, context.params.phase);
      if (record === null) return notFoundJson(context.params.runId, context.params.phase);
      return Response.json(record.inputs);
    },

    /** The outputs.json proxy (#35) — the phase's outputs/ dir + FINDINGS.md. */
    async outputs(context) {
      const record = loadPhaseRecord(context.params.runId, context.params.phase);
      if (record === null) return notFoundJson(context.params.runId, context.params.phase);
      return Response.json(record.outputs);
    },

    /** The spend.json proxy (#35) — per-phase tokens/USD off the exact SQL SUM. */
    async spend(context) {
      const record = loadPhaseRecord(context.params.runId, context.params.phase);
      if (record === null) return notFoundJson(context.params.runId, context.params.phase);
      return Response.json(record.spend);
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

/**
 * The single phase read behind every data proxy (#48): assemble the phase
 * record once through the view-model, then each proxy slices the section it
 * serves. `null` (ghost run or ghost phase) maps to the proxies' 404 JSON.
 *
 * `dataDir` is `resolveDataDir()` — the same process-global the model's
 * snapshot reader (readBlueprintSnapshot) uses internally, so inputs/outputs
 * and the snapshot are scoped to ONE data dir, never spliced across two.
 */
function loadPhaseRecord(runId: string, phaseName: string): PhaseRecordModel | null {
  return getPhaseRecord(runId, phaseName);
}

/** The shared 404 JSON body for the data proxies (ghost run or phase). */
function notFoundJson(runId: string, phase: string): Response {
  return Response.json({ error: `run ${runId} phase ${phase} not found` }, { status: 404 });
}
