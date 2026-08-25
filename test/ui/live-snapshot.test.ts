/**
 * The live-snapshot transport (#56) as a PURE scheduling unit — no DOM, no
 * React, no EventSource. The adapter composes `subscribeSse` (wake-ups) +
 * `createCoalescedNotifier` (burst coalescing) and owns the lifecycle the
 * run-detail region hand-rolls today: the in-flight guard, the one-shot
 * transient-retry timer, and the terminal/gone stop teardown.
 *
 * Every test injects the two side-effecting seams — a FAKE SSE source (a
 * captured `onchange` the test triggers by hand) and a FAKE scheduler (a
 * captured `{ fn, ms }` the test fires by hand) — plus a spy `apply` returning
 * a controllable promise, so the scheduling is asserted deterministically with
 * no wall-clock and no browser.
 */
import { describe, expect, it } from "bun:test";

import { startLiveSnapshot, type LiveApplyOutcome } from "../../src/ui/app/actions/public/live-snapshot.ts";

/** Let the microtask queue drain (the coalescer defers the leading run to a
 * microtask, and each apply is async). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A promise the test resolves by hand — one in-flight `apply()`. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const RETRY_MS = 1000;

/**
 * Drive one adapter with fully injected seams. `wake()` emits an SSE change
 * frame; `fireTimer()` fires the single pending one-shot retry; the counters
 * expose the teardown side effects.
 */
function harness(apply: () => Promise<LiveApplyOutcome>) {
  let onchange: (() => void) | null = null;
  let unsubscribes = 0;
  let pending: { fn: () => void; ms: number } | null = null;
  let cancels = 0;

  const live = startLiveSnapshot({
    href: "sse://test",
    apply,
    retryMs: RETRY_MS,
    subscribe: (_href, options) => {
      onchange = options.onchange;
      return {
        unsubscribe(): void {
          unsubscribes += 1;
        },
      };
    },
    schedule: (fn, ms) => {
      pending = { fn, ms };
      return () => {
        cancels += 1;
        pending = null;
      };
    },
  });

  return {
    live,
    wake: (): void => onchange?.(),
    fireTimer: (): void => {
      const p = pending;
      pending = null;
      p?.fn();
    },
    pending: (): { fn: () => void; ms: number } | null => pending,
    unsubscribes: (): number => unsubscribes,
    cancels: (): number => cancels,
  };
}

describe("startLiveSnapshot — pure scheduling", () => {
  it("idle → apply is never called without a wake-up", async () => {
    let calls = 0;
    harness(async () => {
      calls += 1;
      return "applied";
    });
    await tick();
    expect(calls).toBe(0);
  });

  it("a burst of synchronous wake-ups coalesces to a single apply", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return "applied";
    });
    h.wake();
    h.wake();
    h.wake();
    await tick();
    expect(calls).toBe(1);
  });

  it("a wake-up mid-flight schedules exactly one follow-up (the in-flight guard)", async () => {
    let calls = 0;
    const gates = [deferred(), deferred()];
    const h = harness(async () => {
      const gate = gates[calls];
      calls += 1;
      await gate!.promise;
      return "applied";
    });

    h.wake(); // leading run
    await tick();
    expect(calls).toBe(1); // apply #1 in flight

    h.wake(); // arrives mid-flight → marks ONE trailing rerun
    h.wake(); // folds into the same trailing rerun
    h.wake();
    expect(calls).toBe(1); // still only the leading run

    gates[0]!.resolve(); // leading settles → the single follow-up fires
    await tick();
    await tick();
    expect(calls).toBe(2); // exactly one follow-up, not three

    gates[1]!.resolve();
    await tick();
    expect(calls).toBe(2); // idle again → no further applies
  });

  it("a returned 'retry' arms the one-shot timer and retries once", async () => {
    let calls = 0;
    const outcomes: LiveApplyOutcome[] = ["retry", "applied"];
    const h = harness(async () => {
      const outcome = outcomes[calls] ?? "applied";
      calls += 1;
      return outcome;
    });

    h.wake();
    await tick();
    expect(calls).toBe(1);
    expect(h.pending()?.ms).toBe(RETRY_MS); // transient failure armed the retry

    h.fireTimer(); // the one-shot retry fires
    await tick();
    expect(calls).toBe(2); // retried once
    expect(h.pending()).toBeNull(); // the successful retry armed no new timer
  });

  it("a thrown apply is treated as a transient failure (retry)", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) throw new Error("blip");
      return "applied";
    });

    h.wake();
    await tick();
    expect(calls).toBe(1);
    expect(h.pending()).not.toBeNull(); // the throw armed the one-shot retry

    h.fireTimer();
    await tick();
    expect(calls).toBe(2); // recovered on the retry
  });

  it("the retry timer is one-shot — a second failure while one is pending does not stack timers", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return "retry"; // every apply fails transiently
    });

    h.wake();
    await tick();
    expect(calls).toBe(1);
    const first = h.pending();
    expect(first).not.toBeNull();

    h.wake(); // a fresh wake-up still runs
    await tick();
    expect(calls).toBe(2);
    expect(h.pending()).toBe(first); // but no NEW timer was armed — still the one
  });

  it("a 'stopped' outcome freezes further applies and tears down the subscription", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return "stopped";
    });

    h.wake();
    await tick();
    expect(calls).toBe(1);
    expect(h.unsubscribes()).toBe(1); // terminal/gone → subscription torn down

    h.wake(); // further wake-ups are frozen
    await tick();
    expect(calls).toBe(1); // no more applies after stop
  });

  it("a 'stopped' outcome mid-flight freezes the already-scheduled follow-up", async () => {
    let calls = 0;
    const gates = [deferred(), deferred()];
    const outcomes: LiveApplyOutcome[] = ["stopped", "applied"];
    const h = harness(async () => {
      const gate = gates[calls];
      const outcome = outcomes[calls] ?? "applied";
      calls += 1;
      await gate!.promise;
      return outcome;
    });

    h.wake(); // leading run
    await tick();
    expect(calls).toBe(1);

    h.wake(); // schedules a trailing rerun while the leading run is in flight
    h.wake();
    gates[0]!.resolve(); // leading run returns "stopped" → teardown
    await tick();
    await tick();
    expect(calls).toBe(1); // the scheduled follow-up is frozen, never applied
    expect(h.unsubscribes()).toBe(1);
  });

  it("stop() cancels a pending retry, unsubscribes, and is idempotent", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return "retry";
    });

    h.wake();
    await tick();
    expect(h.pending()).not.toBeNull();

    h.live.stop();
    expect(h.cancels()).toBe(1); // the pending one-shot retry was cancelled
    expect(h.unsubscribes()).toBe(1);

    h.live.stop(); // idempotent — no double teardown
    expect(h.unsubscribes()).toBe(1);
    expect(h.cancels()).toBe(1);
  });

  it("stop() while an apply is in flight freezes it (no apply after teardown)", async () => {
    let calls = 0;
    const gate = deferred();
    const h = harness(async () => {
      calls += 1;
      await gate.promise;
      return "applied";
    });

    h.wake();
    await tick();
    expect(calls).toBe(1); // apply #1 in flight

    h.live.stop(); // abort mid-flight
    gate.resolve(); // the in-flight apply settles after teardown
    await tick();

    h.wake(); // any later wake-up is frozen
    await tick();
    expect(calls).toBe(1); // no apply ran after stop()
    expect(h.unsubscribes()).toBe(1);
  });
});
