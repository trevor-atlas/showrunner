import type { Database } from "bun:sqlite";
import type { EventType } from "@showrunner/core";
import { parseEventData } from "@showrunner/core";
import { insertEvent } from "./db.ts";

/**
 * Backpressure-safe event sink (spec §7.1): the tracer's stdout read loop must
 * never block on SQLite - the raw file is the safe buffer. The read loop only
 * appends to an in-memory queue here; a drain worker writes batches to the DB
 * on the next event-loop ticks. Order is preserved (FIFO).
 */
export class EventSink {
  private readonly pending: { type: EventType; data: unknown }[] = [];
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private firstError: Error | null = null;
  private readonly db: Database;
  private readonly ctx: {
    runId: string;
    phaseId: string | null;
    agentSessionId: string | null;
  };

  constructor(db: Database, ctx: { runId: string; phaseId: string | null; agentSessionId: string | null }) {
    this.db = db;
    this.ctx = ctx;
  }

  push(type: EventType, data: unknown): void {
    this.pending.push({ type, data });
    this.schedule();
  }

  private schedule(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainPromise = (async () => {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0, 100);
        for (const e of batch) {
          try {
            insertEvent(this.db, {
              run_id: this.ctx.runId,
              phase_id: this.ctx.phaseId,
              agent_session_id: this.ctx.agentSessionId,
              type: e.type,
              ts: new Date().toISOString(),
              data: parseEventData(e.type, e.data),
            });
          } catch (err) {
            // a validation failure is a tracer bug: record it, keep draining,
            // and rethrow at flush() so tests see it
            if (this.firstError === null) {
              this.firstError = err instanceof Error ? err : new Error(String(err));
            }
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })().finally(() => {
      this.draining = false;
    });
  }

  /** Wait until every queued event is durable. Rethrows the first write error. */
  async flush(): Promise<void> {
    if (this.draining) await this.drainPromise;
    if (this.firstError !== null) throw this.firstError;
  }
}
