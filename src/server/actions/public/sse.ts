/**
 * The browser side of the live substrate. `subscribeSse` wraps `EventSource`
 * around one of the SSE proxy routes and calls `onchange` on every `change`
 * frame. The frames carry NO data — only wake-ups — so EventSource's native
 * auto-reconnect is sufficient: a dropped connection just means the next
 * cursor refetch catches up (lossless).
 *
 * `createCoalescedNotifier` is the pure, testable scheduling core: it wraps an
 * (async) refetch so a burst of wake-ups collapses to a single run, and a
 * wake-up that arrives while a run is in flight schedules EXACTLY ONE trailing
 * rerun — never one-per-wake-up. Idle → the wrapped fn is never called.
 */

export interface SubscribeSseOptions {
  onchange: () => void;
}

export interface SseSubscription {
  unsubscribe(): void;
}

export function subscribeSse(href: string, options: SubscribeSseOptions): SseSubscription {
  const source = new EventSource(href);
  const listener = (): void => options.onchange();
  source.addEventListener("change", listener);
  return {
    unsubscribe(): void {
      source.removeEventListener("change", listener);
      source.close();
    },
  };
}

/**
 * Wrap `fn` so overlapping calls coalesce. The leading call is deferred to a
 * microtask so a synchronous burst of `notify()`s collapses to ONE run before
 * `fn` starts; any `notify()` during an in-flight run marks a single trailing
 * rerun that fires once the current run settles.
 */
export function createCoalescedNotifier(fn: () => void | Promise<void>): () => void {
  let running = false;
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    running = true;
    Promise.resolve()
      .then(fn)
      .finally(() => {
        running = false;
        if (scheduled) flush();
      });
  };

  return (): void => {
    if (scheduled) return; // a run is already queued or a trailing rerun is marked
    if (running) {
      scheduled = true; // fold into a single trailing rerun
      return;
    }
    scheduled = true;
    queueMicrotask(flush);
  };
}
