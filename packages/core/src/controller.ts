import {
  DriverTimeoutError,
  PatchValidationError,
  PollingConfigSchema,
  QueueConfigSchema,
  isValidZone,
  settingsOf,
  diffSettings,
  unitOf,
  validatePatch,
  zonesForUnits,
  type AmpDriver,
  type ChangeOrigin,
  type Config,
  type ConnectionStatus,
  type DetachReason,
  type ControllerEvent,
  type MirrorGroup,
  type ModelDescriptor,
  type PollingConfig,
  type QueueConfig,
  type SettableProp,
  type SourceId,
  type SourceView,
  type SystemView,
  type UnitId,
  type ZoneId,
  type ZonePatch,
  type ZoneState,
  type ZoneView,
} from '@open-zone/shared';
import { CommandQueue, QueueClearedError, type RunOptions } from './command-queue.ts';
import type { ConfigStore } from './config-store.ts';
import { EventBus } from './event-bus.ts';
import {
  MirrorValidationError,
  evaluateFollower,
  expectedFollowerSettings,
  orderWrites,
  validateGroupShape,
} from './mirror.ts';
import { PollScheduler } from './poll-scheduler.ts';
import { ZoneStateCache, type ObservedChanges } from './zone-cache.ts';

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface ControllerOptions {
  driver: AmpDriver;
  store: ConfigStore;
  /** Shown in the system view, e.g. "/dev/amp0 @ 9600". */
  transportDescription?: string;
  logger?: Logger;
  reconnect?: { initialMs?: number; maxMs?: number };
  /** Consecutive command timeouts that mean the amp has gone away. */
  maxConsecutiveTimeouts?: number;
  newId?: () => string;
}

export interface MirrorInput {
  name?: string | undefined;
  enabled?: boolean | undefined;
  primary: ZoneId;
  followers: Array<ZoneId | { zone: ZoneId; volumeOffset?: number }>;
}

