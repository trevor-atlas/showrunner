/**
 * #57: the landing stats region, LIVE — driven through its PUBLIC client seam
 * (the hydrated clientEntry rendered under happy-dom) with the SSE source and
 * `fetch` faked. This pins the OBSERVABLE behavior of the region across the #57
 * swap of its hand-rolled SSE lifecycle onto the `startLiveSnapshot` adapter:
 *
 *   - a `change` wake-up refetches the /stats.json snapshot proxy and replaces
 *     the rendered KPI snapshot (the transport the adapter now owns);
 *   - a transient refetch failure keeps the last snapshot (single-snapshot:
 *     apply always returns "applied", never stops);
 *   - the subscription targets the GLOBAL live stream and is torn down on
 *     teardown (abort).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ensureDom, teardownDom } from "./dom-harness.ts";

ensureDom();
afterAll(teardownDom);

import { render, type RenderResult } from "remix/ui/test";

import type { RunStats } from "../../src/daemon/contract.ts";
import { routes } from "../../src/ui/app/routes.ts";
import { RunStatsRegion, type SerializableRunStats } from "../../src/ui/app/actions/public/run-stats-region.tsx";

/** Let the coalescer's microtask flush + the async apply settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── the faked transport seams (same pattern as run-list-live.test.tsx) ───────

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<() => void>>();
  readonly url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: () => void): void {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
}

interface FetchReply {
  ok: boolean;
  status: number;
  body: unknown;
}

let fetchReply: FetchReply = { ok: true, status: 200, body: null };
let fetchCalls: string[] = [];
let savedFetch: typeof globalThis.fetch;
let savedEventSource: unknown;

beforeEach(() => {
  FakeEventSource.instances = [];
  fetchCalls = [];
  fetchReply = { ok: true, status: 200, body: null };
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    return {
      ok: fetchReply.ok,
      status: fetchReply.status,
      json: async () => fetchReply.body,
    };
  }) as unknown as typeof fetch;
});

let active: RenderResult | null = null;
afterEach(() => {
  active?.cleanup();
  active = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function stats(over: Partial<RunStats> = {}): SerializableRunStats {
  return {
    runs_count: 7,
    status_counts: { success: 5, failed: 2 },
    queued_count: 0,
    success_rate: 0.7,
    reported_usd: 1.25,
    estimated_usd: 0,
    avg_duration_ms: null,
    spend_by_day: [],
    blueprints: [{ blueprint: "plan_build", runs: 4 }],
    ...over,
  } as unknown as SerializableRunStats;
}

function mount(initial: SerializableRunStats): RenderResult {
  active = render(<RunStatsRegion stats={initial} statsHref={routes.homeStats.href()} />);
  return active;
}

/** the runs-count KPI value (the first data-kpi-value block). */
function runsCount(r: RenderResult): string {
  return r.$$("[data-kpi-value]")[0]?.textContent ?? "";
}

describe("run stats region live (#57) — transport delegated to startLiveSnapshot", () => {
  it("refetches /stats.json and swaps the rendered stats on a change wake-up", async () => {
    const r = mount(stats({ runs_count: 7 }));
    expect(r.$("[data-testid='run-stats-region']")).not.toBeNull();
    expect(runsCount(r)).toBe("7");

    fetchReply = { ok: true, status: 200, body: stats({ runs_count: 42 }) };
    const es = FakeEventSource.instances[0]!;
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });

    expect(fetchCalls).toContain(routes.homeStats.href());
    expect(runsCount(r)).toBe("42");
  });

  it("keeps the last snapshot when a refetch fails transiently (single-snapshot: never stops)", async () => {
    const r = mount(stats({ runs_count: 7 }));
    expect(runsCount(r)).toBe("7");

    fetchReply = { ok: false, status: 500, body: null };
    const es = FakeEventSource.instances[0]!;
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(runsCount(r)).toBe("7"); // kept the last snapshot
    expect(es.closed).toBe(false); // transient failure never tears down the stream

    fetchReply = { ok: true, status: 200, body: stats({ runs_count: 9 }) };
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(runsCount(r)).toBe("9"); // the subscription stayed live
  });

  it("subscribes to the global live stream and tears it down on teardown", async () => {
    const r = mount(stats());
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe(routes.live.href());
    expect(es.closed).toBe(false);

    r.cleanup();
    active = null;
    expect(es.closed).toBe(true);
  });
});
