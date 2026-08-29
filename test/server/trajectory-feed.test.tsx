/**
 * #84: the Trajectory tab's per-phase LOG FEED, driven through its PUBLIC
 * seams under happy-dom — the pure <TrajectoryFeed> render AND the hydrated
 * RunLiveRegion (the same faked-transport harness the #58 region test uses: a
 * captured SSE source + a URL-routed spy fetch). Pins:
 *
 *   - the feed renders N typed rows for a seeded view of N entries, one per
 *     lane (USER/ASSISTANT/TOOL), with the text truncated;
 *   - the SSR-seeded initial phase paints on the Trajectory tab with NO fetch;
 *   - selecting a DIFFERENT phase fetches its trajectory through the proxy and
 *     renders its rows; re-selecting a cached phase does NOT refetch;
 *   - loading, empty (0 entries), and error (fetch rejects) states render.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ensureDom, teardownDom } from "./dom-harness.ts";

ensureDom();
afterAll(teardownDom);

import { render, type RenderResult } from "remix/ui/test";

import type { PhaseStatus } from "../../src/core/index.ts";
import type {
  RawTail,
  TimelinePhase,
  TimelineSegment,
  TimelineView,
  TrajectoryEntry,
  TrajectoryView,
} from "../../src/server/contract.ts";
import type { FeedEvent } from "../../src/server/ui/public/event-feed.tsx";
import { routes } from "../../src/server/routes.ts";
import { TrajectoryFeed } from "../../src/server/ui/public/trajectory/trajectory-feed.tsx";
import {
  RunLiveRegion,
  type RunLiveRegionProps,
  type SerializableRawTail,
  type SerializableTimelineView,
  type SerializableTrajectoryView,
} from "../../src/server/actions/public/run-live-region.tsx";

const RUN_ID = "aaaaaa00-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── fixtures ─────────────────────────────────────────────────────────────────

function msg(seq: number, role: "user" | "assistant", text: string): TrajectoryEntry {
  return { seq, lane: role === "user" ? "input" : "model", turn: 0, step: seq, role, text };
}

function tool(seq: number, name: string): TrajectoryEntry {
  return {
    seq,
    lane: "tools",
    turn: 0,
    step: seq,
    tool: name,
    tool_call_id: null,
    args: { path: "src/x.ts" },
    result: "ok",
    ok: true,
    ts: null,
    duration_ms: null,
  };
}

function view(over: Partial<TrajectoryView> = {}): TrajectoryView {
  return {
    run_id: RUN_ID,
    phase: "alpha",
    phase_id: "p-alpha",
    entries: [msg(1, "user", "do the thing"), msg(2, "assistant", "on it"), tool(3, "bash")],
    truncated: false,
    ...over,
  };
}

const seededView = (over: Partial<TrajectoryView> = {}): SerializableTrajectoryView =>
  view(over) as unknown as SerializableTrajectoryView;

function seg(): TimelineSegment {
  return {
    visit: 1,
    started_at: new Date(Date.now() - 50_000).toISOString(),
    ended_at: new Date(Date.now() - 40_000).toISOString(),
    outcome: "success",
    corrections: 0,
    envelope_attempts: 0,
    cause: null,
  };
}

function phase(name: string, status: PhaseStatus): TimelinePhase {
  return {
    phase_id: `p-${name}`,
    name,
    agent: "a",
    status,
    visits: 1,
    budget: 1,
    spend_usd: 0,
    estimated_spend_usd: 0,
    segments: [seg()],
  };
}

/** two clickable phases (each with a completed segment → a bubble) so a test
 * can select "beta" in the gantt and drive the lazy trajectory fetch. */
function timeline(over: Partial<TimelineView> = {}): SerializableTimelineView {
  return {
    run_id: RUN_ID,
    blueprint: "demo",
    status: "running",
    needs_review: false,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: null,
    phases: [phase("alpha", "success"), phase("beta", "success")],
    ...over,
  } as unknown as SerializableTimelineView;
}

function raw(over: Partial<RawTail> = {}): SerializableRawTail {
  return { run_id: RUN_ID, raw: "", line_count: 0, truncated: false, ...over } as unknown as SerializableRawTail;
}

function ev(id: number): FeedEvent {
  return {
    id,
    phase_id: null,
    agent_session_id: null,
    type: "phase_start",
    ts: new Date().toISOString(),
    data: { phase: "p", agent: "a", visit: 1, budget: 1 },
  } as FeedEvent;
}

// ── the faked transport (same pattern as run-live-region.test.tsx) ───────────

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

let trajectoryReply: { ok: boolean; body: unknown } = { ok: true, body: view({ phase: "beta" }) };
let trajectoryRejects = false;
let fetchCalls: string[] = [];
let savedFetch: typeof globalThis.fetch;
let savedEventSource: unknown;

beforeEach(() => {
  const domWindow = (globalThis as { window?: { happyDOM?: { setURL?: (u: string) => void } } }).window;
  domWindow?.happyDOM?.setURL?.("http://localhost/");
  FakeEventSource.instances = [];
  fetchCalls = [];
  trajectoryReply = { ok: true, body: view({ phase: "beta", entries: [msg(1, "user", "beta hi")] }) };
  trajectoryRejects = false;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.includes("trajectory.json")) {
      if (trajectoryRejects) throw new Error("network");
      return { ok: trajectoryReply.ok, status: trajectoryReply.ok ? 200 : 500, json: async () => trajectoryReply.body };
    }
    // events.json / timeline.json / raw.json — benign defaults so the live
    // region's apply() never errors during these trajectory-focused tests
    const body = url.includes("events.json")
      ? { events: [], next_cursor: 1 }
      : url.includes("timeline.json")
        ? timeline({ status: "running" })
        : raw({ raw: "seed", line_count: 1 });
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
});

