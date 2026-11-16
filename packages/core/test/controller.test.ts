import { afterEach, describe, expect, it, vi } from 'vitest';
import { PatchValidationError, type ControllerEvent, type ZonePatch } from '@open-zone/shared';
import { MonopriceDriver, MonopriceEmulator, type EmulatorOptions } from '@open-zone/drivers';
import {
  Controller,
  MemoryConfigStore,
  MirrorValidationError,
  NotFoundError,
} from '../src/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running: Controller[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((c) => c.stop()));
});

async function setup(
  opts: {
    amp?: EmulatorOptions;
    config?: Record<string, unknown>;
    before?: (amp: MonopriceEmulator) => void;
  } = {},
) {
  const amp = new MonopriceEmulator({ units: 2, ...opts.amp });
  opts.before?.(amp);
  const driver = new MonopriceDriver(amp.createTransport(), { timeoutMs: 40, retries: 0 });
  const store = new MemoryConfigStore({
    queue: { interCommandGapMs: 0 },
    polling: { mirrorMasterMs: 100, mirrorChildAuditMs: 250, interactiveMs: 250 },
    ...opts.config,
  });
  let n = 0;
  const ctl = new Controller({
    driver,
    store,
    reconnect: { initialMs: 20, maxMs: 50 },
    newId: () => `g${++n}`,
  });
  const events: ControllerEvent[] = [];
  ctl.bus.subscribe((e) => events.push(e));
  running.push(ctl);
  await ctl.start();
  const sets = () => amp.received.filter((c) => c.startsWith('<'));
  const ofType = <T extends ControllerEvent['type']>(type: T) =>
    events.filter((e): e is Extract<ControllerEvent, { type: T }> => e.type === type);
  return { amp, ctl, store, events, sets, ofType };
}

const on: ZonePatch = { power: true };

describe('Controller: connection and polling', () => {
  it('discovers stacked units and stays idle with no mirrors and no clients', async () => {
    const { ctl, amp } = await setup();
    expect(ctl.getSystem().units).toEqual([1, 2]);
    expect(ctl.getZones().map((z) => z.zone)).toEqual([
      11, 12, 13, 14, 15, 16, 21, 22, 23, 24, 25, 26,
    ]);
    const after = amp.received.length;
    await sleep(300);
    expect(amp.received.length).toBe(after);
  });

  it('sweeps all units while an interactive client is connected', async () => {
    const { ctl, amp } = await setup();
    const unitQueries = () => amp.received.filter((c) => c === '?10').length;
    const release = ctl.addClient();
    await vi.waitFor(() => expect(unitQueries()).toBeGreaterThanOrEqual(2), { timeout: 1000 });
    expect(ctl.getZone(11).state).not.toBeNull();
    release();
    const count = unitQueries();
    await sleep(400);
    expect(unitQueries()).toBeLessThanOrEqual(count + 1);
  });

  it('reconnects after the link drops', async () => {
    const { ctl, amp, ofType } = await setup();
    amp.dropLink();
    await vi.waitFor(() =>
      expect(ofType('connection.changed').some((e) => e.status === 'disconnected')).toBe(true),
    );
    await vi.waitFor(() => expect(ctl.getSystem().connection.status).toBe('connected'));
  });

  it('treats repeated timeouts as a lost amp and recovers when it answers again', async () => {
    const { ctl, amp } = await setup();
    amp.setResponding(false);
    for (let i = 0; i < 3; i++) await ctl.refreshZone(11).catch(() => {});
    expect(ctl.getSystem().connection.status).not.toBe('connected');
    amp.setResponding(true);
    await vi.waitFor(() => expect(ctl.getSystem().connection.status).toBe('connected'), {
      timeout: 2000,
    });
  });
});

