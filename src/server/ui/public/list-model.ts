/**
 * The run-list pure model (issue #39). No DOM — the repo's convention (see
 * timeline-model.ts): the clientEntry owns rendering + event wiring, this
 * module owns the filter/sort/derivation logic so it is unit-testable in
 * isolation. Browser-bundle-safe: imports only the moved `runStatus` fold and
 * a type-only daemon import (the same widening the clientEntry uses).
 */

import type { RunListItem } from "../../../daemon/contract.ts";
import { isRunStatus, runStatus } from "./status-pill.tsx";

/** The sortable columns. `run` = run id, `started` = started_at (default). */
export type SortKey = "run" | "blueprint" | "status" | "started" | "duration" | "spend";
export type SortDir = "asc" | "desc";

export interface ListQuery {
  /** "all" or a RunStatus — folds through runStatus() (queued is a pool state) */
  status: string;
  /** free text: run-id PREFIX or blueprint-name SUBSTRING, case-insensitive */
  search: string;
  /** "all" (or "") or an exact blueprint name */
  blueprint: string;
  sortKey: SortKey;
  sortDir: SortDir;
}

/**
 * The duration column source: the phase extent bounded by `now` —
 * `(max_phase_ended_at ?? now) − min_phase_started_at`, so an in-flight run
 * shows a live elapsed bound and there is always a bounding timeline. Null
 * ONLY when no phase has started (min is null) — those sort last.
 */
export function durationMs(run: RunListItem, now: number = Date.now()): number | null {
  if (run.min_phase_started_at === null) return null;
  const start = Date.parse(run.min_phase_started_at);
  const end = run.max_phase_ended_at !== null ? Date.parse(run.max_phase_ended_at) : now;
  return end - start;
}

/** The distinct blueprint names across the runs, sorted — the toolbar's
 * blueprint select options. */
export function distinctBlueprints(runs: readonly RunListItem[]): string[] {
  const names = new Set<string>();
  for (const run of runs) names.add(run.blueprint);
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Filter (status AND search AND blueprint), then sort. Search matches a run-id
 * PREFIX or a blueprint-name SUBSTRING, case-insensitive; the three filters
 * are AND-combined. The default query is started-desc.
 */
export function visibleRows(
  runs: readonly RunListItem[],
  query: ListQuery,
  now: number = Date.now(),
): RunListItem[] {
  const search = query.search.trim().toLowerCase();
  const filtered = runs.filter((run) => {
    if (query.status !== "all" && isRunStatus(query.status) && runStatus(run) !== query.status) return false;
    if (query.blueprint !== "all" && query.blueprint !== "" && run.blueprint !== query.blueprint) return false;
    if (search !== "") {
      const idMatch = run.id.toLowerCase().startsWith(search);
      const blueprintMatch = run.blueprint.toLowerCase().includes(search);
      if (!idMatch && !blueprintMatch) return false;
    }
    return true;
  });
  return sortRows(filtered, query.sortKey, query.sortDir, now);
}

/** Stable secondary order — started-desc then id — so ties are deterministic
 * across sorts and refetches. */
function tieBreak(a: RunListItem, b: RunListItem): number {
  if (a.started_at !== b.started_at) return a.started_at < b.started_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortRows(runs: RunListItem[], sortKey: SortKey, sortDir: SortDir, now: number): RunListItem[] {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...runs].sort((a, b) => {
    if (sortKey === "duration") {
      // null-last in BOTH directions (a run with no measurable extent has no
      // place on the duration axis), so the null test escapes the dir flip
      const da = durationMs(a, now);
      const db = durationMs(b, now);
      if (da === null && db === null) return tieBreak(a, b);
      if (da === null) return 1;
      if (db === null) return -1;
      if (da !== db) return (da - db) * dir;
      return tieBreak(a, b);
    }
    const cmp = compareKey(a, b, sortKey);
    if (cmp !== 0) return cmp * dir;
    return tieBreak(a, b);
  });
}

/** Ascending comparison for the non-duration keys; sortRows applies the
 * direction. */
function compareKey(a: RunListItem, b: RunListItem, sortKey: SortKey): number {
  switch (sortKey) {
    case "run":
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    case "blueprint":
      return a.blueprint < b.blueprint ? -1 : a.blueprint > b.blueprint ? 1 : 0;
    case "status": {
      const sa = runStatus(a);
      const sb = runStatus(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    case "spend":
      return a.spend_usd - b.spend_usd;
    case "started":
    default:
      return a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0;
  }
}
