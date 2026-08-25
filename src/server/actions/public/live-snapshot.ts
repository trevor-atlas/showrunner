/**
 * The live-snapshot transport (#56): one client-side unit that owns the
 * SSE→refetch lifecycle the live regions hand-roll today. It COMPOSES the two
 * primitives from `sse.ts` — `subscribeSse` (the run-scoped/global change
 * stream wake-ups) and `createCoalescedNotifier` (burst coalescing + the
 * single trailing rerun) — and adds the pieces `run-live-region.tsx` grew:
 *
 *   - the IN-FLIGHT GUARD: a wake-up that lands while a refetch is running
 *     schedules EXACTLY ONE follow-up, never one-per-wake-up (the coalescer's
 *     `running`/`scheduled` core; matches poll()'s own `polling` guard);
 *   - the ONE-SHOT RETRY TIMER: a transient failure arms a single ~1s retry
 *     with no poll loop (matches `scheduleRetry` + `RETRY_MS`); a retry that
 *     fails again arms exactly one more;
 *   - the STOP TEARDOWN: a terminal freeze (run_status → success/failed) or a
 *     gone/404 unsubscribes the stream AND clears the pending retry, then
 *     freezes any already-scheduled follow-up (matches `stopLive`, the
 *     terminal branch, and the 404 branch of poll()).
 *
 * The caller owns WHAT it fetches; the adapter owns WHEN it runs. The caller's
 * `apply` IS the stop predicate: it does the refetch and returns the outcome —
 * "applied" (keep listening), "retry" (transient — arm the one-shot), or
 * "stopped" (terminal/gone — tear down). A thrown `apply` is treated as a
 * transient "retry" (the poll() catch → scheduleRetry path). This keeps the
 * adapter DOM-free and framework-free so it is unit-testable with injected
 * fakes for the SSE source and the timer (see `test/ui/live-snapshot.test.ts`).
 *
 * #57/#58 drop their bespoke lifecycle onto this: the single-snapshot regions
 * (list/stats) return "applied" always (they keep the last snapshot on
 * failure), and the run-detail region returns "retry"/"stopped" for its
 * transient-failure and terminal/gone branches.
 */

import { createCoalescedNotifier, subscribeSse, type SseSubscription, type SubscribeSseOptions } from "./sse.ts";

/** The one-shot retry delay after a transient refetch failure (ms) — the same
 * "retry next tick" tolerance run-live-region uses, now a single scheduled
 * callback with no poll loop. */
const RETRY_MS = 1000;

/**
 * The outcome of one `apply()` — the caller's stop predicate, modelled so the
 * adapter cannot be told to both retry and stop at once:
 *   - "applied": the refetch succeeded and was applied; keep listening.
 *   - "retry":   a transient failure (a non-404 error / parse throw); arm the
 *                one-shot retry timer.
 *   - "stopped": terminal (run_status → success/failed) or gone (404 on a
 *                proxy) — freeze further applies and tear down the stream.
 */
export type LiveApplyOutcome = "applied" | "retry" | "stopped";

/** Cancel a scheduled one-shot callback. */
type Cancel = () => void;

export interface LiveSnapshotOptions {
  /** the SSE change-stream href to subscribe to (run-scoped or global). */
  href: string;
  /** the refetch — the adapter owns WHEN it runs, the caller owns WHAT it
   * fetches. Returns the outcome (or throws → treated as a transient retry). */
  apply: () => Promise<LiveApplyOutcome>;
  /** the one-shot retry delay after a transient failure (ms); defaults to the
   * region's ~1s tolerance. */
  retryMs?: number;
  /** the SSE subscribe seam — defaults to `subscribeSse`; injected in tests
   * with a fake source whose `onchange` the test triggers by hand. */
  subscribe?: (href: string, options: SubscribeSseOptions) => SseSubscription;
  /** the one-shot timer seam — schedules `fn` after `ms` and returns a cancel;
   * defaults to setTimeout/clearTimeout; injected in tests as a captured slot
   * the test fires by hand. */
  schedule?: (fn: () => void, ms: number) => Cancel;
}

export interface LiveSnapshot {
  /** Tear down: unsubscribe from the stream AND cancel any pending retry.
   * Idempotent — the terminal freeze, a 404 gone, and the caller's abort all
   * route through here. */
  stop(): void;
}

const defaultSchedule = (fn: () => void, ms: number): Cancel => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * Start the transport: subscribe immediately and drive `apply` on every change
 * wake-up (coalesced) and on each one-shot retry. Does NOT run `apply` on
 * start — the caller SSR-renders the initial snapshot and this only reacts to
 * change frames, exactly like the region's setup scope.
 *
 * Callers arm this browser-side only (setup also runs during SSR); the adapter
 * itself is DOM-free, so the `typeof window` guard and the "already terminal at
 * SSR" guard stay in the caller.
 */
export function startLiveSnapshot(options: LiveSnapshotOptions): LiveSnapshot {
  const { href, apply } = options;
  const retryMs = options.retryMs ?? RETRY_MS;
  const subscribe = options.subscribe ?? subscribeSse;
  const schedule = options.schedule ?? defaultSchedule;

  // The whole lifecycle state: `stopped` (the terminal/gone freeze),
  // `subscription` (the live stream), and `cancelRetry` (the single pending
  // one-shot retry, null when none is armed). The in-flight/trailing-rerun
  // state lives inside `createCoalescedNotifier` below.
  let stopped = false;
  let subscription: SseSubscription | null = null;
  let cancelRetry: Cancel | null = null;

  const stop = (): void => {
    stopped = true;
    if (subscription !== null) {
      subscription.unsubscribe();
      subscription = null;
    }
    if (cancelRetry !== null) {
      cancelRetry();
      cancelRetry = null;
    }
  };

  // Arm EXACTLY ONE retry: no-op if stopped (a terminal run never retries) or
  // if one is already pending (one-shot, not a stacking setInterval). The retry
  // drives `notify` so it coalesces with any concurrent wake-up.
  const armRetry = (): void => {
    if (stopped || cancelRetry !== null) return;
    cancelRetry = schedule(() => {
      cancelRetry = null;
      notify();
    }, retryMs);
  };

  const run = async (): Promise<void> => {
    if (stopped) return; // frozen — the coalescer's trailing rerun no-ops
    let outcome: LiveApplyOutcome;
    try {
      outcome = await apply();
    } catch {
      outcome = "retry"; // a fetch/parse throw is transient — one delayed retry
    }
    if (stopped) return; // stopped mid-flight (abort / a prior terminal) — freeze
    if (outcome === "stopped") {
      stop();
      return;
    }
    if (outcome === "retry") armRetry();
    // "applied" → keep listening; the next change wake-up drives the next run
  };

  // The wake-up → run seam: the coalescer collapses a burst to one run and
  // folds a mid-flight wake-up into a single trailing rerun (the in-flight
  // guard). Both the SSE stream and the retry timer trigger through it.
  const notify = createCoalescedNotifier(run);

  subscription = subscribe(href, { onchange: notify });

  return { stop };
}
