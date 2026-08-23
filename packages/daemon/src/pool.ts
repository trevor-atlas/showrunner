/**
 * The run pool (spec §5.4): N concurrent run slots (default 2), spawns beyond
 * the pool queue at the daemon. A run holds a slot from first spawn to its
 * terminal state — `release` is called when the run's `done` resolves.
 *
 * Queue-position surfacing (list-runs) is deferred to T08's full §13 contract;
 * this pool is the spawn gate itself.
 */
export class RunPool {
  private readonly running = new Set<string>();
  private readonly queued: { id: string; start: () => void }[] = [];
  private readonly slots: number;

  constructor(slots: number) {
    if (!Number.isInteger(slots) || slots < 1) {
      throw new Error(`pool size must be a positive integer, got ${slots}`);
    }
    this.slots = slots;
  }

  /** Enqueue a run; it starts as soon as a slot is free. */
  enqueue(id: string, start: () => void): void {
    this.queued.push({ id, start });
    this.pump();
  }

  /** Mark a run done; frees its slot for the next queued run. */
  release(id: string): void {
    this.running.delete(id);
    this.pump();
  }

  get runningIds(): string[] {
    return [...this.running];
  }

  get queuedIds(): string[] {
    return this.queued.map((q) => q.id);
  }

  private pump(): void {
    while (this.running.size < this.slots && this.queued.length > 0) {
      const next = this.queued.shift()!;
      this.running.add(next.id);
      queueMicrotask(() => {
        try {
          next.start();
        } catch {
          // a synchronous throw from start() would leak the slot; drop it.
          // (start() is expected to be fire-and-forget; errors surface via done.)
          this.running.delete(next.id);
          this.pump();
        }
      });
    }
  }
}
