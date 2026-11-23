/**
 * Keeps a live, read-only connection to every streamer linked to an amp source
 * and reports what each is playing, per source.
 *
 * - Devices are found by mDNS and matched by their Cast id, so an address
 *   change (DHCP) only means a reconnect.
 * - When a device plays as part of a speaker group, its own endpoint carries no
 *   track details; the manager finds the group it belongs to (multizone status)
 *   and reads the group's media status instead.
 * - Between tracks a device reports ~2 s of "buffering" with no details; the
 *   last track is held for a few seconds so tiles don't flicker.
 */
import { EventEmitter } from 'node:events';
import type {
  DiscoveredStreamer,
  NowPlayingView,
  StreamerEvent,
  StreamerLink,
  StreamerState,
  StreamerStatusView,
} from '@open-zone/shared';
import {
  CastClient,
  isGroupFollower,
  type CastClientEvents,
  type NowPlaying,
  type ReceiverApp,
} from './cast/client.ts';
import { browse, type ServiceInstance } from './mdns.ts';

/** The parts of CastClient the manager uses (a fake can stand in for tests). */
export interface CastConnection extends EventEmitter<CastClientEvents> {
  connect(timeoutMs?: number): Promise<void>;
  close(): void;
  queryMultizone(timeoutMs?: number): Promise<string[]>;
}

export interface StreamerManagerOptions {
  discover?: () => Promise<ServiceInstance[]>;
  connect?: (host: string, port: number) => CastConnection;
  log?: { info: (m: string) => void; warn: (m: string) => void };
  /** Re-discovery interval while every link is connected. */
  rediscoverMs?: number;
  /** Re-discovery interval while a linked device hasn't been found. */
  searchMs?: number;
  retryMs?: { initial: number; max: number };
  /** How long to keep showing the last track while the next one loads. */
  holdMs?: number;
}

interface Device extends DiscoveredStreamer {
  port: number;
}

interface Group {
  device: Device;
  client: CastConnection;
  members: Set<string>;
  users: Set<string>;
  np: NowPlaying | null;
}

interface Runner {
  link: StreamerLink;
  client: CastConnection | undefined;
  state: StreamerState;
  address: string | null;
  error: string | null;
  deviceNp: NowPlaying | null;
  following: boolean;
  group: Group | undefined;
  groupToken: number;
  shown: NowPlayingView | null;
  lastTitledAt: number;
  retryMs: number;
  timer: NodeJS.Timeout | undefined;
  holdTimer: NodeJS.Timeout | undefined;
}

const GROUP_MODEL = 'Google Cast Group';

export function toDiscovered(s: ServiceInstance): Device | null {
  const id = s.txt.id?.replace(/-/g, '').toLowerCase();
  if (!id || !s.port) return null;
  return {
    type: 'cast',
    deviceId: id,
    name: s.txt.fn ?? s.instance.split('._')[0] ?? id,
    model: s.txt.md ?? null,
    address: s.addresses[0] ?? null,
    port: s.port,
    isGroup: s.txt.md === GROUP_MODEL,
  };
}

export class StreamerManager extends EventEmitter<{ event: [StreamerEvent] }> {
  private readonly opts: Required<Omit<StreamerManagerOptions, 'log'>> &
    Pick<StreamerManagerOptions, 'log'>;
  private devices = new Map<string, Device>();
  private runners = new Map<string, Runner>();
  private groups = new Map<string, Group>();
  private discovering: Promise<void> | undefined;
  private loop: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(options: StreamerManagerOptions = {}) {
    super();
    this.opts = {
      discover: options.discover ?? (() => browse('_googlecast._tcp.local', { timeoutMs: 3000 })),
      connect: options.connect ?? ((host, port) => new CastClient(host, port)),
      log: options.log,
      rediscoverMs: options.rediscoverMs ?? 60_000,
      searchMs: options.searchMs ?? 15_000,
      retryMs: options.retryMs ?? { initial: 3000, max: 60_000 },
      holdMs: options.holdMs ?? 8000,
    };
  }

  // ───────────────────────────── public API ─────────────────────────────

  /** Start following these links; call again whenever they change. */
  setLinks(links: readonly StreamerLink[]): void {
    const wanted = new Map(links.map((l) => [l.id, l]));
    for (const [id, r] of this.runners) {
      const next = wanted.get(id);
      if (!next || next.deviceId !== r.link.deviceId) this.removeRunner(r);
      else if (next.source !== r.link.source || next.name !== r.link.name) {
        if (next.source !== r.link.source && r.shown) {
          this.emitEvent({ type: 'nowPlaying.changed', source: r.link.source, nowPlaying: null });
        }
        r.link = next;
        r.shown = null;
        this.publish(r);
      }
    }
    for (const link of links) {
      if (this.runners.has(link.id)) continue;
      const r: Runner = {
        link,
        client: undefined,
        state: 'searching',
        address: null,
        error: null,
        deviceNp: null,
        following: false,
        group: undefined,
        groupToken: 0,
        shown: null,
        lastTitledAt: 0,
        retryMs: this.opts.retryMs.initial,
        timer: undefined,
        holdTimer: undefined,
      };
      this.runners.set(link.id, r);
      if (this.devices.has(link.deviceId)) void this.connectRunner(r);
    }
    this.emitStatus();
    this.schedule(0);
  }

