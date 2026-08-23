import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { GateResultWithOverride, PhaseRow } from "../../../../../daemon/db.ts";
import type { RawTail } from "../../../../../daemon/client.ts";
import type { SnapshotPhase } from "../../../lib/blueprint-snapshot.ts";
import { routes } from "../../../routes.ts";
import { fmtRunId } from "../../../ui/format.ts";
import { ConfigCard } from "../../../ui/phase-drill-in/config-card.tsx";
import { EnvelopeCard } from "../../../ui/phase-drill-in/envelope-card.tsx";
import { GatesCard } from "../../../ui/phase-drill-in/gates-card.tsx";
import { NeedsReviewBanner } from "../../../ui/needs-review-banner.tsx";
import { OutputCard } from "../../../ui/phase-drill-in/output-card.tsx";
import { SpendCard } from "../../../ui/phase-drill-in/spend-card.tsx";
import { Document } from "../../document.tsx";
import type { EnvelopeRow } from "../../../../../daemon/db.ts";

/**
 * The phase drill-in page (spec §16.8): one stacked card per surface —
 * CONFIG (from the §13.3 blueprint snapshot), ENVELOPE (accepted + full
 * attempt history), GATES (pass/fail + override badges), SPEND (per-phase
 * tokens + USD), OUTPUT (raw_output.jsonl tail). Read-only: no mutation
 * controls on this page (the override button is T10b's ticket — the override
 * DATA is rendered as badges).
 */

export interface DrillInPageProps {
  runId: string;
  /** run-level context from the detail endpoint */
  run: { blueprint: string; status: string; needs_review: number; cwd: string };
  /** the phase's row from the run detail */
  phase: PhaseRow;
  /** the snapshot's phase (agent config), or null when no snapshot */
  snapshotPhase: SnapshotPhase | null;
  /** dirname of the snapshot's blueprint module (context resolution fallback) */
  snapshotModuleDir: string | null;
  envelopes: EnvelopeRow[];
  /** the phase's outputs/ dir: files the agent wrote + FINDINGS.md content */
  outputs: { files: string[]; findingsMd: string | null };
  gates: GateResultWithOverride[];
  spend: {
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    spendUsd: number;
    estimatedUsd: number;
    /** true when the spend sweep hit its safety cap — token totals are partial */
    truncated: boolean;
  };
  raw: RawTail;
}

export function DrillInPage(handle: Handle<DrillInPageProps>) {
  return () => {
    const { runId, run, phase, snapshotPhase, snapshotModuleDir, envelopes, outputs, gates, spend, raw } =
      handle.props;

    return (
      <Document title={`Showrunner · ${phase.name} · ${run.blueprint}`}>
        <main mix={pageStyle}>
          <header mix={headerStyle}>
            <nav mix={breadcrumbStyle} aria-label="breadcrumb">
              <a href={routes.home.href()} mix={crumbLinkStyle}>
                ‹ runs
              </a>
              <span mix={crumbSepStyle}>›</span>
              <a href={routes.runs.show.href({ runId })} mix={crumbLinkStyle} title={`run ${fmtRunId(runId)}`}>
                {fmtRunId(runId)}
              </a>
              <span mix={crumbSepStyle}>›</span>
              <span mix={crumbCurrentStyle}>{phase.name}</span>
            </nav>
            <h1 mix={titleStyle}>
              {phase.name}
              <span mix={subtitleStyle}>
                agent: {phase.agent} ·{" "}
                <span title="number of times this phase has been executed (resumed phases are re-visited)">
                  {phase.visits} {phase.visits === 1 ? "visit" : "visits"}
                </span>{" "}
                ·{" "}
                <span title="number of corrections (re-prompts) issued against this phase">
                  {phase.corrections} {phase.corrections === 1 ? "correction" : "corrections"}
                </span>{" "}
                · {phase.status.replace("_", " ")}
              </span>
            </h1>
            <span mix={runIdStyle}>{fmtRunId(runId)}</span>
          </header>

          {run.needs_review !== 0 ? <NeedsReviewBanner /> : null}

          <div mix={cardsStyle}>
              <ConfigCard
                agentName={phase.agent}
                snapshotPhase={snapshotPhase}
                cwd={run.cwd}
                moduleDir={snapshotModuleDir}
              />
              <EnvelopeCard envelopes={envelopes} outputs={outputs} />
              <GatesCard gates={gates} />
              <SpendCard
                tokensIn={spend.tokensIn}
                tokensOut={spend.tokensOut}
                cacheRead={spend.cacheRead}
                cacheWrite={spend.cacheWrite}
                spendUsd={spend.spendUsd}
                estimatedUsd={spend.estimatedUsd}
                truncated={spend.truncated}
              />
              <OutputCard raw={raw} />
            </div>
        </main>
      </Document>
    );
  };
}

/** §16.10 missing phase/run — 404 with a back-link to the run list. */
export interface NotFoundPageProps {
  /** the missing run id (when the run itself was not found) */
  runId: string;
  /** the missing phase name (when the run exists but the phase does not) */
  phase?: string;
  /** the run's blueprint (for the breadcrumb when the run exists) */
  blueprint?: string;
}

export function NotFoundPage(handle: Handle<NotFoundPageProps>) {
  return () => (
    <Document title={`Showrunner · not found`}>
      <main mix={pageStyle}>
        <nav mix={breadcrumbStyle} aria-label="breadcrumb">
          <a href={routes.home.href()} mix={crumbLinkStyle}>
            ‹ runs
          </a>
          {handle.props.blueprint !== undefined ? (
            <>
              <span mix={crumbSepStyle}>›</span>
              <a href={routes.runs.show.href({ runId: handle.props.runId })} mix={crumbLinkStyle}>
                {fmtRunId(handle.props.runId)}
              </a>
            </>
          ) : null}
        </nav>
        <h1 mix={titleStyle}>not found</h1>
        <p mix={notFoundTextStyle} data-state="not-found">
          {handle.props.phase !== undefined
            ? `phase "${handle.props.phase}" not found in run ${fmtRunId(handle.props.runId)}`
            : `run ${handle.props.runId} not found`}
          {" — "}
          <a href={routes.home.href()} mix={crumbLinkStyle}>
            back to runs
          </a>
        </p>
      </main>
    </Document>
  );
}

const pageStyle = css({
  maxWidth: "60rem",
  margin: "0 auto",
  padding: "2rem 1.5rem",
  display: "grid",
  gap: "1.25rem",
});

const headerStyle = css({
  display: "grid",
  gap: "0.4rem",
});

const breadcrumbStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  fontSize: "12px",
});

const crumbLinkStyle = css({
  color: "#3573f6",
  textDecoration: "none",
  "&:hover": { textDecoration: "underline" },
});

const crumbSepStyle = css({
  color: "#9ca3af",
});

const crumbCurrentStyle = css({
  color: "#111827",
  fontWeight: 700,
});

const titleStyle = css({
  margin: 0,
  fontSize: "18px",
  fontWeight: 800,
  letterSpacing: "-0.02em",
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem",
  flexWrap: "wrap",
});

const subtitleStyle = css({
  fontSize: "13px",
  fontWeight: 500,
  color: "#6b7280",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const runIdStyle = css({
  fontSize: "11px",
  color: "#9ca3af",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const cardsStyle = css({
  display: "grid",
  gap: "1rem",
});

const notFoundTextStyle = css({
  margin: 0,
  color: "#6b7280",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "13px",
});
