/**
 * Gantt phase ordering (spec §16.7: "one row per phase, in blueprint order").
 *
 * The §13.1 detail endpoint returns phases ordered by `started_at`
 * (packages/daemon db.ts `listPhases`) — SQLite sorts NULL `started_at`
 * (pending / never-started phases) FIRST, which is NOT blueprint order. The
 * run detail must therefore reorder.
 *
 * Ordering source, in preference order:
 *  1. the §13.3 blueprint snapshot's phases (exact blueprint order — what
 *     actually ran); unknown detail phases append defensively;
 *  2. fallback (no snapshot — observation/fixture runs, seeded runs): phases
 *     that started, in `phase_start` event order (they start in blueprint
 *     order), then never-started phases in their original array order.
 *
 * Pure — no I/O; the caller reads the snapshot and the event history.
 */

export interface OrderablePhase {
  name: string;
  started_at: string | null;
}

export interface OrderableEvent {
  type: string;
  ts: string;
  data: unknown;
}

export function orderPhases<T extends OrderablePhase>(
  phases: readonly T[],
  events: readonly OrderableEvent[],
  blueprintOrder: readonly string[] | null,
): T[] {
  if (blueprintOrder !== null && blueprintOrder.length > 0) {
    const byName = new Map<string, T>();
    for (const phase of phases) byName.set(phase.name, phase);
    const ordered: T[] = [];
    for (const name of blueprintOrder) {
      const phase = byName.get(name);
      if (phase !== undefined) {
        ordered.push(phase);
        byName.delete(name);
      }
    }
    // any detail phase the snapshot does not mention (defensive — the
    // snapshot and the rows should agree) keeps its array order at the end
    for (const phase of phases) {
      if (byName.has(phase.name)) ordered.push(phase);
    }
    return ordered;
  }

  const startTs = new Map<string, number>();
  for (const ev of events) {
    if (ev.type !== "phase_start") continue;
    const name = (ev.data as { phase?: unknown }).phase;
    if (typeof name === "string") {
      const t = Date.parse(ev.ts);
      if (Number.isFinite(t)) startTs.set(name, t);
    }
  }

  return [...phases]
    .map((phase, index) => ({ phase, index }))
    .sort((a, b) => {
      const aStart = startTs.get(a.phase.name) ?? parseStart(a.phase);
      const bStart = startTs.get(b.phase.name) ?? parseStart(b.phase);
      if (aStart !== bStart) return aStart < bStart ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ phase }) => phase);
}

function parseStart(phase: OrderablePhase): number {
  if (phase.started_at === null) return Infinity;
  const t = Date.parse(phase.started_at);
  return Number.isFinite(t) ? t : Infinity;
}