export class NotConnectedError extends Error {
  constructor() {
    super('Amplifier is not connected');
    this.name = 'NotConnectedError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/**
 * The controller API. Every UI or integration goes through this class; it
 * owns the command queue, the state cache, polling and the mirror engine.
 */
export class Controller {
  readonly bus: EventBus;
  readonly model: ModelDescriptor;
  private readonly driver: AmpDriver;
  private readonly store: ConfigStore;
  private readonly log: Logger;
  private readonly queue = new CommandQueue();
  private readonly cache = new ZoneStateCache();
  private readonly scheduler: PollScheduler;
  private readonly transportDescription: string;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxConsecutiveTimeouts: number;
  private readonly newId: () => string;

  private config!: Config;
  private units: UnitId[] = [];
  private status: ConnectionStatus = 'disconnected';
  private lastError: string | null = null;
  private clients = 0;
  private started = false;
  private consecutiveTimeouts = 0;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly background = new Set<Promise<unknown>>();
  /** Followers currently being brought in line by a fan-out; audits skip them. */
  private readonly syncing = new Map<ZoneId, number>();
  private unsubscribeDisconnect: (() => void) | undefined;

  constructor(options: ControllerOptions) {
    this.driver = options.driver;
    this.model = options.driver.model;
    this.store = options.store;
    this.log = options.logger ?? silentLogger;
    this.bus = new EventBus((err) => this.log.error('event handler failed', err));
    this.transportDescription = options.transportDescription ?? '';
    this.reconnectInitialMs = options.reconnect?.initialMs ?? 1000;
    this.reconnectMaxMs = options.reconnect?.maxMs ?? 30_000;
    this.reconnectDelay = this.reconnectInitialMs;
    this.maxConsecutiveTimeouts = options.maxConsecutiveTimeouts ?? 3;
    this.newId = options.newId ?? (() => crypto.randomUUID().slice(0, 8));
    this.scheduler = new PollScheduler(
      {
        mirrorPrimarys: () => this.activeGroups().map((g) => g.primary),
        mirrorFollowers: () => this.activeGroups().flatMap((g) => g.followers.map((c) => c.zone)),
        interactiveClients: () => this.clients,
        pollZone: (zone) => this.refreshZone(zone),
        pollAll: () => this.refreshAll(),
        onError: (err) => this.logBackgroundError('poll', err),
      },
      PollingConfigSchema.parse({}),
    );
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.config = await this.store.load();
    this.queue.setGap(this.config.queue.interCommandGapMs);
    this.scheduler.configure(this.config.polling);
    this.unsubscribeDisconnect = this.driver.onDisconnect((err) =>
      this.linkLost(err ?? new Error('Link closed')),
    );
    this.started = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.started = false;
    clearTimeout(this.reconnectTimer);
    this.scheduler.stop();
    this.queue.clear('controller stopping');
    this.unsubscribeDisconnect?.();
    await Promise.allSettled([...this.background]);
    await this.driver.close();
    this.setStatus('disconnected', null);
  }

  /** Resolves when no commands are queued and no background work (fan-out) is pending. */
  async whenIdle(): Promise<void> {
    while (this.background.size > 0 || this.queue.depth > 0) {
      await Promise.allSettled([...this.background]);
      if (this.queue.depth > 0) await new Promise((r) => setTimeout(r, 5));
    }
  }

  /**
   * Register an interactive client (e.g. an open UI over WebSocket). While at
   * least one is registered, all units are swept periodically. Returns a
   * release function.
   */
  addClient(): () => void {
    this.clients++;
    if (this.clients === 1 && this.status === 'connected') {
      this.track(this.refreshAll('high'));
    }
    this.scheduler.update();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.clients--;
      this.scheduler.update();
    };
  }

  private async connect(): Promise<void> {
    if (!this.started) return;
    this.setStatus('connecting', this.lastError);
    try {
      if (!this.driver.isOpen) await this.driver.open();
      const units = await this.queue.run(() => this.driver.discoverUnits(), { priority: 'high' });
      if (units.length === 0) throw new Error('No amplifier responded');
      this.units = units;
      this.consecutiveTimeouts = 0;
      this.reconnectDelay = this.reconnectInitialMs;
      this.setStatus('connected', null);
      this.log.info(`connected: units ${units.join(', ')}`);
      await this.onConnected();
    } catch (err) {
      if (!this.started) return;
      this.log.warn(`connect failed: ${errorMessage(err)}`);
      this.setStatus('error', errorMessage(err));
      this.scheduleReconnect();
    }
  }

  private async onConnected(): Promise<void> {
    // Only touch the bus when someone needs state: an active mirror or a UI.
    if (this.activeGroups().length > 0 || this.clients > 0) {
      await this.refreshAll('high');
    }
    for (const group of this.config.mirrors.filter((g) => g.enabled)) {
      try {
        await this.syncGroup(group.id);
      } catch (err) {
        this.logBackgroundError(`sync mirror ${group.id}`, err);
      }
    }
    this.scheduler.start();
  }

  private linkLost(err: Error): void {
    if (!this.started || this.status !== 'connected') return;
    this.log.warn(`link lost: ${err.message}`);
    this.scheduler.stop();
    this.queue.clear('link lost');
    this.cache.clear();
    this.setStatus('disconnected', err.message);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private setStatus(status: ConnectionStatus, error: string | null): void {
    const changed = status !== this.status || error !== this.lastError;
    this.status = status;
    this.lastError = error;
    if (changed) {
      this.emit(
        error
          ? { type: 'connection.changed', status, error }
          : { type: 'connection.changed', status },
      );
    }
  }

  // ───────────────────────────── queries ─────────────────────────────

  getSystem(): SystemView {
    return {
      model: this.model,
      connection: {
        status: this.status,
        error: this.lastError,
        transport: this.transportDescription,
      },
      units: [...this.units],
      queue: this.queue.stats,
      polling: {
        mirrorActive: this.activeGroups().length > 0,
        interactiveClients: this.clients,
      },
    };
  }

  getConfig(): Config {
    return structuredClone(this.config);
  }

  getZones(): ZoneView[] {
    return zonesForUnits(this.model, this.units).map((z) => this.zoneView(z));
  }

  getZone(zone: ZoneId): ZoneView {
    this.assertInstalled(zone);
    return this.zoneView(zone);
  }

  getSources(): SourceView[] {
    return Array.from({ length: this.model.sourceCount }, (_, i) => ({
      source: i + 1,
      name: this.config.sources[String(i + 1)]?.name ?? null,
      enabled: this.config.sources[String(i + 1)]?.enabled ?? true,
    }));
  }

  private zoneView(zone: ZoneId): ZoneView {
    const role = this.roleOf(zone);
    return {
      zone,
      name: this.config.zones[String(zone)]?.name ?? null,
      enabled: this.isZoneEnabled(zone),
      state: this.cache.get(zone) ?? null,
      updatedAt: this.cache.updatedAt(zone),
      mirror: !role
        ? null
        : role.role === 'primary'
          ? { groupId: role.group.id, role: 'primary' }
          : { groupId: role.group.id, role: 'follower', volumeOffset: role.follower.volumeOffset },
    };
  }

  /** Read one zone from the hardware. */
  async refreshZone(zone: ZoneId, priority: RunOptions['priority'] = 'low'): Promise<ZoneView> {
    this.assertInstalled(zone);
    const state = await this.exec(() => this.driver.queryZone(zone), {
      priority,
      key: `zone:${zone}`,
    });
    this.observe(state);
    return this.zoneView(zone);
  }

  /** Read every installed zone from the hardware. */
  async refreshAll(priority: RunOptions['priority'] = 'low'): Promise<ZoneView[]> {
    for (const unit of this.units) {
      const states = await this.exec(() => this.driver.queryUnit(unit), {
        priority,
        key: `unit:${unit}`,
      });
      for (const s of states) this.observe(s);
    }
    return this.getZones();
  }

  // ───────────────────────────── commands ─────────────────────────────

  /**
   * Change settings on a zone. Every property in the patch is sent, even if
   * the cache already shows that value: with no UI or mirror active the cache
   * may be stale, and an explicit user command must always reach the amp.
   */
  async setZone(zone: ZoneId, patch: unknown): Promise<ZoneView> {
    this.assertInstalled(zone);
    if (!this.isZoneEnabled(zone)) {
      throw new PatchValidationError([`zone ${zone} is disabled`]);
    }
    const valid = validatePatch(this.model, patch);
    if (
      valid.source !== undefined &&
      this.config.sources[String(valid.source)]?.enabled === false
    ) {
      throw new PatchValidationError([`source ${valid.source} is disabled`]);
    }
    await this.writeZone(zone, valid, 'api');
    return this.zoneView(zone);
  }

  /** Rename and/or enable/disable a zone. Pass `name: null` to clear the name. */
  async updateZone(
    zone: ZoneId,
    input: { name?: string | null; enabled?: boolean },
  ): Promise<ZoneView> {
    if (!isValidZone(this.model, zone)) throw new NotFoundError(`zone ${zone}`);
    const key = String(zone);
    const current = this.config.zones[key] ?? { enabled: true };
    const next: { name?: string; enabled: boolean } = { enabled: current.enabled };
    const name = input.name === undefined ? current.name : input.name?.trim() || undefined;
    if (name) next.name = name;
    if (input.enabled !== undefined) next.enabled = input.enabled;
    if (!next.enabled && current.enabled) {
      const role = this.roleOf(zone);
      if (role) {
        throw new MirrorValidationError([
          `zone ${zone} is in mirror group ${role.group.name ?? role.group.id}; remove it from the mirror first`,
        ]);
      }
    }
    const zones = { ...this.config.zones };
    if (next.name || !next.enabled) zones[key] = next;
    else delete zones[key];
    await this.saveConfig({ ...this.config, zones });
    this.emit({ type: 'zone.updated', zone, name: next.name ?? null, enabled: next.enabled });
    return this.zoneView(zone);
  }

  /** @deprecated use updateZone */
  async renameZone(zone: ZoneId, name: string | null): Promise<ZoneView> {
    return this.updateZone(zone, { name });
  }

  private isZoneEnabled(zone: ZoneId): boolean {
    return this.config.zones[String(zone)]?.enabled ?? true;
  }

  /** Rename and/or enable/disable a source. Pass `name: null` to clear the name. */
  async updateSource(
    source: SourceId,
    input: { name?: string | null; enabled?: boolean },
  ): Promise<SourceView> {
    if (!Number.isInteger(source) || source < 1 || source > this.model.sourceCount) {
      throw new NotFoundError(`source ${source}`);
    }
    const key = String(source);
    const current = this.config.sources[key] ?? { enabled: true };
    const next: { name?: string; enabled: boolean } = { enabled: current.enabled };
    const name = input.name === undefined ? current.name : input.name?.trim() || undefined;
    if (name) next.name = name;
    if (input.enabled !== undefined) next.enabled = input.enabled;
    const sources = { ...this.config.sources };
    if (next.name || !next.enabled) sources[key] = next;
    else delete sources[key];
    const enabledCount = Array.from(
      { length: this.model.sourceCount },
      (_, i) => sources[String(i + 1)]?.enabled ?? true,
    ).filter(Boolean).length;
    if (enabledCount === 0) {
      throw new PatchValidationError(['at least one source must stay enabled']);
    }
    await this.saveConfig({ ...this.config, sources });
    const view = this.getSources()[source - 1]!;
    this.emit({ type: 'source.updated', source: view });
    return view;
  }

  /** @deprecated use updateSource */
  async renameSource(source: SourceId, name: string | null): Promise<SourceView> {
    return this.updateSource(source, { name });
  }

  async updateSettings(input: {
    polling?: Partial<PollingConfig>;
    queue?: Partial<QueueConfig>;
  }): Promise<Config> {
    const polling = PollingConfigSchema.parse({ ...this.config.polling, ...input.polling });
    const queue = QueueConfigSchema.parse({ ...this.config.queue, ...input.queue });
    await this.saveConfig({ ...this.config, polling, queue });
    this.scheduler.configure(polling);
    this.queue.setGap(queue.interCommandGapMs);
    return this.getConfig();
  }

  // ───────────────────────────── mirrors ─────────────────────────────

  listMirrors(): MirrorGroup[] {
    return structuredClone(this.config.mirrors);
  }

  getMirror(id: string): MirrorGroup {
    const g = this.config.mirrors.find((m) => m.id === id);
    if (!g) throw new NotFoundError(`mirror group ${id}`);
    return structuredClone(g);
  }

  async createMirror(input: MirrorInput): Promise<MirrorGroup> {
    const group: MirrorGroup = {
      id: this.newId(),
      enabled: input.enabled ?? true,
      primary: input.primary,
      followers: input.followers.map((c) =>
        typeof c === 'number' ? { zone: c, volumeOffset: 0 } : { volumeOffset: 0, ...c },
      ),
    };
    if (input.name?.trim()) group.name = input.name.trim();
    await this.validateGroup(group);
    await this.saveConfig({ ...this.config, mirrors: [...this.config.mirrors, group] });
    this.emit({ type: 'mirror.updated', group: structuredClone(group) });
    if (group.enabled) await this.syncGroup(group.id);
    this.scheduler.update();
    return this.getMirror(group.id);
  }

  async updateMirror(id: string, input: Partial<MirrorInput>): Promise<MirrorGroup> {
    const current = this.getMirror(id);
    const offsets = new Map(current.followers.map((c) => [c.zone, c.volumeOffset]));
    const next: MirrorGroup = {
      ...current,
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.primary !== undefined && { primary: input.primary }),
    };
    if (input.name !== undefined) {
      if (input.name?.trim()) next.name = input.name.trim();
      else delete next.name;
    }
    if (input.followers) {
      next.followers = input.followers.map((c) =>
        typeof c === 'number'
          ? { zone: c, volumeOffset: offsets.get(c) ?? 0 }
          : { zone: c.zone, volumeOffset: c.volumeOffset ?? offsets.get(c.zone) ?? 0 },
      );
    }
    await this.validateGroup(next);
    await this.saveConfig({
      ...this.config,
      mirrors: this.config.mirrors.map((g) => (g.id === id ? next : g)),
    });
    this.emit({ type: 'mirror.updated', group: structuredClone(next) });
    if (next.enabled) await this.syncGroup(id);
    this.scheduler.update();
    return this.getMirror(id);
  }

  async deleteMirror(id: string): Promise<void> {
    this.getMirror(id);
    await this.saveConfig({
      ...this.config,
      mirrors: this.config.mirrors.filter((g) => g.id !== id),
    });
    this.emit({ type: 'mirror.deleted', groupId: id });
    this.scheduler.update();
  }

  private async validateGroup(group: MirrorGroup): Promise<void> {
    const issues = validateGroupShape(this.model, this.units, group, this.config.mirrors);
    for (const zone of [group.primary, ...group.followers.map((f) => f.zone)]) {
      if (!this.isZoneEnabled(zone)) issues.push(`zone ${zone} is disabled`);
    }
    if (issues.length === 0) {
      // Followers must not have keypads: read them fresh from the hardware.
      for (const follower of group.followers) {
        const view = await this.refreshZone(follower.zone, 'high');
        if (view.state?.keypad) {
          issues.push(`zone ${follower.zone} has a wall keypad and cannot be a mirror follower`);
        }
      }
    }
    if (issues.length) throw new MirrorValidationError(issues);
  }

  /** Read the primary and followers, then bring every follower in line with the primary. */
  private async syncGroup(id: string): Promise<void> {
    const group = this.config.mirrors.find((g) => g.id === id);
    if (!group?.enabled) return;
    const zones = group.followers.map((c) => c.zone);
    await this.whileSyncing(zones, async () => {
      await this.refreshZone(group.primary, 'high');
      for (const zone of zones) await this.refreshZone(zone, 'high');
      for (const zone of zones) {
        if (this.cache.get(zone)?.keypad)
          await this.detachFollower(group.id, zone, 'keypad-detected');
      }
      await this.fanOut(group.id);
    });
  }

  /** Suppress follower audits for these zones while the mirror itself is changing them. */
  private async whileSyncing<T>(zones: readonly ZoneId[], fn: () => Promise<T>): Promise<T> {
    for (const z of zones) this.syncing.set(z, (this.syncing.get(z) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      for (const z of zones) {
        const n = (this.syncing.get(z) ?? 1) - 1;
        if (n > 0) this.syncing.set(z, n);
        else this.syncing.delete(z);
      }
    }
  }

  /** Push the primary's current settings to each follower of an enabled group. */
  private async fanOut(id: string, options: { reReadFollowers?: boolean } = {}): Promise<void> {
    const group = this.config.mirrors.find((g) => g.id === id);
    if (!group?.enabled) return;
    const primary = this.cache.get(group.primary);
    if (!primary) return;
    await Promise.all(
      group.followers.map(({ zone, volumeOffset }) =>
        this.whileSyncing([zone], async () => {
          if (options.reReadFollowers || !this.cache.get(zone)) {
            await this.refreshZone(zone, 'high');
          }
          const follower = this.cache.get(zone);
          const latestPrimary = this.cache.get(group.primary) ?? primary;
          if (!follower) return;
          const expected = expectedFollowerSettings(this.model, latestPrimary, volumeOffset);
          const patch = diffSettings(settingsOf(follower), expected);
          if (Object.keys(patch).length) await this.writeZone(zone, patch, 'mirror');
        }),
      ),
    );
  }

  /** Apply the backup rule to a follower whose state was observed or written outside the mirror. */
  private async auditFollower(groupId: string, zone: ZoneId): Promise<void> {
    const group = this.config.mirrors.find((g) => g.id === groupId);
    const entry = group?.followers.find((c) => c.zone === zone);
    if (!group?.enabled || !entry || this.syncing.has(zone)) return;
    const primary = this.cache.get(group.primary);
    const follower = this.cache.get(zone);
    if (!primary || !follower) return;
    const ignore = [...this.cache.pendingProps(zone), ...this.cache.pendingProps(group.primary)];
    const verdict = evaluateFollower(this.model, primary, follower, entry.volumeOffset, ignore);
    if (verdict.kind === 'offset') {
      await this.setFollowerOffset(group.id, zone, verdict.volumeOffset);
    } else if (verdict.kind === 'detach') {
      await this.detachFollower(group.id, zone, verdict.reason, verdict.property);
    }
  }

  private async setFollowerOffset(
    groupId: string,
    zone: ZoneId,
    volumeOffset: number,
  ): Promise<void> {
    const mirrors = this.config.mirrors.map((g) =>
      g.id !== groupId
        ? g
        : {
            ...g,
            followers: g.followers.map((c) => (c.zone === zone ? { ...c, volumeOffset } : c)),
          },
    );
    await this.saveConfig({ ...this.config, mirrors });
    this.log.info(`mirror ${groupId}: zone ${zone} volume offset now ${volumeOffset}`);
    this.emit({ type: 'mirror.offsetChanged', groupId, zone, volumeOffset });
    this.emit({ type: 'mirror.updated', group: this.getMirror(groupId) });
  }

  private async detachFollower(
    groupId: string,
    zone: ZoneId,
    reason: DetachReason,
    property?: SettableProp,
  ): Promise<void> {
    const mirrors = this.config.mirrors.map((g) =>
      g.id !== groupId ? g : { ...g, followers: g.followers.filter((c) => c.zone !== zone) },
    );
    await this.saveConfig({ ...this.config, mirrors });
    this.log.info(
      `mirror ${groupId}: detached zone ${zone} (${reason}${property ? `: ${property}` : ''})`,
    );
    this.emit(
      property
        ? { type: 'mirror.followerDetached', groupId, zone, reason, property }
        : { type: 'mirror.followerDetached', groupId, zone, reason },
    );
    this.emit({ type: 'mirror.updated', group: this.getMirror(groupId) });
    this.scheduler.update();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private activeGroups(): MirrorGroup[] {
    return this.config?.mirrors.filter((g) => g.enabled && g.followers.length > 0) ?? [];
  }

  private roleOf(
    zone: ZoneId,
  ):
    | { role: 'primary'; group: MirrorGroup }
    | { role: 'follower'; group: MirrorGroup; follower: MirrorGroup['followers'][number] }
    | undefined {
    for (const group of this.config?.mirrors ?? []) {
      if (group.primary === zone) return { role: 'primary', group };
      const follower = group.followers.find((c) => c.zone === zone);
      if (follower) return { role: 'follower', group, follower };
    }
    return undefined;
  }

  /** Merge a polled state into the cache and react to what changed. */
  private observe(state: ZoneState): void {
    const changes = this.cache.applyObserved(state);
    const current = this.cache.get(state.zone)!;
    if (changes === null) {
      // First read since start or reconnect: report it, but don't judge
      // mirror followers on it — syncGroup brings them in line explicitly.
      const { pa, keypad } = state;
      this.emit({
        type: 'zone.changed',
        zone: state.zone,
        changes: { ...settingsOf(state), pa, keypad },
        state: current,
        origin: 'poll',
      });
      return;
    }
    if (Object.keys(changes).length > 0) {
      this.emit({
        type: 'zone.changed',
        zone: state.zone,
        changes,
        state: current,
        origin: 'poll',
      });
    }
    this.track(this.reactToChange(state.zone, changes, 'poll'));
  }

  private async reactToChange(
    zone: ZoneId,
    changes: ObservedChanges,
    origin: ChangeOrigin,
  ): Promise<void> {
    const role = this.roleOf(zone);
    if (!role?.group.enabled) return;
    if (role.role === 'primary') {
      const settable = Object.keys(changes).filter((k) => k !== 'pa' && k !== 'keypad');
      if (settable.length > 0) {
        await this.fanOut(role.group.id, { reReadFollowers: changes.power === true });
      }
    } else if (origin !== 'mirror') {
      await this.auditFollower(role.group.id, zone);
    }
  }

  /** Write a patch to one zone, in a safe order, updating the cache as each write is acknowledged. */
  private async writeZone(zone: ZoneId, patch: ZonePatch, origin: ChangeOrigin): Promise<void> {
    const writes = orderWrites(patch);
    if (writes.length === 0) return;
    if (!this.cache.get(zone)) await this.refreshZone(zone, 'high');
    const remaining = new Set(writes.map(([p]) => p));
    this.cache.markPending(zone, [...remaining]);
    const changes: Record<string, number | boolean> = {};
    try {
      for (const [prop, value] of writes) {
        await this.exec(() => this.driver.set(zone, prop, value), { priority: 'high' });
        this.cache.clearPending(zone, [prop]);
        remaining.delete(prop);
        if (this.cache.applyWrite(zone, prop, value)) changes[prop] = value;
      }
    } catch (err) {
      this.cache.clearPending(zone, [...remaining]);
      this.emit({ type: 'command.failed', zone, patch, error: errorMessage(err) });
      throw err;
    } finally {
      const state = this.cache.get(zone);
      if (state && Object.keys(changes).length > 0) {
        this.emit({ type: 'zone.changed', zone, changes: changes as ZonePatch, state, origin });
      }
    }
    // Mirror fan-out runs in the background: the caller gets its answer as
    // soon as its own zone is written; followers follow immediately after.
    this.track(this.reactToChange(zone, changes as ZonePatch, origin));
  }

  private async exec<T>(task: () => Promise<T>, options: RunOptions): Promise<T> {
    if (this.status !== 'connected') throw new NotConnectedError();
    try {
      const result = await this.queue.run(task, options);
      this.consecutiveTimeouts = 0;
      return result;
    } catch (err) {
      if (err instanceof DriverTimeoutError) {
        this.consecutiveTimeouts++;
        if (this.consecutiveTimeouts >= this.maxConsecutiveTimeouts) {
          this.linkLost(new Error(`amplifier stopped responding (${err.message})`));
        }
      }
      throw err;
    }
  }

  private async saveConfig(next: Config): Promise<void> {
    await this.store.save(next);
    this.config = next;
  }

  private assertInstalled(zone: ZoneId): void {
    if (!isValidZone(this.model, zone) || !this.units.includes(unitOf(zone))) {
      if (this.status !== 'connected') throw new NotConnectedError();
      throw new NotFoundError(`zone ${zone}`);
    }
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.catch((err) => this.logBackgroundError('background task', err));
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  private logBackgroundError(what: string, err: unknown): void {
    if (err instanceof NotConnectedError || err instanceof QueueClearedError) return;
    this.log.warn(`${what} failed: ${errorMessage(err)}`);
  }

  private emit(event: ControllerEvent): void {
    this.bus.emit(event);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
