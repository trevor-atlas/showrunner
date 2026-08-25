/**
 * #57: the landing run list, LIVE — driven through its PUBLIC client seam (the
 * hydrated clientEntry rendered under happy-dom) with the two side-effecting
 * transport dependencies faked: a captured SSE source (a `change` listener the
 * test fires by hand) and a spy `fetch`. This pins the OBSERVABLE behavior of
 * the region across the #57 swap of its hand-rolled SSE lifecycle onto the
 * `startLiveSnapshot` adapter:
 *
 *   - a `change` wake-up refetches the /runs-list.json snapshot proxy and
 *     replaces the rendered runs (the transport the adapter now owns);
 *   - view state (search / sort / the ?status= filter seed) lives in the region
 *     and survives a refetch — the adapter never touches it;
 *   - a transient refetch failure keeps the last snapshot (the list is
 *     single-snapshot: apply always returns "applied", never stops);
 *   - the subscription targets the GLOBAL live stream and is torn down on
 *     teardown (abort).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ensureDom, teardownDom } from "./dom-harness.ts";

ensureDom();
afterAll(teardownDom);

import { render, type RenderResult } from "remix/ui/test";

import type { RunListItem } from "../../src/daemon/contract.ts";
import { routes } from "../../src/server/routes.ts";
import { RunListLive, type SerializableRunListItem } from "../../src/server/actions/public/run-list-live.tsx";

// happy-dom sets Event.target/currentTarget only for its OWN Event class (see
// components.test.tsx) — dispatch events built from the happy-dom window.
declare const window: { Event: typeof Event };

/** Let the coalescer's microtask flush + the async apply (fetch → json →
 * handle.update) settle before an assertion. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── the faked transport seams ────────────────────────────────────────────────

/** A captured EventSource: records the `change` listener so the test fires a
 * wake-up by hand, and tracks close() so teardown is assertable. */
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

let fetchReply: FetchReply = { ok: true, status: 200, body: { runs: [] } };
let fetchCalls: string[] = [];
let savedFetch: typeof globalThis.fetch;
let savedEventSource: unknown;

beforeEach(() => {
  FakeEventSource.instances = [];
  fetchCalls = [];
  fetchReply = { ok: true, status: 200, body: { runs: [] } };
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

function run(over: Partial<RunListItem> = {}): SerializableRunListItem {
  return {
    id: "aaaaaa00-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    blueprint: "alpha",
    status: "success",
    cwd: "/tmp/scratch",
    needs_review: 0,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: new Date().toISOString(),
    spend_usd: 0.5,
    queue_position: null,
    phase_counts: {},
    min_phase_started_at: null,
    max_phase_ended_at: null,
    ...over,
  } as unknown as SerializableRunListItem;
}

function mount(runs: SerializableRunListItem[], filter = "all"): RenderResult {
  active = render(
    <RunListLive
      runs={runs}
      statuses={["all", "running", "paused", "success", "failed", "interrupted"]}
      filter={filter}
      runsHref={routes.homeRuns.href()}
    />,
  );
  return active;
}

/** the short run ids the table renders (fmtRunId → first 6 chars). */
function renderedRunIds(r: RenderResult): string[] {
  return [...r.$$("a[data-run-link]")].map((a) => a.textContent ?? "");
}

describe("run list live (#57) — transport delegated to startLiveSnapshot", () => {
  it("refetches /runs-list.json and swaps the rendered runs on a change wake-up", async () => {
    const r = mount([run({ id: "aaaaaa11-1111-4aaa-8aaa-aaaaaaaaaaaa", blueprint: "alpha" })]);
    expect(renderedRunIds(r)).toEqual(["aaaaaa"]);

    // the next ledger change delivers a two-row snapshot through the proxy
    fetchReply = {
      ok: true,
      status: 200,
      body: {
        runs: [
          run({ id: "bbbbbb22-2222-4aaa-8aaa-aaaaaaaaaaaa", blueprint: "beta", started_at: new Date().toISOString() }),
          run({ id: "cccccc33-3333-4aaa-8aaa-aaaaaaaaaaaa", blueprint: "gamma", started_at: new Date(Date.now() - 120_000).toISOString() }),
        ],
      },
    };

    const es = FakeEventSource.instances[0]!;
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });

    expect(fetchCalls).toContain(routes.homeRuns.href());
    expect(renderedRunIds(r)).toEqual(["bbbbbb", "cccccc"]);
  });

  it("keeps region view state (search filter) across a live refetch", async () => {
    const r = mount([
      run({ id: "aaaaaa11-1111-4aaa-8aaa-aaaaaaaaaaaa", blueprint: "alpha" }),
      run({ id: "bbbbbb22-2222-4aaa-8aaa-aaaaaaaaaaaa", blueprint: "beta" }),
    ]);
    expect(renderedRunIds(r).sort()).toEqual(["aaaaaa", "bbbbbb"]);

    // user searches "alpha" → only the alpha row remains
    const input = r.$("input[type='search']") as HTMLInputElement;
    await r.act(async () => {
      input.value = "alpha";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    expect(renderedRunIds(r)).toEqual(["aaaaaa"]);

    // a live refetch delivers BOTH rows again — the search state must survive
    fetchReply = {
      ok: true,
      status: 200,
      body: {
        runs: [
          run({ id: "aaaaaa11-1111-4aaa-8aaa-aaaaaaaaaaaa", blueprint: "alpha" }),
          run({ id: "bbbbbb22-2222-4aaa-8aaa-aaaaaaaaaaaa", blueprint: "beta" }),
        ],
      },
    };
    const es = FakeEventSource.instances[0]!;
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });

    // still filtered to alpha — the refetch replaced the data, not the view
    expect(renderedRunIds(r)).toEqual(["aaaaaa"]);
  });

  it("keeps the last snapshot when a refetch fails transiently (single-snapshot: never stops)", async () => {
    const r = mount([run({ id: "aaaaaa11-1111-4aaa-8aaa-aaaaaaaaaaaa", blueprint: "alpha" })]);
    expect(renderedRunIds(r)).toEqual(["aaaaaa"]);

    fetchReply = { ok: false, status: 500, body: null };
    const es = FakeEventSource.instances[0]!;
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    // the failed refetch kept the last snapshot
    expect(renderedRunIds(r)).toEqual(["aaaaaa"]);
    expect(es.closed).toBe(false); // a transient failure never tears down the stream

    // a later successful wake-up still updates — the subscription stayed live
    fetchReply = {
      ok: true,
      status: 200,
      body: { runs: [run({ id: "dddddd44-4444-4aaa-8aaa-aaaaaaaaaaaa", blueprint: "delta" })] },
    };
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(renderedRunIds(r)).toEqual(["dddddd"]);
  });

  it("subscribes to the global live stream and tears it down on teardown", async () => {
    const r = mount([run()]);
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe(routes.live.href());
    expect(es.closed).toBe(false);

    r.cleanup();
    active = null;
    expect(es.closed).toBe(true);
  });
});
