process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
/**
 * #38 run-detail live via SSE — the transport swap end to end over REAL TCP.
 *
 * The run-detail live region no longer polls on a 1s setInterval; it subscribes
 * to the run-scoped SSE change stream (`GET /runs/:runId/events.sse`) and
 * refetches its EXISTING JSON snapshots (`events.json?cursor=N` +
 * `timeline.json`) on each `change` wake-up. This exercises the wire the
 * hydrated region depends on, against the merged web server the daemon binds:
 *
 *   - a `change` frame actually arrives on the run-scoped SSE stream while the
 *     demo-loop fixture drives itself (≥1 frame) — the trigger that replaces
 *     the poll interval;
 *   - the region's EXACT refetch path advances: `events.json?cursor=N`'s
 *     next_cursor grows as new events land, and `timeline.json` gains segments
 *     as new phase visits open (the merge + timeline refetch the poll did);
 *   - the terminal freeze lands: after `run_status → success` the transition is
 *     visible through the events proxy and the tail is final — a later refetch
 *     from the last cursor returns no further events (the subscription stops).
 *
 * NOTE (#33): under bun's in-process fetch a lone SSE frame can buffer until a
 * flush/heartbeat, so this e2e appends the NODE_ENV=test-only `?heartbeat_ms=`
 * knob (100ms) to keep the stream flushing rather than stalling ~25s on the
 * prod heartbeat.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dbPathFor } from "../../src/core/index.ts";
import type { TimelineView } from "../../src/server/transport/client.ts";
import { DaemonClient } from "../../src/server/transport/client.ts";
import { startDaemon, type DaemonHandle } from "../../src/server/lifecycle.ts";
import { getRun, openDb } from "../../src/server/repository/db.ts";
import { routes } from "../../src/server/routes.ts";
import { CHANGE_FRAME } from "../../src/server/lib/live.ts";
import { createCoalescedNotifier } from "../../src/server/actions/public/sse.ts";

const DEMO_LOOP_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon", "fixtures", "demo-loop");
const DEMO_LOOP_BP = join(DEMO_LOOP_FIXTURE_DIR, "demo-loop.ts");

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-ui-run-detail-live-${label}-`));
}

function setDataDir(dir: string): () => void {
  const saved = process.env.SHOWRUNNER_DATA_DIR;
  process.env.SHOWRUNNER_DATA_DIR = dir;
  return () => {
    if (saved === undefined) delete process.env.SHOWRUNNER_DATA_DIR;
    else process.env.SHOWRUNNER_DATA_DIR = saved;
  };
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 30_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("run-detail live wiring (#38) — the region composes createCoalescedNotifier over poll", () => {
  // The region wires `subscribeSse(liveHref, { onchange: createCoalescedNotifier(poll) })`.
  // This exercises that EXACT composition: a wake-up arriving while poll() is
  // in flight must schedule one trailing rerun rather than being swallowed by
  // poll's own `polling` guard — the guarantee the old setInterval backstop
  // used to provide, and the reason a mid-poll terminal frame no longer
  // strands the region (no freeze / leaked EventSource).
  it("a wake-up during an in-flight poll triggers exactly one trailing rerun (the polling guard alone would drop it)", async () => {
    // poll() modelled with the region's real `polling` guard + an in-flight gate
    let starts = 0;
    let polling = false;
    const gates = [deferred(), deferred()];
    const poll = (): Promise<void> => {
      if (polling) return Promise.resolve(); // the region's own guard — drops overlaps
      polling = true;
      const gate = gates[starts];
      starts += 1;
      return (gate ? gate.promise : Promise.resolve()).finally(() => {
        polling = false;
      });
    };

    // baseline: the naked guard drops an overlapping wake-up (the regression)
    void poll(); // start #1, now in flight
    await tick();
    expect(starts).toBe(1);
    void poll(); // overlapping wake-up — dropped by the guard, no rerun queued
    expect(starts).toBe(1);
    gates[0]!.resolve();
    await tick();
    expect(starts).toBe(1); // stranded: no trailing refetch ever ran

    // the fix: wrap poll with createCoalescedNotifier (the region's wiring)
    starts = 0;
    polling = false;
    const gates2 = [deferred(), deferred()];
    let g = 0;
    const poll2 = (): Promise<void> => {
      if (polling) return Promise.resolve();
      polling = true;
      const gate = gates2[g];
      g += 1;
      starts += 1;
      return (gate ? gate.promise : Promise.resolve()).finally(() => {
        polling = false;
      });
    };
    const notify = createCoalescedNotifier(poll2);

    notify(); // schedules the leading run
    await tick();
    expect(starts).toBe(1); // poll2 #1 in flight
    notify(); // arrives mid-flight → marks ONE trailing rerun
    notify(); // folds into the same trailing rerun
    expect(starts).toBe(1);
    gates2[0]!.resolve(); // leading run settles → the trailing rerun fires
    await tick();
    await tick();
    expect(starts).toBe(2); // exactly one trailing rerun — the dropped wake-up recovered
    gates2[1]!.resolve();
    await tick();
    expect(starts).toBe(2); // idle → no further runs
  });
});

interface EventsPage {
  events: { id: number; type: string; ts: string; data: unknown }[];
  next_cursor: number;
}

describe("run-detail live via SSE (#38) — the transport swap over real TCP", () => {
  it("subscribes to the run-scoped SSE stream, refetches the events/timeline snapshots on change, and freezes at run_status → success", async () => {
    const dir = tmpDir("sse");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    const ac = new AbortController();
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const baseUrl = daemon.baseUrl;

      // submit the demo-loop fixture module — the fixture + its fake-pi
      // scripts resolve at submit and the pool drives it to success
      const client = new DaemonClient({ baseUrl });
      const sub = await client.submitRun({ blueprint: DEMO_LOOP_BP });
      const runId = sub.run_id;
      expect(sub.blueprint).toBe("demo-loop");

      const db = openDb(dbPathFor(dir));

      // the region's EXACT refetch helpers, over real TCP (the merged web
      // server the daemon binds)
      const fetchEvents = async (cursor: number): Promise<EventsPage> => {
        const url = new URL(baseUrl + routes.runs.events.href({ runId }));
        url.searchParams.set("cursor", String(cursor));
        const res = await fetch(url);
        expect(res.status).toBe(200);
        return (await res.json()) as EventsPage;
      };
      const fetchTimeline = async (): Promise<TimelineView> => {
        const res = await fetch(baseUrl + routes.runs.timeline.href({ runId }));
        expect(res.status).toBe(200);
        return (await res.json()) as TimelineView;
      };
      const segCount = (v: TimelineView): number => v.phases.reduce((n, p) => n + p.segments.length, 0);

      // ── the SSE trigger: subscribe to the run-scoped change stream with the
      // test-only short heartbeat so buffered frames flush; count change
      // frames in the background while the run drives itself ────────────────
      const sseUrl = baseUrl + routes.runs.live.href({ runId }) + "?heartbeat_ms=100";
      const changesPromise = (async (): Promise<number> => {
        const res = await fetch(sseUrl, { signal: ac.signal });
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/event-stream");
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let changes = 0;
        const deadline = Date.now() + 25_000;
        try {
          while (Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf(CHANGE_FRAME)) !== -1) {
              changes++;
              buf = buf.slice(idx + CHANGE_FRAME.length);
            }
            if (changes >= 1 && getRun(db, runId)?.status === "success") break;
          }
        } catch {
          // aborted at teardown — return what we counted
        }
        return changes;
      })();

      // ── the region's refetch advances: next_cursor grows and timeline
      // gains segments as the run progresses ────────────────────────────────
      const first = await fetchEvents(0);
      const c0 = first.next_cursor;
      const s0 = segCount(await fetchTimeline());

      let cursorAdvanced = c0;
      await waitFor(
        async () => {
          const page = await fetchEvents(c0);
          if (page.next_cursor > c0 && page.events.length > 0) {
            cursorAdvanced = page.next_cursor;
            return true;
          }
          return false;
        },
        25_000,
        "events.json next_cursor to grow past the initial cursor",
      );
      expect(cursorAdvanced).toBeGreaterThan(c0);

      await waitFor(async () => segCount(await fetchTimeline()) > s0, 25_000, "timeline.json to gain segments");
      expect(segCount(await fetchTimeline())).toBeGreaterThan(s0);

      // ── the run completes; the terminal transition is visible through the
      // events proxy (run_status → success) ─────────────────────────────────
      await waitFor(() => getRun(db, runId)?.status === "success", 30_000, "demo-loop run success");

      const changes = await changesPromise;
      expect(changes).toBeGreaterThanOrEqual(1);

      // the full history carries the terminal run_status → success event (the
      // freeze trigger the region reads)
      const full = await fetchEvents(0);
      const terminal = full.events.find(
        (e) => e.type === "run_status" && (e.data as { to?: unknown }).to === "success",
      );
      expect(terminal).toBeDefined();

      // ── the tail is final: a refetch from the last cursor returns no further
      // events (a terminal run emits nothing more — the subscription stops) ──
      const tailCursor = full.next_cursor;
      const afterA = await fetchEvents(tailCursor);
      expect(afterA.events).toHaveLength(0);
      expect(afterA.next_cursor).toBe(tailCursor);
      const afterB = await fetchEvents(tailCursor);
      expect(afterB.events).toHaveLength(0);
      expect(afterB.next_cursor).toBe(tailCursor);

      db.close();
    } finally {
      ac.abort();
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 60_000 });
});
