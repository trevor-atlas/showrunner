import type { Handle } from "remix/ui";
import { css } from "remix/ui";

import type { RunListItem } from "../../../daemon/client.ts";
import { routes } from "../routes.ts";
import { EmptyState } from "../ui/empty-state.tsx";
import { fmtMoney, fmtRunId, fmtStartedAt } from "../ui/format.ts";
import { StatusPill, isRunStatus, type RunStatus } from "../ui/status-pill.tsx";
import { Document } from "./document.tsx";
import { RunFilterForm } from "./public/run-filter-form.tsx";

/**
 * The run list page. Server-rendered: `runs` come from GET /runs
 * through the api core in-process; the browser sees only rendered HTML.
 * Rows link to the run-detail route. The UI and the daemon share one process
 * (merged web server), so there is no "daemon down" shell state.
 */

export interface RunListPageProps {
  runs: RunListItem[];
  /** current status filter ("all" or a RunStatus) */
  filter: string;
  /** filter options — "all" then every RunStatus */
  statuses: string[];
}

export function RunListPage(handle: Handle<RunListPageProps>) {
  return () => {
    const { runs, filter, statuses } = handle.props;
    const visible = filterRuns(runs, filter);
    const title = `Showrunner · runs`;

    return (
      <Document title={title}>
        <main mix={pageStyle}>
          <header mix={headerStyle}>
            <h1 mix={titleStyle}>Showrunner · runs</h1>
            <RunFilterForm
              action={routes.home.href()}
              statuses={statuses}
              current={filter}
            />
          </header>

          {visible.length === 0 ? (
            <EmptyState />
          ) : (
            <table mix={tableStyle}>
              <thead>
                <tr>
                  <th>RUN</th>
                  <th>BLUEPRINT</th>
                  <th>STATUS</th>
                  <th>STARTED</th>
                  <th>SPEND</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <a href={routes.runs.show.href({ runId: run.id })} mix={runLinkStyle}>
                        {fmtRunId(run.id)}
                      </a>
                    </td>
                    <td mix={monoStyle}>{run.blueprint}</td>
                    <td>
                      <StatusPill status={runStatus(run)} queuePosition={run.queue_position} />
                    </td>
                    <td mix={monoStyle}>{fmtStartedAt(run.started_at)}</td>
                    <td mix={monoStyle}>{run.queue_position === null ? fmtMoney(run.spend_usd) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </main>
      </Document>
    );
  };
}

/** The UI-level status of a run row — a pool-queued run is "queued" even
 * though its row status is "running" until the pool starts it (F2). */
export function runStatus(run: { status: string; queue_position?: number | null }): RunStatus {
  if (run.queue_position !== null && run.queue_position !== undefined) return "queued";
  return isRunStatus(run.status) ? run.status : "interrupted";
}

/** Sort started desc, then apply the status filter (v1). */
export function filterRuns(runs: readonly RunListItem[], filter: string): RunListItem[] {
  const sorted = [...runs].sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
  if (filter === "all" || !isRunStatus(filter)) return sorted;
  return sorted.filter((run) => runStatus(run) === filter);
}

const pageStyle = css({
  maxWidth: "60rem",
  margin: "0 auto",
  padding: "2rem 1.5rem",
  display: "grid",
  gap: "1.25rem",
});

const headerStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
});

const titleStyle = css({
  margin: 0,
  fontSize: "18px",
  fontWeight: 800,
  letterSpacing: "-0.02em",
});

const tableStyle = css({
  width: "100%",
  borderCollapse: "collapse",
  font: "inherit",
  "& th, & td": {
    textAlign: "left",
    padding: "0.5rem 0.75rem",
    borderBottom: "1px solid #e5e7eb",
    fontSize: "13px",
  },
  "& th": {
    fontSize: "11px",
    textTransform: "lowercase",
    letterSpacing: "0.06em",
    color: "#6b7280",
    fontWeight: 700,
  },
  "& tbody tr:hover": {
    background: "#f9fafb",
  },
});

const runLinkStyle = css({
  color: "inherit",
  textDecoration: "none",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "13px",
  "&:hover": {
    textDecoration: "underline",
    color: "#3573f6",
  },
});

const monoStyle = css({
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "13px",
});
