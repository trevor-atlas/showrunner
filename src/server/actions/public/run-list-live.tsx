import { clientEntry, css, on, type Handle, type SerializableObject, type SerializableProps } from "remix/ui";

import type { RunListItem } from "../../contract.ts";
import { routes } from "../../routes.ts";
import { IconButton } from "../../ui/public/components/icon-button.tsx";
import { EmptyState } from "../../ui/public/empty-state.tsx";
import { fmtDuration, fmtMoney, fmtRunId, fmtStartedAt } from "../../ui/public/format.ts";
import {
  distinctBlueprints,
  durationMs,
  visibleRows,
  type ListQuery,
  type SortDir,
  type SortKey,
} from "../../ui/public/list-model.ts";
import { StatusPill, runStatus } from "../../ui/public/status-pill.tsx";
import { startLiveSnapshot, type LiveApplyOutcome } from "./live-snapshot.ts";

/**
 * The landing run list, LIVE (issue #39). Server-rendered once from the
 * in-process listRuns snapshot (SSR renders the table exactly as before, so
 * the run-list.test.ts pins hold), then the browser SUBSCRIBES to the global
 * ledger change stream (`GET /live.sse`) while the page is open: every "runs
 * ledger changed" wake-up refetches the `/runs-list.json` snapshot proxy,
 * replaces the runs array, and re-renders. The manual refresh button is gone —
 * the list is push-live.
 *
 * Sort + filter + search state live in SETUP scope, not the URL (a refetch
 * never resets them) — EXCEPT the status filter, whose selection is also
 * mirrored into `?status=` via history.replaceState so the deep link stays
 * shareable (the same pattern the run-detail region uses for `?phase=`). The
 * SSR filter arrives via `filter` and seeds the status state, so `?status=`
 * still narrows the first paint; the full unfiltered runs ride in `runs` so
 * the toolbar can re-filter live without a round-trip.
 *
 * The SSE→refetch transport is the shared startLiveSnapshot adapter (#57): the
 * region hands it the global change-stream href + an `apply` that refetches the
 * snapshot proxy and swaps the runs array; the adapter owns WHEN (coalescing +
 * the in-flight guard so a wake-up mid-refetch schedules EXACTLY ONE trailing
 * rerun — the last ledger change is never lost). This is a single-snapshot
 * region: `apply` always returns "applied" (a transient failure keeps the last
 * snapshot; the stream never stops).
 *
 * The browser NEVER talks to the server: it only refetches the rendered
 * snapshot proxy (the iron convention).
 */

/** The client-entry boundary widens the server wire type with the
 * SerializableProps index signature — the values are plain JSON (exactly what
 * the /runs-list.json proxy returns), so the widening is structural only (the
 * same `as unknown as` the run-detail region uses). */
export type SerializableRunListItem = RunListItem & SerializableObject;

export interface RunListLiveProps extends SerializableProps {
  /** the initial run snapshot (UNFILTERED — the entry applies the filter at
   * render); replaced wholesale by every /runs-list.json refetch */
  runs: SerializableRunListItem[];
  /** filter options — "all" then every RUN_STATUS */
  statuses: string[];
  /** the SSR status filter (from ?status=), "all" when unset — seeds the
   * status-filter state */
  filter: string;
  /** the /runs-list.json snapshot proxy href (routes.homeRuns.href()) */
  runsHref: string;
}

