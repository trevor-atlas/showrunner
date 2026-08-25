process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi
/**
 * Issue #40 acceptance e2e: the landing stat cards + charts rendered from REAL
 * daemon data — server-side only. The RunStatsRegion clientEntry SSR-renders
 * the four KPI cards and the three charts ABOVE the run list; this suite drives
 * the page through the app router (`router.fetch`) and asserts the rendered
 * HTML, exactly like run-list.test.ts.
 *
 * The pins:
 *  - the four KPI values (runs count, active sub-count, success rate,
 *    interrupted count, spend, avg duration) come from real getStats() data;
 *  - the three chart containers render (data-testid markers) + the donut legend
 *    buckets (data-bucket, never data-status);
 *  - the region is FILTER-INDEPENDENT: a ?status=failed page still renders ALL
 *    statuses in the donut while the list filters to failed, and — critically —
 *    the region introduces NO data-status leak (the run-list.test.ts pin).
 *
 * Hermetic: every test uses its own mkdtemp data dir and closes its daemon.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor } from "../../src/core/index.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/daemon.ts";
import { insertRun, openDb } from "../../src/daemon/db.ts";
import { router } from "../../src/server/router.ts";
import { routes } from "../../src/server/routes.ts";

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-ui-${label}-`));
}

function setDataDir(dir: string): () => void {
  const saved = process.env.SHOWRUNNER_DATA_DIR;
  process.env.SHOWRUNNER_DATA_DIR = dir;
  return () => {
    if (saved === undefined) delete process.env.SHOWRUNNER_DATA_DIR;
    else process.env.SHOWRUNNER_DATA_DIR = saved;
  };
}

/** Direct DB seed (no FakePi timing). A deterministic status mix:
 *   2 success + 1 failed  → success_rate = 2/3 = 67%
 *   1 paused (survives reconciliation), 1 interrupted
 * Blueprints are chosen so `plan_build` is the most-used (the tallest bar). */
function seedRuns(dir: string): void {
  const db = openDb(dbPathFor(dir));
  const seed = (i: number, status: string, blueprint: string, minutesAgo: number) => {
    insertRun(db, {
      id: `${i}0000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      blueprint,
      status,
      cwd: "/tmp/scratch",
      needs_review: 0,
      started_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      ended_at: status === "success" || status === "failed" ? new Date().toISOString() : null,
    });
  };
  seed(2, "success", "plan_build", 20);
  seed(3, "success", "everything", 25);
  seed(4, "failed", "prompt", 40);
  seed(5, "paused", "build_test", 5);
  seed(6, "interrupted", "scout", 60);
  db.close();
}

/** A genuinely-running row inserted AFTER daemon start so startup
 * reconciliation does not flip it to interrupted (mirrors run-list.test.ts). */
function insertRunning(dir: string): void {
  const db = openDb(dbPathFor(dir));
  insertRun(db, {
    id: "10000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    blueprint: "plan_build",
    status: "running",
    cwd: "/tmp/scratch",
    needs_review: 0,
    started_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    ended_at: null,
  });
  db.close();
}

async function fetchPath(path: string): Promise<{ status: number; html: string }> {
  const response = await router.fetch(new Request("http://localhost" + path));
  return { status: response.status, html: await response.text() };
}

describe("landing stat cards + charts (#40) — server-side daemon data", () => {
  it("renders the four KPI values and the three chart containers from real stats", async () => {
    const dir = tmpDir("stats");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      seedRuns(dir);
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      insertRunning(dir); // 1 running (not reconciled) → active = running + paused

      const { status, html } = await fetchPath(routes.home.href());
      expect(status).toBe(200);

      // the region + KPI + chart containers exist
      expect(html).toContain('data-testid="run-stats-region"');
      expect(html).toContain('data-testid="kpi-cards"');
      expect(html).toContain('data-testid="status-donut"');
      expect(html).toContain('data-testid="spend-bars"');
      expect(html).toContain('data-testid="blueprint-bars"');

      // KPI card 1 — runs count (6 total) + active sub (1 running + 1 paused)
      expect(html).toMatch(/runs<\/span><span data-kpi-value[^>]*>6</);
      expect(html).toContain("2 active");
      // KPI card 2 — success rate 2/(2+1) = 67% + interrupted shown separately
      expect(html).toContain("67%");
      expect(html).toContain("1 interrupted");
      // KPI card 3 — spend: reported headline + estimated separately ($0 here)
      expect(html).toContain("$0.00 estimated");
      // KPI card 4 — avg duration over terminal runs (no phases → null → em-dash)
      expect(html).toContain("terminal runs");

      // the donut legend keys off data-bucket (NEVER data-status) — every
      // seeded status is a present bucket
      for (const bucket of ["running", "paused", "success", "failed", "interrupted"]) {
        expect(html).toContain(`data-bucket="${bucket}"`);
      }
      // the most-used blueprint appears in the popularity bars
      expect(html).toContain("plan_build");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the stats region filter-independent AND introduces no data-status leak (?status=failed)", async () => {
    const dir = tmpDir("stats-filter");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      seedRuns(dir);
      daemon = await startDaemon({ dataDir: dir, port: 0 });

      const { html } = await fetchPath(routes.home.href() + "?status=failed");

      // the LIST filters to failed (the existing run-list.test.ts pin) — the
      // region must NOT reintroduce a data-status="running"/"success" anywhere
      expect(html).toContain('data-status="failed"');
      expect(html).not.toContain('data-status="running"');
      expect(html).not.toContain('data-status="success"');

      // …yet the all-time donut still renders every status via data-bucket —
      // the region is independent of the list's ?status= filter
      expect(html).toContain('data-testid="status-donut"');
      expect(html).toContain('data-bucket="success"');
      expect(html).toContain('data-bucket="failed"');
      expect(html).toContain('data-bucket="interrupted"');
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
