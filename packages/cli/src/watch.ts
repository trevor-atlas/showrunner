import type { EventRow } from "@showrunner/core";

import { getJson } from "./client.ts";

export interface WatchOptions {
  runId: string;
  socketPath: string;
  intervalMs?: number;
  maxPolls?: number;
  onEvent: (e: EventRow) => void;
}

const TERMINAL = new Set(["success", "failed", "paused", "interrupted"]);

/**
 * Stream a run's folded events via the one cursor query (§2.3, §4.3): poll
 * GET /runs/:id/events?cursor=<rowid> at ~500ms, printing every new event,
 * until the run reaches a terminal state and the cursor is caught up.
 * Replay-then-tail: full history and live view are the same loop.
 */
export async function watchRun(opts: WatchOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? 500;
  const maxPolls = opts.maxPolls ?? 600; // 5 min at 500ms
  let cursor = 0;
  for (let poll = 0; poll < maxPolls; poll++) {
    const events = (await getJson(
      opts.socketPath,
      `/runs/${opts.runId}/events?cursor=${cursor}&limit=500`,
    )) as { events: EventRow[]; next_cursor: number };

    for (const e of events.events) {
      opts.onEvent(e);
      if (e.id > cursor) cursor = e.id;
    }

    const detail = (await getJson(opts.socketPath, `/runs/${opts.runId}`)) as {
      run: { status: string };
    };
    if (TERMINAL.has(detail.run.status) && events.events.length === 0) {
      return; // terminal and caught up
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`watch: run ${opts.runId} still not terminal after ${maxPolls} polls`);
}
