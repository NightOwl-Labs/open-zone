import type { QueueStats } from '@open-zone/shared';

export type Priority = 'high' | 'low';

export interface RunOptions {
  /** 'high' for user and mirror writes, 'low' for background polls. Default 'low'. */
  priority?: Priority;
  /**
   * Coalescing key. If a task with the same key is already waiting, the
   * existing promise is returned instead of queueing a duplicate. Used so
   * polls never pile up when the bus is slower than the poll interval.
   */
  key?: string;
}

interface Job {
  task: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  key: string | undefined;
  promise: Promise<unknown>;
}

export class QueueClearedError extends Error {
  constructor(reason: string) {
    super(`Command queue cleared: ${reason}`);
    this.name = 'QueueClearedError';
  }
}

/**
 * Serializes every exchange with the hardware: one command on the wire at a
 * time, high priority ahead of low, and a minimum idle gap between commands.
 */
export class CommandQueue {
  private readonly high: Job[] = [];
  private readonly low: Job[] = [];
  private running = false;
  private gapMs: number;
  private readonly stats_: Omit<QueueStats, 'depth'> = {
    completed: 0,
    failed: 0,
    lastMs: null,
    avgMs: null,
    maxMs: null,
  };

  constructor(options: { gapMs?: number } = {}) {
    this.gapMs = options.gapMs ?? 0;
  }

  setGap(ms: number): void {
    this.gapMs = ms;
  }

  get depth(): number {
    return this.high.length + this.low.length + (this.running ? 1 : 0);
  }

  get stats(): QueueStats {
    return { depth: this.depth, ...this.stats_ };
  }

  run<T>(task: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    const lane = options.priority === 'high' ? this.high : this.low;
    if (options.key !== undefined) {
      const existing = lane.find((j) => j.key === options.key);
      if (existing) return existing.promise as Promise<T>;
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    lane.push({ task, resolve, reject, key: options.key, promise });
    void this.pump();
    return promise as Promise<T>;
  }

  /** Reject everything that has not started yet (e.g. on disconnect). */
  clear(reason: string): void {
    const err = new QueueClearedError(reason);
    for (const job of [...this.high.splice(0), ...this.low.splice(0)]) job.reject(err);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let job: Job | undefined;
      while ((job = this.high.shift() ?? this.low.shift())) {
        const started = performance.now();
        try {
          job.resolve(await job.task());
          this.stats_.completed++;
        } catch (err) {
          this.stats_.failed++;
          job.reject(err);
        }
        this.record(performance.now() - started);
        if (this.gapMs > 0 && (this.high.length || this.low.length)) {
          await new Promise((r) => setTimeout(r, this.gapMs));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private record(ms: number): void {
    const s = this.stats_;
    s.lastMs = Math.round(ms * 10) / 10;
    s.maxMs = Math.max(s.maxMs ?? 0, s.lastMs);
    s.avgMs = Math.round((s.avgMs === null ? ms : s.avgMs * 0.8 + ms * 0.2) * 10) / 10;
  }
}