let active: RenderResult | null = null;
afterEach(() => {
  active?.cleanup();
  active = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

function mount(over: Partial<RunLiveRegionProps> = {}): RenderResult {
  const props: RunLiveRegionProps = {
    runId: RUN_ID,
    timeline: timeline({ status: "running" }),
    initialSelection: "alpha",
    initialEnvelopes: [],
    initialGates: [],
    initialSnapshot: null,
    initialInputs: null,
    initialOutputs: null,
    initialSpend: null,
    initialRaw: raw({ raw: "seed", line_count: 1 }),
    initialTrajectory: seededView(),
    rawHref: routes.runs.raw.href({ runId: RUN_ID }),
    sessions: [],
    events: [ev(1)],
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

const openTrajectory = async (r: RenderResult): Promise<void> => {
  await r.act(async () => {
    (r.$("[data-tab='trajectory']") as HTMLElement).click();
  });
};

/** click a phase's bubble in the gantt (selects it). */
const selectPhase = async (r: RenderResult, name: string): Promise<void> => {
  await r.act(async () => {
    (r.$(`[data-phase='${name}'][role='button']`) as HTMLElement).click();
    await tick();
    await tick();
  });
};

const rowSeqs = (r: RenderResult): number[] =>
  [...r.$$("[data-testid='trajectory-row']")].map((n) => Number(n.getAttribute("data-seq")));

const rowLanes = (r: RenderResult): string[] =>
  [...r.$$("[data-testid='trajectory-row']")].map((n) => n.getAttribute("data-lane") ?? "");

const trajectoryFetches = (): string[] => fetchCalls.filter((u) => u.includes("trajectory.json"));

// ── the pure feed ────────────────────────────────────────────────────────────

describe("TrajectoryFeed (#84) — typed rows per entry", () => {
  it("renders one row per entry, tagged by lane, in seq order", () => {
    const r = render(<TrajectoryFeed view={view()} />);
    active = r;
    expect(rowSeqs(r)).toEqual([1, 2, 3]);
    expect(rowLanes(r)).toEqual(["input", "model", "tools"]);
  });

  it("truncates a long message body with an ellipsis", () => {
    const long = "x".repeat(400);
    const r = render(<TrajectoryFeed view={view({ entries: [msg(1, "user", long)] })} />);
    active = r;
    const text = r.$("[data-testid='trajectory-row']")?.textContent ?? "";
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(long.length);
  });

  it("renders the empty state for a view with no entries", () => {
    const r = render(<TrajectoryFeed view={view({ entries: [] })} />);
    active = r;
    expect(rowSeqs(r)).toEqual([]);
    expect(r.$("[data-feed-empty]")).not.toBeNull();
  });
});

// ── the region-driven lazy fetch + cache + SSR seed ──────────────────────────

describe("RunLiveRegion Trajectory tab (#84) — lazy fetch + per-phase cache + SSR seed", () => {
  it("paints the SSR-seeded initial phase with NO trajectory fetch", async () => {
    const r = mount();
    await openTrajectory(r);
    expect(rowSeqs(r)).toEqual([1, 2, 3]);
    expect(trajectoryFetches()).toEqual([]); // seeded — no round-trip
  });

  it("fetches a newly-selected phase's trajectory through the proxy and renders its rows", async () => {
    const r = mount();
    await openTrajectory(r);
    // select a phase that was NOT seeded → one proxy fetch, rows swap
    await selectPhase(r, "beta");
    const fetches = trajectoryFetches();
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain(routes.runs.phases.trajectory.href({ runId: RUN_ID, phase: "beta" }));
    expect(rowSeqs(r)).toEqual([1]); // the beta view (single entry)
  });

  it("does NOT refetch a cached phase on re-select", async () => {
    const r = mount();
    await openTrajectory(r);
    await selectPhase(r, "beta");
    expect(trajectoryFetches()).toHaveLength(1);
    // back to the SSR-seeded alpha, then beta again — both cached, no new fetch
    await selectPhase(r, "alpha");
    await selectPhase(r, "beta");
    expect(trajectoryFetches()).toHaveLength(1); // still one — cache hit
  });

  it("renders the empty state for a phase with 0 entries", async () => {
    trajectoryReply = { ok: true, body: view({ phase: "beta", entries: [] }) };
    const r = mount();
    await openTrajectory(r);
    await selectPhase(r, "beta");
    expect(rowSeqs(r)).toEqual([]);
    expect(r.$("[data-feed-empty]")).not.toBeNull();
  });

  it("renders the error state when the trajectory fetch rejects", async () => {
    trajectoryRejects = true;
    const r = mount();
    await openTrajectory(r);
    await selectPhase(r, "beta");
    expect(r.$("[data-testid='trajectory-error']")).not.toBeNull();
    expect(rowSeqs(r)).toEqual([]);
  });
});
