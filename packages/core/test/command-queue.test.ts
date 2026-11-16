import { describe, expect, it } from 'vitest';
import { CommandQueue, QueueClearedError } from '../src/index.ts';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('CommandQueue', () => {
  it('runs one task at a time, high priority first', async () => {
    const q = new CommandQueue();
    const order: string[] = [];
    let active = 0;
    const task = (name: string) => async () => {
      active++;
      expect(active).toBe(1);
      await tick(2);
      order.push(name);
      active--;
    };
    const all = [
      q.run(task('low1')),
      q.run(task('low2')),
      q.run(task('high1'), { priority: 'high' }),
      q.run(task('high2'), { priority: 'high' }),
    ];
    await Promise.all(all);
    // low1 had already started when the high tasks arrived
    expect(order).toEqual(['low1', 'high1', 'high2', 'low2']);
    expect(q.stats).toMatchObject({ completed: 4, failed: 0, depth: 0 });
  });

  it('coalesces waiting tasks with the same key', async () => {
    const q = new CommandQueue();
    let runs = 0;
    const slow = q.run(() => tick(5));
    const a = q.run(async () => ++runs, { key: 'poll:11' });
    const b = q.run(async () => ++runs, { key: 'poll:11' });
    expect(a).toBe(b);
    await Promise.all([slow, a, b]);
    expect(runs).toBe(1);
  });

  it('enforces the inter-command gap', async () => {
    const q = new CommandQueue({ gapMs: 20 });
    const t0 = performance.now();
    await Promise.all([q.run(async () => {}), q.run(async () => {}), q.run(async () => {})]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(38);
  });

  it('propagates failures and keeps going', async () => {
    const q = new CommandQueue();
    const bad = q.run(async () => {
      throw new Error('boom');
    });
    const good = q.run(async () => 42);
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe(42);
    expect(q.stats.failed).toBe(1);
  });

  it('clear() rejects waiting tasks', async () => {
    const q = new CommandQueue();
    const running = q.run(() => tick(5));
    const waiting = q.run(async () => 1);
    q.clear('test');
    await expect(waiting).rejects.toBeInstanceOf(QueueClearedError);
    await running;
  });
});
