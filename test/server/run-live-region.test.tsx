/**
 * #58: the run-detail LIVE region, driven through its PUBLIC client seam (the
 * hydrated clientEntry rendered under happy-dom) with the two side-effecting
 * transport dependencies faked: a captured SSE source (a `change` listener the
 * test fires by hand) and a spy `fetch` routed by URL. This pins the OBSERVABLE
 * behavior of the RICHEST region across the #58 swap of its hand-rolled SSE
 * lifecycle (subscribeSse + createCoalescedNotifier + poll/refreshRaw +
 * scheduleRetry + stopLive) onto the shared `startLiveSnapshot` adapter:
 *
 *   - a `change` wake-up refetches events.json + timeline.json + raw.json in
 *     PARALLEL, MERGES the cursor (appends the new events, advances next_cursor
 *     so the next wake fetches from there), and re-renders the feed + raw tail;
 *   - the cursor merge + render/view state stay in the REGION — the adapter
 *     never touches them (a toggled auto-scroll survives a refetch);
 *   - a TERMINAL transition (run_status → success/failed OR a terminal timeline
 *     view) freezes the region and tears the stream down (T10b);
 *   - a 404 on either proxy means the run is GONE and stops the subscription;
 *   - a transient non-404 failure keeps the last snapshot and leaves the stream
 *     live (the adapter arms its one-shot retry, unit-tested in
 *     live-snapshot.test.ts).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ensureDom, teardownDom } from "./dom-harness.ts";

ensureDom();
afterAll(teardownDom);

import { render, type RenderResult } from "remix/ui/test";

import type { RawTail, TimelineView } from "../../src/server/contract.ts";
import type { FeedEvent } from "../../src/server/ui/public/event-feed.tsx";
import { routes } from "../../src/server/routes.ts";
import {
  RunLiveRegion,
  type RunLiveRegionProps,
  type SerializableRawTail,
  type SerializableTimelineView,
} from "../../src/server/actions/public/run-live-region.tsx";

const RUN_ID = "aaaaaa00-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Let the coalescer's microtask flush + the async apply (parallel fetch →
 * json → handle.update) settle before an assertion. */
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

interface Reply {
  ok: boolean;
  status: number;
  body: unknown;
}

const ok = (body: unknown): Reply => ({ ok: true, status: 200, body });
const notFound = (): Reply => ({ ok: false, status: 404, body: null });
const failure = (): Reply => ({ ok: false, status: 500, body: null });

let eventsReply: Reply;
let timelineReply: Reply;
let rawReply: Reply;
let fetchCalls: string[] = [];
let savedFetch: typeof globalThis.fetch;
let savedEventSource: unknown;