  /** Discover now and list everything found (for linking in Settings). */
  async findDevices(): Promise<DiscoveredStreamer[]> {
    await this.discoverNow();
    return [...this.devices.values()]
      .map(({ port: _port, ...d }) => d)
      .sort((a, b) => Number(a.isGroup) - Number(b.isGroup) || a.name.localeCompare(b.name));
  }

  nowPlaying(): NowPlayingView[] {
    return [...this.runners.values()].flatMap((r) => (r.shown ? [r.shown] : []));
  }

  status(): StreamerStatusView[] {
    return [...this.runners.values()].map((r) => ({
      id: r.link.id,
      state: r.state,
      address: r.address,
      error: r.error,
    }));
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.loop);
    for (const r of this.runners.values()) this.removeRunner(r);
    for (const g of this.groups.values()) g.client.close();
    this.groups.clear();
  }

  // ───────────────────────────── discovery ─────────────────────────────

  private schedule(ms: number): void {
    if (this.stopped) return;
    clearTimeout(this.loop);
    this.loop = setTimeout(() => {
      void this.discoverNow().finally(() => {
        const searching = [...this.runners.values()].some((r) => !r.client);
        this.schedule(searching ? this.opts.searchMs : this.opts.rediscoverMs);
      });
    }, ms);
  }

  private discoverNow(): Promise<void> {
    this.discovering ??= this.opts
      .discover()
      .then((found) => {
        const devices = new Map<string, Device>();
        for (const s of found) {
          const d = toDiscovered(s);
          if (d) devices.set(d.deviceId, d);
        }
        // mDNS answers are lossy: keep devices we still have connections to.
        for (const r of this.runners.values()) {
          const known = this.devices.get(r.link.deviceId);
          if (r.client && known && !devices.has(known.deviceId)) devices.set(known.deviceId, known);
        }
        this.devices = devices;
        for (const r of this.runners.values()) {
          if (!r.client && !r.timer && !this.stopped) void this.connectRunner(r);
        }
      })
      .catch((err: unknown) => this.opts.log?.warn(`streamer discovery failed: ${String(err)}`))
      .finally(() => {
        this.discovering = undefined;
      });
    return this.discovering;
  }

  // ───────────────────────────── device connections ─────────────────────────────

  private async connectRunner(r: Runner): Promise<void> {
    if (r.client || this.stopped) return;
    const dev = this.devices.get(r.link.deviceId);
    if (!dev?.address) {
      this.setState(r, 'searching', null, null);
      return;
    }
    const client = this.opts.connect(dev.address, dev.port);
    r.client = client;
    this.setState(r, 'connecting', dev.address, null);
    client.on('receiver', (apps) => this.onReceiver(r, client, apps));
    client.on('nowPlaying', (np) => {
      if (r.client !== client) return;
      r.deviceNp = np;
      this.publish(r);
    });
    client.on('close', (err) => {
      if (r.client !== client) return;
      r.client = undefined;
      this.lost(r, dev.address, err?.message ?? 'disconnected');
    });
    try {
      await client.connect();
      if (r.client !== client) return;
      r.retryMs = this.opts.retryMs.initial;
      this.setState(r, 'connected', dev.address, null);
      this.opts.log?.info(`streamer ${r.link.name}: connected at ${dev.address}`);
    } catch (err) {
      if (r.client !== client) return;
      r.client = undefined;
      client.close();
      this.lost(r, dev.address, err instanceof Error ? err.message : String(err));
    }
  }

  private lost(r: Runner, address: string | null, error: string): void {
    this.detachGroup(r);
    r.following = false;
    r.deviceNp = null;
    this.setState(r, 'offline', address, error);
    this.publish(r);
    if (this.stopped) return;
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.timer = undefined;
      // Rediscover first: the device may have a new address.
      void this.discoverNow().then(() => this.connectRunner(r));
    }, r.retryMs);
    r.retryMs = Math.min(r.retryMs * 2, this.opts.retryMs.max);
  }

  private removeRunner(r: Runner): void {
    this.runners.delete(r.link.id);
    clearTimeout(r.timer);
    clearTimeout(r.holdTimer);
    this.detachGroup(r);
    const client = r.client;
    r.client = undefined;
    client?.close();
    if (r.shown && !this.stopped) {
      this.emitEvent({ type: 'nowPlaying.changed', source: r.link.source, nowPlaying: null });
    }
  }

  // ───────────────────────────── speaker groups ─────────────────────────────

  private onReceiver(r: Runner, client: CastConnection, apps: ReceiverApp[]): void {
    if (r.client !== client) return;
    const following = isGroupFollower(apps);
    if (following === r.following) return;
    r.following = following;
    if (following) void this.attachGroup(r);
    else {
      this.detachGroup(r);
      this.publish(r);
    }
  }

  /** Find the speaker group this device is playing in and read its details. */
  private async attachGroup(r: Runner): Promise<void> {
    const token = ++r.groupToken;
    const current = () =>
      token === r.groupToken && r.following && this.runners.get(r.link.id) === r;
    let candidates = [...this.devices.values()].filter((d) => d.isGroup && d.address);
    if (candidates.length === 0) {
      await this.discoverNow();
      candidates = [...this.devices.values()].filter((d) => d.isGroup && d.address);
    }
    for (const dev of candidates) {
      if (!current()) return;
      const g = this.groups.get(dev.deviceId) ?? (await this.openGroup(dev));
      if (!g || !current()) continue;
      try {
        g.members = new Set(await g.client.queryMultizone());
      } catch {
        continue;
      }
      if (!current()) return;
      if (g.members.has(r.link.deviceId)) {
        g.users.add(r.link.id);
        r.group = g;
        this.closeUnusedGroups();
        this.publish(r);
        return;
      }
    }
    this.closeUnusedGroups();
    // Not found (yet): the group may not have been announced. Try again shortly.
    if (current()) {
      setTimeout(() => {
        if (current() && !r.group) void this.attachGroup(r);
      }, this.opts.searchMs);
    }
  }

  private async openGroup(dev: Device): Promise<Group | undefined> {
    const client = this.opts.connect(dev.address!, dev.port);
    const g: Group = { device: dev, client, members: new Set(), users: new Set(), np: null };
    client.on('nowPlaying', (np) => {
      g.np = np;
      for (const id of g.users) {
        const r = this.runners.get(id);
        if (r) this.publish(r);
      }
    });
    client.on('close', () => {
      if (this.groups.get(dev.deviceId) !== g) return;
      this.groups.delete(dev.deviceId);
      for (const id of g.users) {
        const r = this.runners.get(id);
        if (r?.group === g) {
          r.group = undefined;
          if (r.following) void this.attachGroup(r);
        }
      }
    });
    try {
      await client.connect();
    } catch {
      client.close();
      return undefined;
    }
    this.groups.set(dev.deviceId, g);
    return g;
  }

  private detachGroup(r: Runner): void {
    r.groupToken++;
    if (!r.group) return;
    r.group.users.delete(r.link.id);
    r.group = undefined;
    this.closeUnusedGroups();
  }

  private closeUnusedGroups(): void {
    for (const [id, g] of this.groups) {
      if (g.users.size > 0) continue;
      this.groups.delete(id);
      g.client.close();
    }
  }

  // ───────────────────────────── publishing ─────────────────────────────

  private publish(r: Runner): void {
    if (!this.runners.has(r.link.id)) return;
    // While joining a group, keep what's shown rather than flashing "nothing".
    if (r.following && !r.group) return;
    const np = r.group ? r.group.np : r.deviceNp;
    let view: NowPlayingView | null = np
      ? {
          source: r.link.source,
          streamerId: r.link.id,
          ...np,
          group: r.group?.device.name ?? null,
        }
      : null;
    const raw = view;
    view = this.hold(r, raw);
    // Only a real title from the device restarts the hold window, not a held one.
    if (raw?.title) r.lastTitledAt = raw.at;
    if (sameView(r.shown, view)) {
      if (view) r.shown = view;
      return;
    }
    r.shown = view;
    this.emitEvent({ type: 'nowPlaying.changed', source: r.link.source, nowPlaying: view });
  }

  /** Between tracks: keep the previous track's details for a few seconds. */
  private hold(r: Runner, view: NowPlayingView | null): NowPlayingView | null {
    const prev = r.shown;
    if (!view || view.title || !prev?.title || view.app !== prev.app || view.state === 'idle') {
      clearTimeout(r.holdTimer);
      return view;
    }
    const left = this.opts.holdMs - (Date.now() - r.lastTitledAt);
    if (left <= 0) return view;
    clearTimeout(r.holdTimer);
    r.holdTimer = setTimeout(() => this.publish(r), left + 10);
    return { ...prev, state: view.state, at: view.at, group: view.group };
  }

  private setState(
    r: Runner,
    state: StreamerState,
    address: string | null,
    error: string | null,
  ): void {
    if (r.state === state && r.address === address && r.error === error) return;
    r.state = state;
    r.address = address;
    r.error = error;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emitEvent({ type: 'streamers.status', status: this.status() });
  }

  private emitEvent(e: StreamerEvent): void {
    if (!this.stopped) this.emit('event', e);
  }
}

/** Same as far as the UI cares (position ticks don't count). */
function sameView(a: NowPlayingView | null, b: NowPlayingView | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.source === b.source &&
    a.state === b.state &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.artUrl === b.artUrl &&
    a.app === b.app &&
    a.group === b.group &&
    a.duration === b.duration
  );
}
