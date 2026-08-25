/**
 * The SSE stream factory: turns a change-bus subscription into a
 * `text/event-stream` Response. The frames carry NO data — a change frame is
 * only a "refetch now" wake-up, so a missed frame is harmless (the browser's
 * cursor refetch catches up; reconnect is lossless).
 *
 * Byte-exact wire contract:
 *   change frame     = "event: change\ndata: {}\n\n"
 *   heartbeat frame  = ": keepalive\n\n"   (an SSE comment line, ignored by
 *                      EventSource, keeps proxies/browsers from idling out)
 *
 * Teardown fires on `signal` abort AND on stream `cancel()`, is idempotent,
 * enqueues nothing after close, and leaks no interval. A pre-aborted signal
 * closes the stream immediately.
 */

export const SSE_HEARTBEAT_MS = 25_000;

export const CHANGE_FRAME = "event: change\ndata: {}\n\n";
export const HEARTBEAT_FRAME = ": keepalive\n\n";

export interface SseStreamOptions {
  /** Wire the stream to the change bus. Returns an unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
  /** Aborts on client disconnect (the remix request signal). */
  signal?: AbortSignal;
  /** Heartbeat cadence; tests inject ms, prod uses SSE_HEARTBEAT_MS. */
  heartbeatMs?: number;
}

export function createSseStream(options: SseStreamOptions): ReadableStream<Uint8Array> {
  const { subscribe, signal } = options;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let onAbort: (() => void) | null = null;
  let closed = false;

  const teardown = (controller: ReadableStreamDefaultController<Uint8Array> | null) => {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    if (signal !== undefined && onAbort !== null) {
      signal.removeEventListener("abort", onAbort);
      onAbort = null;
    }
    if (controller !== null) {
      try {
        controller.close();
      } catch {
        // already closed by the consumer — nothing to do
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // a pre-aborted signal closes immediately — never subscribe, never tick
      if (signal?.aborted) {
        teardown(controller);
        return;
      }
      unsubscribe = subscribe(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(CHANGE_FRAME));
      });
      heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(HEARTBEAT_FRAME));
      }, heartbeatMs);
      onAbort = () => teardown(controller);
      signal?.addEventListener("abort", onAbort);
    },
    // the consumer cancelled (socket close): tear down without re-closing the
    // controller (it is already being torn down by the runtime)
    cancel() {
      teardown(null);
    },
  });
}

/** Resolve the SSE heartbeat override from the request's ?heartbeat_ms= query.
 *
 * The prod routes are INERT to this param: outside the test environment this
 * always returns undefined, so the factory falls back to SSE_HEARTBEAT_MS and
 * no client can drive the keepalive cadence (a low value would otherwise spin
 * a hostile setInterval — a localhost self-DoS). Only under `NODE_ENV=test`
 * (bun test) is a positive-integer override honored, letting the real-TCP e2e
 * exercise a short heartbeat. A returned undefined leaves the default path
 * byte-for-byte unchanged. */
export function heartbeatOverrideMs(raw: string | null): number | undefined {
  if (process.env.NODE_ENV !== "test") return undefined;
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The SSE Response: the stream above with the event-stream headers. */
export function createSseResponse(options: SseStreamOptions): Response {
  return new Response(createSseStream(options), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
