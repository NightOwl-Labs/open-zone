import type { PollingConfig, ZoneId } from '@open-zone/shared';

/** What the scheduler needs from the controller. */
export interface PollTargets {
  /** Primary zones of enabled mirror groups that have at least one follower. */
  mirrorPrimarys(): ZoneId[];
  /** Follower zones of enabled mirror groups. */
  mirrorFollowers(): ZoneId[];
  /** Number of connected interactive clients (UIs). */
  interactiveClients(): number;
  pollZone(zone: ZoneId): Promise<unknown>;
  pollAll(): Promise<unknown>;
  onError(err: unknown): void;
}

interface Loop {
  timer: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
}

type LoopName = 'mirror-primary' | 'mirror-follower-audit' | 'interactive';

/**
 * Tiered background polling (see ARCHITECTURE §5):
 *   mirror-primary       every polling.mirrorPrimaryMs while a mirror is active
 *   mirror-follower-audit  one follower per tick, cycling through all followers
 *                       every polling.mirrorFollowerAuditMs, while a mirror is active
 *   interactive         full sweep every polling.interactiveMs while a UI is connected
 * With no mirrors and no clients the bus stays idle.
 */
export class PollScheduler {
  private readonly loops = new Map<LoopName, Loop>();
  private polling: PollingConfig;
  private followerCursor = 0;
  private enabled = false;
  private readonly targets: PollTargets;

  constructor(targets: PollTargets, polling: PollingConfig) {
    this.targets = targets;
    this.polling = polling;
  }

  configure(polling: PollingConfig): void {
    this.polling = polling;
  }

  get active(): LoopName[] {
    return [...this.loops.keys()];
  }

  /** Allow polling and start whichever tiers apply. */
  start(): void {
    this.enabled = true;
    this.update();
  }

  /** Re-evaluate which tiers should run (call after mirror or client changes). */
  update(): void {
    if (!this.enabled) return;
    const mirrorActive = this.targets.mirrorPrimarys().length > 0;
    this.toggle(
      'mirror-primary',
      mirrorActive,
      () => this.polling.mirrorPrimaryMs,
      async () => {
        for (const zone of this.targets.mirrorPrimarys()) await this.targets.pollZone(zone);
      },
    );
    this.toggle(
      'mirror-follower-audit',
      mirrorActive,
      () =>
        Math.max(
          100,
          this.polling.mirrorFollowerAuditMs / Math.max(1, this.targets.mirrorFollowers().length),
        ),
      async () => {
        const followers = this.targets.mirrorFollowers();
        if (followers.length === 0) return;
        const zone = followers[this.followerCursor++ % followers.length]!;
        await this.targets.pollZone(zone);
      },
    );
    this.toggle(
      'interactive',
      this.targets.interactiveClients() > 0,
      () => this.polling.interactiveMs,
      () => this.targets.pollAll(),
    );
  }

  stop(): void {
    this.enabled = false;
    for (const name of [...this.loops.keys()]) this.stopLoop(name);
  }

  private toggle(
    name: LoopName,
    shouldRun: boolean,
    interval: () => number,
    tick: () => Promise<unknown>,
  ): void {
    if (shouldRun && !this.loops.has(name)) this.startLoop(name, interval, tick);
    else if (!shouldRun && this.loops.has(name)) this.stopLoop(name);
  }

  private startLoop(name: LoopName, interval: () => number, tick: () => Promise<unknown>): void {
    const loop: Loop = { timer: undefined, stopped: false };
    this.loops.set(name, loop);
    const run = async () => {
      const started = Date.now();
      try {
        await tick();
      } catch (err) {
        this.targets.onError(err);
      }
      if (loop.stopped) return;
      loop.timer = setTimeout(run, Math.max(0, interval() - (Date.now() - started)));
    };
    loop.timer = setTimeout(run, interval());
  }

  private stopLoop(name: LoopName): void {
    const loop = this.loops.get(name);
    if (!loop) return;
    loop.stopped = true;
    clearTimeout(loop.timer);
    this.loops.delete(name);
  }
}