describe('Controller: zone commands and naming', () => {
  it('writes requested properties power first, emitting only real changes', async () => {
    const { ctl, amp, sets, ofType } = await setup();
    const view = await ctl.setZone(11, { volume: 20, power: true });
    expect(sets()).toEqual(['<11PR01', '<11VO20']);
    expect(view.state).toMatchObject({ power: true, volume: 20 });
    expect(amp.getZone(11)).toMatchObject({ power: true, volume: 20 });
    await ctl.setZone(11, { volume: 20 });
    expect(sets()).toHaveLength(3); // re-sent: the cache may be stale
    expect(ofType('zone.changed').filter((e) => e.origin === 'api')).toHaveLength(1);
  });

  it('validates input', async () => {
    const { ctl } = await setup();
    await expect(ctl.setZone(11, { volume: 39 })).rejects.toBeInstanceOf(PatchValidationError);
    await expect(ctl.setZone(31, on)).rejects.toBeInstanceOf(NotFoundError);
    await expect(ctl.setZone(17, on)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('names zones and sources, persisting them', async () => {
    const { ctl, store, ofType } = await setup();
    expect((await ctl.renameZone(11, '  Kitchen ')).name).toBe('Kitchen');
    await ctl.renameSource(2, 'Turntable');
    expect(store.current.zones['11']).toEqual({ name: 'Kitchen' });
    expect(ctl.getSources()[1]).toEqual({ source: 2, name: 'Turntable', enabled: true });
    await ctl.renameZone(11, '');
    expect(store.current.zones['11']).toBeUndefined();
    expect(ofType('zone.renamed').map((e) => e.name)).toEqual(['Kitchen', null]);
    await expect(ctl.renameSource(7, 'x')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Controller: source enable/disable', () => {
  it('disables sources, rejects them from the API, but lets mirrors and keypads use them', async () => {
    const { ctl, amp, store, ofType } = await setup();
    const v = await ctl.updateSource(4, { enabled: false });
    expect(v).toEqual({ source: 4, name: null, enabled: false });
    expect(store.current.sources['4']).toEqual({ enabled: false });
    expect(ofType('source.updated')[0]?.source).toEqual(v);
    await expect(ctl.setZone(11, { source: 4 })).rejects.toThrow(/source 4 is disabled/);
    // A keypad picks the disabled source on a master: the mirror still follows.
    amp.pressKeypad(11, { power: true });
    await ctl.createMirror({ master: 11, children: [12] });
    await ctl.whenIdle();
    amp.pressKeypad(11, { source: 4 });
    await vi.waitFor(() => expect(amp.getZone(12).source).toBe(4));
  });

  it('keeps the name when toggling and refuses to disable every source', async () => {
    const { ctl } = await setup();
    await ctl.updateSource(2, { name: 'Sonos' });
    expect(await ctl.updateSource(2, { enabled: false })).toEqual({
      source: 2,
      name: 'Sonos',
      enabled: false,
    });
    expect(await ctl.updateSource(2, { enabled: true })).toEqual({
      source: 2,
      name: 'Sonos',
      enabled: true,
    });
    for (const s of [1, 2, 3, 4, 5]) await ctl.updateSource(s, { enabled: false });
    await expect(ctl.updateSource(6, { enabled: false })).rejects.toThrow(/at least one source/);
  });
});

describe('Controller: mirror setup', () => {
  it('rejects children that have a wall keypad', async () => {
    const { ctl } = await setup({ amp: { keypadZones: [12] } });
    await expect(ctl.createMirror({ master: 11, children: [12] })).rejects.toThrow(/keypad/);
    await expect(ctl.createMirror({ master: 12, children: [13] })).resolves.toMatchObject({
      master: 12,
    });
  });

  it('rejects overlapping groups', async () => {
    const { ctl } = await setup();
    await ctl.createMirror({ master: 11, children: [12] });
    await expect(ctl.createMirror({ master: 12, children: [13] })).rejects.toBeInstanceOf(
      MirrorValidationError,
    );
  });

  it('syncs children to the master on creation', async () => {
    const { ctl, amp } = await setup();
    amp.pressKeypad(11, { power: true, volume: 25, source: 3, bass: 9 });
    const group = await ctl.createMirror({ master: 11, children: [12, 21], name: 'Downstairs' });
    await ctl.whenIdle();
    expect(group).toMatchObject({ id: 'g1', name: 'Downstairs', enabled: true });
    for (const z of [12, 21]) {
      expect(amp.getZone(z)).toMatchObject({ power: true, volume: 25, source: 3, bass: 9 });
    }
    expect(ctl.getZone(12).mirror).toEqual({ groupId: 'g1', role: 'child', volumeOffset: 0 });
  });
});

describe('Controller: mirror propagation', () => {
  async function mirrored() {
    const t = await setup();
    t.amp.pressKeypad(11, { power: true, volume: 20, source: 2 });
    await t.ctl.createMirror({ master: 11, children: [12, 13] });
    await t.ctl.whenIdle();
    return t;
  }

  it('pushes API changes on the master to children immediately; the next poll does nothing', async () => {
    const { ctl, amp, sets } = await mirrored();
    const before = sets().length;
    await ctl.setZone(11, { volume: 30 });
    await ctl.whenIdle();
    expect(sets().slice(before).sort()).toEqual(['<11VO30', '<12VO30', '<13VO30']);
    expect(amp.getZone(13).volume).toBe(30);
    await sleep(350); // several master polls and a child audit
    expect(sets().length).toBe(before + 3);
  });

  it('picks up keypad changes on the master by polling', async () => {
    const { amp } = await mirrored();
    amp.pressKeypad(11, { source: 5, volume: 18, mute: true });
    await vi.waitFor(() => {
      expect(amp.getZone(12)).toMatchObject({ source: 5, volume: 18, mute: true });
      expect(amp.getZone(13)).toMatchObject({ source: 5, volume: 18, mute: true });
    });
  });

  it('turns an out-of-band child volume change into an offset', async () => {
    const { ctl, amp, store, ofType } = await mirrored();
    amp.pressKeypad(12, { volume: 24 });
    await vi.waitFor(() => expect(ofType('mirror.offsetChanged')).toHaveLength(1), {
      timeout: 1500,
    });
    expect(store.current.mirrors[0]?.children.find((c) => c.zone === 12)?.volumeOffset).toBe(4);
    await ctl.setZone(11, { volume: 10 });
    await ctl.whenIdle();
    expect(amp.getZone(12).volume).toBe(14);
    expect(amp.getZone(13).volume).toBe(10);
    await ctl.setZone(11, { volume: 37 });
    await ctl.whenIdle();
    expect(amp.getZone(12).volume).toBe(38); // clamped
  });

  it('detaches a child whose other settings change out-of-band', async () => {
    const { ctl, amp, ofType } = await mirrored();
    amp.pressKeypad(13, { source: 6 });
    await vi.waitFor(() => expect(ofType('mirror.childDetached')).toHaveLength(1), {
      timeout: 1500,
    });
    expect(ofType('mirror.childDetached')[0]).toMatchObject({
      zone: 13,
      reason: 'property-changed',
      property: 'source',
    });
    expect(ctl.getZone(13).mirror).toBeNull();
    await ctl.setZone(11, { source: 1 });
    await ctl.whenIdle();
    expect(amp.getZone(12).source).toBe(1);
    expect(amp.getZone(13).source).toBe(6);
  });

  it('applies the same rules to API changes made directly on a child', async () => {
    const { ctl, ofType } = await mirrored();
    await ctl.setZone(12, { volume: 15 });
    await ctl.whenIdle();
    expect(ofType('mirror.offsetChanged')[0]).toMatchObject({ zone: 12, volumeOffset: -5 });
    await ctl.setZone(13, { treble: 3 });
    await ctl.whenIdle();
    expect(ofType('mirror.childDetached')[0]).toMatchObject({ zone: 13, property: 'treble' });
  });

  it('detaches a child when a keypad is connected to it', async () => {
    const { amp, ofType } = await mirrored();
    amp.setKeypadConnected(12, true);
    await vi.waitFor(
      () =>
        expect(ofType('mirror.childDetached')[0]).toMatchObject({
          zone: 12,
          reason: 'keypad-detected',
        }),
      {
        timeout: 1500,
      },
    );
  });

  it('applies a volume offset set in the mirror editor', async () => {
    const { ctl, amp, store } = await mirrored();
    await ctl.updateMirror('g1', { children: [{ zone: 12, volumeOffset: -6 }, 13] });
    await ctl.whenIdle();
    expect(amp.getZone(12).volume).toBe(14);
    expect(amp.getZone(13).volume).toBe(20);
    expect(store.current.mirrors[0]?.children).toEqual([
      { zone: 12, volumeOffset: -6 },
      { zone: 13, volumeOffset: 0 },
    ]);
    await ctl.setZone(11, { volume: 30 });
    await ctl.whenIdle();
    expect(amp.getZone(12).volume).toBe(24);
  });

  it('stops pushing when a group is disabled and resyncs when re-enabled', async () => {
    const { ctl, amp } = await mirrored();
    await ctl.updateMirror('g1', { enabled: false });
    amp.pressKeypad(11, { volume: 5 });
    await sleep(250);
    expect(amp.getZone(12).volume).toBe(20);
    await ctl.updateMirror('g1', { enabled: true });
    await ctl.whenIdle();
    expect(amp.getZone(12).volume).toBe(5);
  });
});

describe('Controller: power handling and recovery', () => {
  it('does not judge children while master and child are both off; full resync on power-on', async () => {
    const { ctl, amp, ofType } = await setup({ amp: { ignoreSetsWhenOff: true } });
    amp.pressKeypad(11, { volume: 20 });
    await ctl.createMirror({ master: 11, children: [12] });
    await ctl.whenIdle();
    amp.pressKeypad(12, { volume: 3, source: 4 }); // drift while idle
    await sleep(400);
    expect(ofType('mirror.childDetached')).toHaveLength(0);
    expect(ofType('mirror.offsetChanged')).toHaveLength(0);
    amp.pressKeypad(11, { power: true });
    await vi.waitFor(() =>
      expect(amp.getZone(12)).toMatchObject({ power: true, volume: 20, source: 1 }),
    );
    expect(ofType('mirror.childDetached')).toHaveLength(0);
  });

  it('restores persisted mirrors on startup (power-loss recovery)', async () => {
    const { amp } = await setup({
      config: { mirrors: [{ id: 'saved', master: 11, children: [{ zone: 12, volumeOffset: 2 }] }] },
      before: (a) => a.pressKeypad(11, { power: true, volume: 10, source: 4 }),
    });
    await vi.waitFor(() =>
      expect(amp.getZone(12)).toMatchObject({ power: true, volume: 12, source: 4 }),
    );
    amp.pressKeypad(11, { volume: 15 });
    await vi.waitFor(() => expect(amp.getZone(12).volume).toBe(17));
  });

  it('resyncs mirrors after reconnecting', async () => {
    const { ctl, amp } = await setup();
    amp.pressKeypad(11, { power: true });
    await ctl.createMirror({ master: 11, children: [12] });
    await ctl.whenIdle();
    amp.dropLink();
    amp.pressKeypad(11, { source: 3 });
    await vi.waitFor(() => expect(amp.getZone(12).source).toBe(3), { timeout: 2000 });
  });
});
