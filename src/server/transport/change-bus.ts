/**
 * The in-process change bus: a "something changed" wake-up fires here every
 * time an event row is written to the daemon's SQLite, per-run and globally.
 * The two remix SSE proxy routes subscribe here and push a wake-up frame to
 * the browser; the browser then refetches from its cursor.
 *
 * INVARIANT: `insertEvent` (src/daemon/db.ts) is the SINGLE events-write
 * chokepoint — the only place that writes an events row. web.ts installs
 * `emitRunChange` as db.ts's `setEventInsertHook`, so every write path (the
 * run loop, the controls, backfill, the queue's EventSink) signals through
 * here. A future write path that bypasses `insertEvent` will SILENTLY NOT
 * signal — keep the chokepoint intact.
 *
 * The bus carries NO data — only wake-ups. Correctness stays in the existing
 * cursor-based JSON refetches, so a dropped or reconnected subscriber is
 * inherently lossless: it just refetches from the cursor it holds.
 */

type ChangeCallback = () => void;

const runSubscribers = new Map<string, Set<ChangeCallback>>();
const allSubscribers = new Set<ChangeCallback>();

/** Subscribe to change wake-ups for a single run. Returns an idempotent
 * unsubscribe. */
export function subscribeRun(runId: string, cb: ChangeCallback): () => void {
  let set = runSubscribers.get(runId);
  if (set === undefined) {
    set = new Set();
    runSubscribers.set(runId, set);
  }
  set.add(cb);
  return () => {
    const current = runSubscribers.get(runId);
    if (current === undefined) return;
    current.delete(cb);
    if (current.size === 0) runSubscribers.delete(runId);
  };
}

/** Subscribe to change wake-ups for ANY run. Returns an idempotent
 * unsubscribe. */
export function subscribeAll(cb: ChangeCallback): () => void {
  allSubscribers.add(cb);
  return () => {
    allSubscribers.delete(cb);
  };
}

/** Fire a change wake-up for one run: its run-scoped subscribers plus every
 * global subscriber. Emitting to an empty set is a no-op. The subscriber sets
 * are snapshotted so a callback that unsubscribes mid-emit is safe. */
export function emitRunChange(runId: string): void {
  const set = runSubscribers.get(runId);
  if (set !== undefined) {
    for (const cb of [...set]) cb();
  }
  for (const cb of [...allSubscribers]) cb();
}
