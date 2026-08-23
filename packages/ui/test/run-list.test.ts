/**
 * T09 acceptance e2e: the run list page rendered from REAL daemon data —
 * server-side only. The daemon runs in-process (bun:sqlite) against scratch
 * data dirs; pages are driven through the app router with `router.fetch(...)`
 * (the framework's testing surface) and asserted on the rendered HTML.
 *
 * Hermetic: every test uses its own mkdtemp data dir and closes its daemon;
 * nothing is written to the repo or ~/.showrunner.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor } from "@showrunner/core";
import { DaemonClient } from "../../daemon/src/client.ts";
import { startDaemon, type DaemonHandle } from "../../daemon/src/daemon.ts";
import { insertRun, openDb } from "../../daemon/src/db.ts";
import { router } from "../app/router.ts";
import { routes } from "../app/routes.ts";

const APPROVAL_BLUEPRINT = new URL("./fixtures/approval-blueprint.ts", import.meta.url).pathname;

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${ms}ms`);
}

async function fetchHome(): Promise<{ status: number; html: string }> {
  const response = await router.fetch(new Request("http://localhost" + routes.home.href()));
  return { status: response.status, html: await response.text() };
}

/** Direct DB seed so every status pill has a deterministic row (no FakePi
 * timing). The `running` row is seeded AFTER daemon start: §12.2
 * reconciliation marks pre-start `running` rows as interrupted. */
function seedRuns(dir: string, withRunning = false): string[] {
  const db = openDb(dbPathFor(dir));
  const ids: string[] = [];
  const seed = (i: number, status: string, blueprint: string, minutesAgo: number) => {
    const id = `${i}0000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    ids.push(id);
    insertRun(db, {
      id,
      blueprint,
      status,
      cwd: "/tmp/scratch",
      needs_review: 0,
      started_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      ended_at: status === "success" || status === "failed" ? new Date().toISOString() : null,
    });
  };
  if (withRunning) seed(1, "running", "plan_build", 2);
  seed(2, "paused", "build_test", 5);
  seed(3, "success", "everything", 20);
  seed(4, "failed", "prompt", 40);
  seed(5, "interrupted", "scout", 60);
  db.close();
  return ids;
}

/** Insert a run row into the daemon's live DB (WAL allows a second writer). */
function insertRunning(dir: string): string {
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
  return "10000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
}

describe("run list (T09) — server-side daemon data", () => {
  it("renders every status pill, spend, and row order from a live daemon (plus one real FakePi run)", async () => {
    const dir = tmpDir("live");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      const seeded = seedRuns(dir);
      daemon = startDaemon({ dataDir: dir });
      // a genuinely in-flight run — inserted after daemon start so §12.2
      // startup reconciliation does not flip it to interrupted
      const runningId = insertRunning(dir);
      seeded.unshift(runningId);
      const client = new DaemonClient({ socketPath: daemon.socketPath! });

      // a REAL FakePi run through the daemon pipeline (spec §17)
      const fx = await client.submitRun({ fixture: "happy", cwd: dir });
      await waitFor(async () => {
        const { runs } = await client.listRuns();
        const mine = runs.find((r) => r.id === fx.run_id);
        return mine !== undefined && mine.status !== "running";
      });

      const { status, html } = await fetchHome();
      expect(status).toBe(200);

      // every seeded status renders its pill
      for (const s of ["running", "paused", "success", "failed", "interrupted"]) {
        expect(html).toContain(`data-status="${s}"`);
      }
      // the FakePi run is on the page from real daemon data
      expect(html).toContain("fixture:happy");
      expect(html).toContain(fx.run_id.slice(0, 6));
      // spend column is USD-formatted for a settled run
      expect(html).toMatch(/\$0\.\d\d/);
      // rows link to the run-detail route with the short id
      expect(html).toContain(`/runs/${fx.run_id}`);
      // sort: started desc — the just-submitted fixture run first, then seeds by recency
      const pos = (needle: string) => html.indexOf(needle);
      expect(pos(fx.run_id.slice(0, 6))).toBeLessThan(pos(seeded[0]!.slice(0, 6)));
      expect(pos(seeded[0]!.slice(0, 6))).toBeLessThan(pos(seeded[1]!.slice(0, 6)));
      expect(pos(seeded[3]!.slice(0, 6))).toBeLessThan(pos(seeded[4]!.slice(0, 6)));
      // no daemon-down banner, no empty state
      expect(html).not.toContain("daemon is not running");
      expect(html).not.toContain("no runs yet");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders the queued pill with a REAL spawn-queue position from a 1-slot pool", async () => {
    const dir = tmpDir("queue");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = startDaemon({ dataDir: dir, poolSlots: 1 });
      const client = new DaemonClient({ socketPath: daemon.socketPath! });

      // A pauses at require_approval and holds the slot (F1)…
      const a = await client.submitRun({ blueprint: APPROVAL_BLUEPRINT, cwd: dir });
      await waitFor(async () => {
        const { runs } = await client.listRuns();
        return runs.find((r) => r.id === a.run_id)?.status === "paused";
      });
      // …so B queues at position 1
      const b = await client.submitRun({ blueprint: APPROVAL_BLUEPRINT, cwd: dir });
      expect(b.queue_position).toBe(1);

      const { html } = await fetchHome();
      expect(html).toContain(`data-status="paused"`);
      expect(html).toContain(`data-status="queued"`);
      expect(html).toContain("queued (1)");
      expect(html).toContain(b.run_id.slice(0, 6));
      // the queued row shows a spend dash, not a dollar figure
      expect(html).toContain(">-</td>");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders the empty state when the daemon has no runs", async () => {
    const dir = tmpDir("empty");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = startDaemon({ dataDir: dir });
      const { status, html } = await fetchHome();
      expect(status).toBe(200);
      expect(html).toContain("no runs yet");
      expect(html).toContain("showrunner run");
      expect(html).not.toContain("daemon is not running");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders the daemon-down banner with the expected socket; the shell still renders, no data rows", async () => {
    const dir = tmpDir("down");
    const restore = setDataDir(dir);
    try {
      // no daemon started — the socket under this scratch dir cannot exist
      const { status, html } = await fetchHome();
      expect(status).toBe(200);
      expect(html).toContain("showrunner daemon is not running");
      expect(html).toContain(`expected at ${join(dir, "daemon.sock")}`);
      expect(html).toContain("retry");
      // the page shell still renders…
      expect(html).toContain("Showrunner · runs");
      expect(html).toContain("BLUEPRINT");
      // …but there are no data rows and no empty-state CTA
      expect(html).not.toContain('data-status="');
      expect(html).not.toContain("no runs yet");
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters by status (?status=) server-side", async () => {
    const dir = tmpDir("filter");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      seedRuns(dir);
      daemon = startDaemon({ dataDir: dir });

      const response = await router.fetch(
        new Request("http://localhost" + routes.home.href() + "?status=failed"),
      );
      const html = await response.text();
      expect(html).toContain('data-status="failed"');
      expect(html).not.toContain('data-status="running"');
      expect(html).not.toContain('data-status="success"');
      // the filter select marks the current filter's option selected
      expect(html).toContain('<option value="failed" selected>');
      expect(html).toContain('<option value="all">');
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