beforeEach(() => {
  // apply() builds `new URL(href, window.location.href)`; happy-dom defaults to
  // "about:blank", which is not a valid base URL. Give the window a real origin
  // (a browser always has one) so the relative proxy hrefs resolve.
  const domWindow = (globalThis as { window?: { happyDOM?: { setURL?: (u: string) => void } } }).window;
  domWindow?.happyDOM?.setURL?.("http://localhost/");
  FakeEventSource.instances = [];
  fetchCalls = [];
  eventsReply = ok({ events: [], next_cursor: 0 });
  timelineReply = ok(timeline({ status: "running" }));
  rawReply = ok(raw({ raw: "seed line", line_count: 1 }));
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    fetchCalls.push(url);
    const reply = url.includes("events.json")
      ? eventsReply
      : url.includes("timeline.json")
        ? timelineReply
        : url.includes("raw.json")
          ? rawReply
          : ok(null);
    return {
      ok: reply.ok,
      status: reply.status,
      json: async () => reply.body,
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

function timeline(over: Partial<TimelineView> = {}): SerializableTimelineView {
  return {
    run_id: RUN_ID,
    blueprint: "demo",
    status: "running",
    needs_review: false,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: null,
    phases: [],
    ...over,
  } as unknown as SerializableTimelineView;
}

function raw(over: Partial<RawTail> = {}): SerializableRawTail {
  return {
    run_id: RUN_ID,
    raw: "",
    line_count: 0,
    truncated: false,
    ...over,
  } as unknown as SerializableRawTail;
}

function ev(over: Partial<FeedEvent> & { id: number }): FeedEvent {
  return {
    phase_id: null,
    agent_session_id: null,
    type: "phase_start",
    ts: new Date().toISOString(),
    data: { phase: "p", agent: "a", visit: 1, budget: 1 },
    ...over,
  } as FeedEvent;
}

function runStatus(id: number, to: string, reason?: string): FeedEvent {
  return ev({ id, type: "run_status", data: { from: "running", to, ...(reason ? { reason } : {}) } });
}

function mount(over: Partial<RunLiveRegionProps> = {}): RenderResult {
  const props: RunLiveRegionProps = {
    runId: RUN_ID,
    timeline: timeline({ status: "running" }),
    initialSelection: null,
    initialEnvelopes: [],
    initialGates: [],
    initialSnapshot: null,
    initialInputs: null,
    initialOutputs: null,
    initialSpend: null,
    initialRaw: raw({ raw: "seed line", line_count: 1 }),
    initialTrajectory: null,
    rawHref: routes.runs.raw.href({ runId: RUN_ID }),
    sessions: [],
    events: [ev({ id: 1 })],
    cursor: 1,
    eventsHref: routes.runs.events.href({ runId: RUN_ID }),
    liveHref: routes.runs.live.href({ runId: RUN_ID }),
    timelineHref: routes.runs.timeline.href({ runId: RUN_ID }),
    pauseReason: null,
    ...over,
  };
  active = render(<RunLiveRegion {...props} />);
  return active;
}

/** the event ids the feed renders, in order. */
function feedIds(r: RenderResult): number[] {
  return [...r.$$("[data-event-id]")].map((n) => Number(n.getAttribute("data-event-id")));
}

/** the rendered raw-transcript body. */
function rawText(r: RenderResult): string {
  return r.$("[data-testid='raw-transcript'] pre")?.textContent ?? "";
}

/** the last events.json fetch URL (carries the cursor query). */
function lastEventsFetch(): string {
  return [...fetchCalls].reverse().find((u) => u.includes("events.json")) ?? "";
}

describe("run-detail live region (#58) — transport delegated to startLiveSnapshot", () => {
  it("subscribes to the RUN-SCOPED live stream and tears it down on teardown", () => {
    const r = mount();
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe(routes.runs.live.href({ runId: RUN_ID }));
    expect(es.closed).toBe(false);

    r.cleanup();
    active = null;
    expect(es.closed).toBe(true);
  });

  it("does NOT arm the live stream when the run is already terminal at SSR", () => {
    mount({ timeline: timeline({ status: "success", ended_at: new Date().toISOString() }) });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("merges the cursor across wakes: appends new events and advances the cursor for the next fetch", async () => {
    const r = mount();
    expect(feedIds(r)).toEqual([1]);

    // wake #1: two new events arrive, next_cursor advances to 3
    eventsReply = ok({ events: [ev({ id: 2 }), ev({ id: 3 })], next_cursor: 3 });
    const es = FakeEventSource.instances[0]!;
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(feedIds(r)).toEqual([1, 2, 3]); // appended, not replaced
    expect(lastEventsFetch()).toContain("cursor=1"); // fetched from the seed cursor

    // wake #2: fetches from the NEW cursor (3) and appends again
    eventsReply = ok({ events: [ev({ id: 4 })], next_cursor: 4 });
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(feedIds(r)).toEqual([1, 2, 3, 4]);
    expect(lastEventsFetch()).toContain("cursor=3"); // cursor merge advanced it
  });

  it("refetches the raw tail in parallel and re-renders it on a wake", async () => {
    const r = mount();
    expect(rawText(r)).toContain("seed line");

    rawReply = ok(raw({ raw: "fresh tail", line_count: 2 }));
    const es = FakeEventSource.instances[0]!;
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(fetchCalls.some((u) => u.includes("raw.json"))).toBe(true);
    expect(rawText(r)).toContain("fresh tail");
  });

  it("keeps region view state (auto-scroll toggle) across a live refetch", async () => {
    const r = mount();
    const toggle = r.$("[data-auto-scroll]") as HTMLElement;
    expect(toggle.getAttribute("data-auto-scroll")).toBe("on");

    await r.act(async () => {
      toggle.click();
    });
    expect((r.$("[data-auto-scroll]") as HTMLElement).getAttribute("data-auto-scroll")).toBe("off");

    // a live refetch replaces the data, not the view state
    eventsReply = ok({ events: [ev({ id: 2 })], next_cursor: 2 });
    const es = FakeEventSource.instances[0]!;
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(feedIds(r)).toEqual([1, 2]);
    expect((r.$("[data-auto-scroll]") as HTMLElement).getAttribute("data-auto-scroll")).toBe("off");
  });

  it("freezes and stops the stream on a terminal run_status → success event", async () => {
    const r = mount();
    const es = FakeEventSource.instances[0]!;

    eventsReply = ok({ events: [runStatus(2, "success")], next_cursor: 2 });
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(feedIds(r)).toEqual([1, 2]); // the terminal event rendered
    expect(es.closed).toBe(true); // the subscription stopped (T10b freeze)

    // a later wake-up drives NO further fetch — the stream is torn down
    const before = fetchCalls.length;
    await r.act(async () => {
      es.emit("change");
      await tick();
    });
    expect(fetchCalls.length).toBe(before);
  });

  it("freezes and stops the stream on a terminal timeline view", async () => {
    const r = mount();
    const es = FakeEventSource.instances[0]!;

    timelineReply = ok(timeline({ status: "failed", ended_at: new Date().toISOString() }));
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(es.closed).toBe(true);
  });

  it("stops the stream when a proxy 404s (the run is gone) and keeps the last snapshot", async () => {
    const r = mount();
    const es = FakeEventSource.instances[0]!;

    eventsReply = notFound();
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(feedIds(r)).toEqual([1]); // nothing merged
    expect(es.closed).toBe(true); // gone → torn down
  });

  it("keeps the last snapshot and stays live on a transient non-404 failure", async () => {
    const r = mount();
    const es = FakeEventSource.instances[0]!;

    timelineReply = failure();
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(feedIds(r)).toEqual([1]); // kept the last snapshot
    expect(es.closed).toBe(false); // transient → the stream stays open

    // a later successful wake-up still updates — the subscription stayed live
    timelineReply = ok(timeline({ status: "running" }));
    eventsReply = ok({ events: [ev({ id: 2 })], next_cursor: 2 });
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(feedIds(r)).toEqual([1, 2]);
  });
});

describe("run-detail live region (#82) — Main | Trajectory tab bar", () => {
  const mainBody = (r: RenderResult) => r.$("[data-testid='phase-detail']");
  const panel = (r: RenderResult) => r.$("[data-testid='trajectory-panel']");
  const tab = (r: RenderResult, name: "main" | "trajectory") => r.$(`[data-tab='${name}']`) as HTMLElement;

  it("defaults to Main: shows the existing content, not the trajectory panel", () => {
    const r = mount();
    expect(mainBody(r)).not.toBeNull();
    expect(panel(r)).toBeNull();
    expect(tab(r, "main").getAttribute("aria-selected")).toBe("true");
  });

  it("switching tabs swaps the body: Trajectory shows the panel, Main restores existing content", async () => {
    const r = mount();
    await r.act(async () => {
      tab(r, "trajectory").click();
    });
    expect(panel(r)).not.toBeNull();
    expect(mainBody(r)).toBeNull();
    expect(tab(r, "trajectory").getAttribute("aria-selected")).toBe("true");

    await r.act(async () => {
      tab(r, "main").click();
    });
    expect(mainBody(r)).not.toBeNull();
    expect(panel(r)).toBeNull();
  });

  it("keeps the phase selection across a tab switch (selection lives in setup scope)", async () => {
    const r = mount({ initialSelection: "alpha" });
    expect(mainBody(r)?.getAttribute("data-selected")).toBe("alpha");

    await r.act(async () => {
      tab(r, "trajectory").click();
    });
    await r.act(async () => {
      tab(r, "main").click();
    });
    expect(mainBody(r)?.getAttribute("data-selected")).toBe("alpha");
  });

  it("keeps activeTab across an SSE change wake-up (activeTab lives in setup scope)", async () => {
    const r = mount();
    await r.act(async () => {
      tab(r, "trajectory").click();
    });
    expect(panel(r)).not.toBeNull();

    // an apply() driven by a change wake-up must not reset the active tab
    eventsReply = ok({ events: [ev({ id: 2 })], next_cursor: 2 });
    const es = FakeEventSource.instances[0]!;
    await r.act(async () => {
      es.emit("change");
      await tick();
      await tick();
    });
    expect(feedIds(r)).toEqual([]); // Main body (the feed) is not mounted on Trajectory
    expect(panel(r)).not.toBeNull(); // still on Trajectory after the refetch
    expect(tab(r, "trajectory").getAttribute("aria-selected")).toBe("true");
  });
});