export const RunListLive = clientEntry(
  import.meta.url,
  function RunListLive(handle: Handle<RunListLiveProps>) {
    // ── setup scope — runs once (also server-side during SSR) ──────────────
    let runs: RunListItem[] = [...handle.props.runs];
    let statusFilter: string = handle.props.filter;
    let search = "";
    let blueprintFilter = "all";
    let sortKey: SortKey = "started";
    let sortDir: SortDir = "desc";
    // the run id whose copy button is showing its brief "copied" checkmark
    let copiedId: string | null = null;
    let copyTimer: ReturnType<typeof setTimeout> | null = null;

    /** The adapter's refetch: pull the /runs-list.json snapshot and swap the
     * runs array. Single-snapshot region — a transient failure (non-ok or a
     * fetch/parse throw) keeps the last snapshot and returns "applied" so the
     * stream keeps listening (the next ledger change refetches); there is no
     * terminal/gone branch for the global list. */
    const apply = async (): Promise<LiveApplyOutcome> => {
      try {
        const response = await fetch(handle.props.runsHref);
        if (response.ok) {
          const data = (await response.json()) as { runs: SerializableRunListItem[] };
          runs = data.runs;
          await handle.update();
        }
      } catch {
        // transient fetch/parse failure — keep the last snapshot; the next
        // ledger wake-up refetches
      }
      return "applied";
    };

    /** Copy the FULL run id, flash a ~1.5s checkmark; a clipboard failure is a
     * no-op (no error state). */
    const copy = async (id: string): Promise<void> => {
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) return;
      try {
        await navigator.clipboard.writeText(id);
      } catch {
        return; // no-op on failure
      }
      copiedId = id;
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copiedId = null;
        copyTimer = null;
        void handle.update();
      }, 1500);
      void handle.update();
    };

    /** Status select → update state AND mirror into `?status=` (the shareable
     * deep link) via history.replaceState (no navigation, no form submit). */
    const onStatusChange = (event: Event): void => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      statusFilter = value;
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (value === "all") url.searchParams.delete("status");
        else url.searchParams.set("status", value);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
      void handle.update();
    };

    const onBlueprintChange = (event: Event): void => {
      blueprintFilter = (event.currentTarget as HTMLSelectElement).value;
      void handle.update();
    };

    const onSearchInput = (event: Event): void => {
      search = (event.currentTarget as HTMLInputElement).value;
      void handle.update();
    };

    /** Toggle sort: clicking the active column flips direction; a new column
     * adopts a sensible default (time/number columns start descending). */
    const toggleSort = (key: SortKey): void => {
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = key === "started" || key === "duration" || key === "spend" ? "desc" : "asc";
      }
      void handle.update();
    };

    // The live transport is browser-only (setup also runs during SSR); arm the
    // adapter once and tear it down on abort. The adapter owns the SSE
    // subscription, the coalescing, and the in-flight guard.
    if (typeof window !== "undefined") {
      const live = startLiveSnapshot({ href: routes.live.href(), apply });
      handle.signal.addEventListener("abort", () => {
        live.stop();
        if (copyTimer !== null) {
          clearTimeout(copyTimer);
          copyTimer = null;
        }
      });
    }

    return () => {
      const { statuses } = handle.props;
      const now = Date.now();
      const query: ListQuery = { status: statusFilter, search, blueprint: blueprintFilter, sortKey, sortDir };
      const rows = visibleRows(runs, query, now);
      const blueprints = distinctBlueprints(runs);

      const header = (key: SortKey, label: string) => {
        const active = sortKey === key;
        const indicator = active ? (sortDir === "asc" ? "▲" : "▼") : "";
        return (
          <th
            scope="col"
            aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
          >
            <button type="button" data-sort={key} mix={[sortButtonStyle, on("click", () => toggleSort(key))]}>
              {label}
              <span data-sort-indicator aria-hidden="true" mix={indicatorStyle}>
                {indicator}
              </span>
            </button>
          </th>
        );
      };

      return (
        <div mix={liveStyle}>
          <div mix={toolbarStyle} data-toolbar>
            <label mix={labelStyle}>
              status
              <select name="status" mix={on<HTMLSelectElement>("change", onStatusChange)}>
                {statuses.map((status) => (
                  <option key={status} value={status} selected={status === statusFilter ? true : undefined}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label mix={labelStyle}>
              blueprint
              <select mix={on<HTMLSelectElement>("change", onBlueprintChange)}>
                <option value="all" selected={blueprintFilter === "all" ? true : undefined}>
                  all
                </option>
                {blueprints.map((blueprint) => (
                  <option key={blueprint} value={blueprint} selected={blueprint === blueprintFilter ? true : undefined}>
                    {blueprint}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="search"
              name="search"
              placeholder="search id or blueprint"
              value={search}
              aria-label="search runs"
              mix={[searchStyle, on<HTMLInputElement>("input", onSearchInput)]}
            />
          </div>

          {runs.length === 0 ? (
            <EmptyState />
          ) : (
            <table mix={tableStyle}>
              <thead>
                <tr>
                  {header("run", "RUN")}
                  {header("blueprint", "BLUEPRINT")}
                  {header("status", "STATUS")}
                  {header("started", "STARTED")}
                  {header("duration", "DURATION")}
                  {header("spend", "SPEND")}
                </tr>
              </thead>
              <tbody>
                {rows.map((run) => {
                  const copied = copiedId === run.id;
                  const dur = durationMs(run, now);
                  return (
                    <tr
                      key={run.id}
                      mix={[
                        rowStyle,
                        on("click", (event) => {
                          const anchor = (event.currentTarget as HTMLElement).querySelector(
                            "a[data-run-link]",
                          ) as HTMLAnchorElement | null;
                          anchor?.click();
                        }),
                      ]}
                    >
                      <td>
                        <span mix={runCellStyle}>
                          <a
                            data-run-link
                            href={routes.runs.show.href({ runId: run.id })}
                            mix={[runLinkStyle, on("click", (event) => event.stopPropagation())]}
                          >
                            {fmtRunId(run.id)}
                          </a>
                          <IconButton
                            label={copied ? "run id copied" : "copy run id"}
                            onClick={(event) => {
                              event.stopPropagation();
                              void copy(run.id);
                            }}
                          >
                            {copied ? "✓" : "⧉"}
                          </IconButton>
                        </span>
                      </td>
                      <td mix={monoStyle}>{run.blueprint}</td>
                      <td>
                        <StatusPill status={runStatus(run)} queuePosition={run.queue_position} />
                      </td>
                      <td mix={monoStyle}>{fmtStartedAt(run.started_at)}</td>
                      <td mix={monoStyle}>{dur === null ? "-" : fmtDuration(dur)}</td>
                      <td mix={monoStyle}>{run.queue_position === null ? fmtMoney(run.spend_usd) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      );
    };
  },
);

const liveStyle = css({
  display: "grid",
  gap: "1.25rem",
});

const toolbarStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
});

const labelStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  fontSize: "var(--font-size-sm)",
  color: "var(--muted-foreground)",
  textTransform: "lowercase",
  "& select": {
    font: "inherit",
    padding: "3px 6px",
    borderRadius: "6px",
    border: "1px solid var(--input)",
    background: "var(--card)",
    color: "var(--foreground)",
  },
});

const searchStyle = css({
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  padding: "4px 10px",
  borderRadius: "8px",
  border: "1px solid var(--input)",
  background: "var(--background)",
  color: "var(--foreground)",
  minWidth: "16rem",
  flex: "1 1 12rem",
  "&::placeholder": {
    color: "var(--muted-foreground)",
  },
  "&:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "1px",
  },
});

const tableStyle = css({
  width: "100%",
  borderCollapse: "collapse",
  font: "inherit",
  "& th, & td": {
    textAlign: "left",
    padding: "0.5rem 0.75rem",
    borderBottom: "1px solid var(--border)",
    fontSize: "var(--font-size-md)",
  },
  "& th": {
    fontSize: "var(--font-size-xs)",
    letterSpacing: "0.06em",
    color: "var(--muted-foreground)",
    fontWeight: 700,
  },
  "& tbody tr:hover": {
    background: "var(--muted)",
  },
});

const rowStyle = css({
  cursor: "pointer",
});

const runCellStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
});

const runLinkStyle = css({
  color: "inherit",
  textDecoration: "none",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-md)",
  "&:hover": {
    textDecoration: "underline",
    color: "var(--status-running)",
  },
});

const monoStyle = css({
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-md)",
});

const sortButtonStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  appearance: "none",
  background: "transparent",
  border: 0,
  padding: 0,
  margin: 0,
  cursor: "pointer",
  color: "inherit",
  font: "inherit",
  fontSize: "var(--font-size-xs)",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  "&:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "1px",
  },
});

const indicatorStyle = css({
  display: "inline-flex",
  width: "0.75rem",
  justifyContent: "center",
  color: "var(--muted-foreground)",
});
