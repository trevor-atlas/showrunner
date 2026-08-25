/**
 * Unit tests for the run-list pure model (issue #39): `visibleRows` (status +
 * free-text search + blueprint filter, then sort), `distinctBlueprints`, and
 * the `durationMs` phase-extent fold. Pure model — no DOM (the repo's
 * convention, mirroring timeline-model.test.ts): the clientEntry's rendering
 * is pinned by the SSR test in run-list.test.ts; the filtering/sorting logic
 * is pinned here.
 */
import { describe, expect, it } from "bun:test";

import type { RunListItem } from "../../src/daemon/contract.ts";
import { distinctBlueprints, durationMs, visibleRows } from "../../src/server/ui/public/list-model.ts";

const NOW = new Date("2026-02-01T12:00:00.000Z").getTime();
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function run(overrides: Partial<RunListItem> = {}): RunListItem {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    blueprint: "demo",
    status: "success",
    cwd: "/tmp/scratch",
    needs_review: 0,
    started_at: iso(0),
    ended_at: null,
    spend_usd: 0,
    queue_position: null,
    phase_counts: {},
    min_phase_started_at: null,
    max_phase_ended_at: null,
    ...overrides,
  };
}

const baseQuery = {
  status: "all",
  search: "",
  blueprint: "all",
  sortKey: "started" as const,
  sortDir: "desc" as const,
};

describe("durationMs — phase-extent with || now", () => {
  it("is (max ended − min started) for a settled run", () => {
    const r = run({ min_phase_started_at: iso(-60_000), max_phase_ended_at: iso(-30_000) });
    expect(durationMs(r, NOW)).toBe(30_000);
  });

  it("bounds an in-flight run (no max) with `now`", () => {
    const r = run({ min_phase_started_at: iso(-45_000), max_phase_ended_at: null });
    expect(durationMs(r, NOW)).toBe(45_000);
  });

  it("is null only when no phase has started", () => {
    expect(durationMs(run({ min_phase_started_at: null }), NOW)).toBeNull();
  });
});

describe("distinctBlueprints", () => {
  it("returns the unique blueprint names, sorted", () => {
    const runs = [run({ blueprint: "plan_build" }), run({ blueprint: "demo" }), run({ blueprint: "plan_build" })];
    expect(distinctBlueprints(runs)).toEqual(["demo", "plan_build"]);
  });

  it("is empty for no runs", () => {
    expect(distinctBlueprints([])).toEqual([]);
  });
});

describe("visibleRows — status filter", () => {
  it("keeps only rows whose folded status matches", () => {
    const runs = [
      run({ id: "1", status: "success" }),
      run({ id: "2", status: "failed" }),
      run({ id: "3", status: "running" }),
    ];
    const out = visibleRows(runs, { ...baseQuery, status: "failed" }, NOW);
    expect(out.map((r) => r.id)).toEqual(["2"]);
  });

  it("folds a pool-queued run to `queued` (queue_position, not row status)", () => {
    const runs = [
      run({ id: "1", status: "running", queue_position: 1 }),
      run({ id: "2", status: "running", queue_position: null }),
    ];
    expect(visibleRows(runs, { ...baseQuery, status: "queued" }, NOW).map((r) => r.id)).toEqual(["1"]);
    expect(visibleRows(runs, { ...baseQuery, status: "running" }, NOW).map((r) => r.id)).toEqual(["2"]);
  });

  it("all passes every row through", () => {
    const runs = [run({ id: "1" }), run({ id: "2" })];
    expect(visibleRows(runs, baseQuery, NOW)).toHaveLength(2);
  });
});

describe("visibleRows — free-text search (id prefix OR blueprint substring)", () => {
  const runs = [
    run({ id: "abc123", blueprint: "plan_build" }),
    run({ id: "def456", blueprint: "everything" }),
    run({ id: "abcxyz", blueprint: "scout" }),
  ];

  it("matches an id prefix, case-insensitive", () => {
    expect(visibleRows(runs, { ...baseQuery, search: "ABC" }, NOW).map((r) => r.id)).toEqual(["abc123", "abcxyz"]);
  });

  it("matches a blueprint substring, case-insensitive", () => {
    expect(visibleRows(runs, { ...baseQuery, search: "THING" }, NOW).map((r) => r.id)).toEqual(["def456"]);
  });

  it("does NOT match an id substring that is not a prefix", () => {
    expect(visibleRows(runs, { ...baseQuery, search: "456" }, NOW).map((r) => r.id)).toEqual([]);
  });

  it("AND-combines with the status filter", () => {
    const mixed = [
      run({ id: "abc1", blueprint: "plan_build", status: "failed" }),
      run({ id: "abc2", blueprint: "plan_build", status: "success" }),
    ];
    const out = visibleRows(mixed, { ...baseQuery, status: "failed", search: "abc" }, NOW);
    expect(out.map((r) => r.id)).toEqual(["abc1"]);
  });
});

describe("visibleRows — blueprint filter", () => {
  it("keeps only the chosen blueprint", () => {
    const runs = [run({ id: "1", blueprint: "demo" }), run({ id: "2", blueprint: "scout" })];
    expect(visibleRows(runs, { ...baseQuery, blueprint: "scout" }, NOW).map((r) => r.id)).toEqual(["2"]);
  });
});

describe("visibleRows — sorting", () => {
  it("defaults to started-desc (most recent first)", () => {
    const runs = [
      run({ id: "old", started_at: iso(-3_600_000) }),
      run({ id: "new", started_at: iso(-60_000) }),
      run({ id: "mid", started_at: iso(-600_000) }),
    ];
    expect(visibleRows(runs, baseQuery, NOW).map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts started ascending when asked", () => {
    const runs = [
      run({ id: "new", started_at: iso(-60_000) }),
      run({ id: "old", started_at: iso(-3_600_000) }),
    ];
    expect(visibleRows(runs, { ...baseQuery, sortKey: "started", sortDir: "asc" }, NOW).map((r) => r.id)).toEqual([
      "old",
      "new",
    ]);
  });

  it("sorts by blueprint name", () => {
    const runs = [run({ id: "1", blueprint: "scout" }), run({ id: "2", blueprint: "demo" })];
    expect(visibleRows(runs, { ...baseQuery, sortKey: "blueprint", sortDir: "asc" }, NOW).map((r) => r.id)).toEqual([
      "2",
      "1",
    ]);
  });

  it("sorts by spend", () => {
    const runs = [run({ id: "hi", spend_usd: 4.2 }), run({ id: "lo", spend_usd: 0.1 })];
    expect(visibleRows(runs, { ...baseQuery, sortKey: "spend", sortDir: "asc" }, NOW).map((r) => r.id)).toEqual([
      "lo",
      "hi",
    ]);
  });

  it("sorts by duration with nulls last in BOTH directions", () => {
    const runs = [
      run({ id: "short", min_phase_started_at: iso(-20_000), max_phase_ended_at: iso(-10_000) }), // 10s
      run({ id: "none", min_phase_started_at: null }),
      run({ id: "long", min_phase_started_at: iso(-90_000), max_phase_ended_at: iso(-30_000) }), // 60s
    ];
    expect(visibleRows(runs, { ...baseQuery, sortKey: "duration", sortDir: "asc" }, NOW).map((r) => r.id)).toEqual([
      "short",
      "long",
      "none",
    ]);
    expect(visibleRows(runs, { ...baseQuery, sortKey: "duration", sortDir: "desc" }, NOW).map((r) => r.id)).toEqual([
      "long",
      "short",
      "none",
    ]);
  });
});
