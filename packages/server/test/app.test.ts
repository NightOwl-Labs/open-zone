import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Controller, MemoryConfigStore } from '@open-zone/core';
import { MonopriceDriver, MonopriceEmulator } from '@open-zone/drivers';
import { StreamerManager, type CastConnection, type CastClientEvents } from '@open-zone/streamers';
import { EventEmitter } from 'node:events';
import { buildApp } from '../src/app.ts';
import { JsonFileConfigStore } from '../src/config-file.ts';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(opts: { streamers?: StreamerManager } = {}) {
  const emulator = new MonopriceEmulator({ units: 2, keypadZones: [11, 12] });
  const driver = new MonopriceDriver(emulator.createTransport(), { timeoutMs: 40, retries: 0 });
  const controller = new Controller({
    driver,
    store: new MemoryConfigStore({ queue: { interCommandGapMs: 0 } }),
  });
  await controller.start();
  const app = await buildApp({
    controller,
    emulator,
    ...(opts.streamers && { streamers: opts.streamers }),
  });
  await app.ready();
  cleanup.push(
    () => controller.stop(),
    () => app.close(),
  );
  return { app, controller, emulator };
}

const json = (
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    ...(payload !== undefined && { payload: payload as object }),
  });

describe('REST API', () => {
  it('reports system info and zones', async () => {
    const { app } = await setup();
    const sys = (await json(app, 'GET', '/system')).json();
    expect(sys).toMatchObject({
      units: [1, 2],
      simulator: true,
      connection: { status: 'connected' },
    });
    const zones = (await json(app, 'GET', '/zones')).json();
    expect(zones).toHaveLength(12);
  });

  it('patches a zone and validates input', async () => {
    const { app, emulator } = await setup();
    const res = await json(app, 'PATCH', '/zones/13', { power: true, volume: 22 });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toMatchObject({ power: true, volume: 22 });
    expect(emulator.getZone(13).volume).toBe(22);
    const bad = await json(app, 'PATCH', '/zones/13', { volume: 99 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0]).toMatch(/volume/);
    expect((await json(app, 'PATCH', '/zones/31', { power: true })).statusCode).toBe(404);
  });

  it('renames zones and sources', async () => {
    const { app } = await setup();
    expect((await json(app, 'PUT', '/zones/11/name', { name: 'Kitchen' })).json().name).toBe(
      'Kitchen',
    );
    await json(app, 'PUT', '/sources/3/name', { name: 'Vinyl' });
    expect((await json(app, 'GET', '/sources')).json()[2]).toEqual({
      source: 3,
      name: 'Vinyl',
      enabled: true,
      color: null,
    });
    expect((await json(app, 'PUT', '/zones/11/name', { nope: 1 })).statusCode).toBe(400);
  });

  it('enables and disables zones', async () => {
    const { app } = await setup();
    const res = await json(app, 'PATCH', '/zones/16/config', { enabled: false });
    expect(res.json()).toMatchObject({ zone: 16, enabled: false });
    expect((await json(app, 'PATCH', '/zones/16', { power: true })).statusCode).toBe(400);
    await json(app, 'POST', '/mirrors', { primary: 13, followers: [14] });
    expect((await json(app, 'PATCH', '/zones/14/config', { enabled: false })).statusCode).toBe(409);
  });

  it('sets zone and source colors and the tile color mode', async () => {
    const { app } = await setup();
    expect((await json(app, 'PATCH', '/zones/11/config', { color: 'teal' })).json()).toMatchObject({
      zone: 11,
      color: 'teal',
      name: null,
    });
    expect((await json(app, 'PATCH', '/sources/2', { color: 'amber' })).json()).toMatchObject({
      source: 2,
      color: 'amber',
    });
    expect((await json(app, 'PATCH', '/zones/11/config', { color: 'plaid' })).statusCode).toBe(400);
    expect((await json(app, 'PATCH', '/zones/11/config', { color: null })).json().color).toBe(null);
    const cfg = await json(app, 'PATCH', '/config', { appearance: { tileColors: 'zone' } });
    expect(cfg.json().appearance).toEqual({ tileColors: 'zone' });
    expect(
      (await json(app, 'PATCH', '/config', { appearance: { tileColors: 'rainbow' } })).statusCode,
    ).toBe(400);
  });

  it('enables and disables sources', async () => {
    const { app } = await setup();
    const res = await json(app, 'PATCH', '/sources/5', { enabled: false, name: 'Aux' });
    expect(res.json()).toEqual({ source: 5, name: 'Aux', enabled: false, color: null });
    expect((await json(app, 'PATCH', '/zones/11', { source: 5 })).statusCode).toBe(400);
    expect((await json(app, 'PATCH', '/sources/5', { bogus: 1 })).statusCode).toBe(400);
  });

  it('stores per-follower volume offsets and bounds them', async () => {
    const { app } = await setup();
    const res = await json(app, 'POST', '/mirrors', {
      primary: 11,
      followers: [{ zone: 13, volumeOffset: 4 }],
    });
    expect(res.json().followers).toEqual([{ zone: 13, volumeOffset: 4 }]);
    const bad = await json(app, 'POST', '/mirrors', {
      primary: 14,
      followers: [{ zone: 15, volumeOffset: 50 }],
    });
    expect(bad.statusCode).toBe(400);
  });

  it('manages mirror groups, rejecting keypad followers with 409', async () => {
    const { app } = await setup();
    const conflict = await json(app, 'POST', '/mirrors', { primary: 13, followers: [12] });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().issues.join()).toMatch(/keypad/);
    const created = await json(app, 'POST', '/mirrors', {
      primary: 11,
      followers: [13, 14],
      name: 'Down',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await json(app, 'PATCH', `/mirrors/${id}`, { enabled: false })).json().enabled).toBe(
      false,
    );
    expect((await json(app, 'DELETE', `/mirrors/${id}`)).statusCode).toBe(204);
    expect((await json(app, 'GET', `/mirrors/${id}`)).statusCode).toBe(404);
  });

  it('simulates keypad presses in simulator mode', async () => {
    const { app, emulator } = await setup();
    const res = await json(app, 'POST', '/simulator/keypad', {
      zone: 21,
      patch: { volume: 30 },
      keypad: true,
    });
    expect(res.statusCode).toBe(204);
    expect(emulator.getZone(21)).toMatchObject({ volume: 30, keypad: true });
  });

  it('serves one manifest that starts at the root (the device remembers its design)', async () => {
    const { app } = await setup();
    const m = await app.inject({ url: '/api/v1/manifest.webmanifest?root=/console/' });
    expect(m.headers['content-type']).toMatch(/manifest\+json/);
    expect(m.json()).toMatchObject({ start_url: '/', scope: '/' });
  });

  it('mutes all and lowers all, then undoes each', async () => {
    const { app, emulator } = await setup();
    await json(app, 'PATCH', '/zones/11', { power: true, volume: 20 });
    expect((await json(app, 'POST', '/zones/mute-all')).json().muted).toEqual([11]);
    expect(emulator.getZone(11).mute).toBe(true);
    expect((await json(app, 'GET', '/snapshot')).json().system.quiet.muted).toEqual([11]);
    expect((await json(app, 'POST', '/zones/unmute-all')).json().muted).toEqual([]);
    expect(emulator.getZone(11).mute).toBe(false);
    const lowered = await json(app, 'POST', '/zones/lower-all', { steps: 4 });
    expect(lowered.json().lowered).toEqual([{ zone: 11, from: 20, to: 16 }]);
    await json(app, 'POST', '/zones/restore-volume');
    expect(emulator.getZone(11).volume).toBe(20);
    expect((await json(app, 'POST', '/zones/lower-all', { steps: 0 })).statusCode).toBe(400);
  });

  it('links a discovered streamer to a source and serves what it plays', async () => {
    const CCA = '5a683509b32cd1fb5fbabd79315b5ac5';
    const conn = Object.assign(new EventEmitter<CastClientEvents>(), {
      connect: async () => {},
      close: () => {},
      queryMultizone: async () => [CCA],
    }) satisfies CastConnection;
    const streamers = new StreamerManager({
      discover: async () => [
        {
          instance: '5._googlecast._tcp.local',
          host: 'cca.local',
          port: 8009,
          addresses: ['192.168.4.50'],
          txt: { id: CCA, fn: '5', md: 'Chromecast Audio' },
        },
      ],
      connect: () => conn,
    });
    cleanup.push(async () => streamers.stop());
    const { app, controller } = await setup({ streamers });
    controller.bus.on('streamers.updated', (e) => streamers.setLinks(e.streamers));

    const found = (await json(app, 'GET', '/streamers/discover')).json();
    expect(found).toEqual([
      {
        type: 'cast',
        deviceId: CCA,
        name: '5',
        model: 'Chromecast Audio',
        address: '192.168.4.50',
        isGroup: false,
      },
    ]);
    const created = await json(app, 'POST', '/streamers', {
      type: 'cast',
      deviceId: CCA,
      name: '5',
      source: 5,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    // Same source or same device again: rejected.
    expect(
      (
        await json(app, 'POST', '/streamers', {
          type: 'cast',
          deviceId: 'a'.repeat(32),
          name: 'X',
          source: 5,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await json(app, 'POST', '/streamers', { type: 'cast', deviceId: CCA, name: '5', source: 4 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await json(app, 'POST', '/streamers', { type: 'cast', deviceId: CCA, name: '5', source: 9 }))
        .statusCode,
    ).toBe(400);

    await vi.waitFor(() => expect(streamers.status()[0]?.state).toBe('connected'));
    conn.emit('nowPlaying', {
      app: 'YouTube Music',
      state: 'playing',
      title: 'Song',
      artist: 'Band',
      album: null,
      artUrl: 'https://art/x.jpg',
      position: 1,
      duration: 100,
      at: Date.now(),
    });
    const snap = (await json(app, 'GET', '/snapshot')).json();
    expect(snap.streamers).toMatchObject({
      enabled: true,
      links: [{ id, deviceId: CCA, source: 5 }],
      status: [{ id, state: 'connected', address: '192.168.4.50' }],
      nowPlaying: [{ source: 5, title: 'Song', artist: 'Band' }],
    });
    expect((await json(app, 'PATCH', `/streamers/${id}`, { source: 3 })).json().source).toBe(3);
    expect(streamers.nowPlaying()).toMatchObject([{ source: 3, title: 'Song' }]);
    expect((await json(app, 'DELETE', `/streamers/${id}`)).statusCode).toBe(204);
    expect(streamers.nowPlaying()).toEqual([]);
    expect((await json(app, 'DELETE', `/streamers/${id}`)).statusCode).toBe(404);
  });

  it('works without the streamer integration', async () => {
    const { app } = await setup();
    expect((await json(app, 'GET', '/streamers/discover')).json()).toEqual([]);
    expect((await json(app, 'GET', '/snapshot')).json().streamers).toEqual({
      links: [],
      status: [],
      nowPlaying: [],
      enabled: false,
    });
  });

  it('sets a subwoofer follower level', async () => {
    const { app, emulator } = await setup();
    await json(app, 'PATCH', '/zones/11', { power: true, volume: 20 });
    const created = await json(app, 'POST', '/mirrors', {
      primary: 11,
      followers: [{ zone: 14, sub: true }],
    });
    expect(created.json().followers).toEqual([{ zone: 14, volumeOffset: 0, sub: true }]);
    const id = created.json().id;
    const res = await json(app, 'PUT', `/mirrors/${id}/followers/14/level`, { volumeOffset: 3 });
    expect(res.json().followers).toEqual([{ zone: 14, volumeOffset: 3, sub: true }]);
    await vi.waitFor(() => expect(emulator.getZone(14).volume).toBe(23));
    expect(
      (await json(app, 'PUT', `/mirrors/${id}/followers/14/level`, { volumeOffset: 40 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await json(app, 'PUT', `/mirrors/${id}/followers/15/level`, { volumeOffset: 1 })).statusCode,
    ).toBe(404);
  });

  it('turns all zones off and manages scenes', async () => {
    const { app, emulator } = await setup();
    await json(app, 'PATCH', '/zones/13', { power: true });
    const off = await json(app, 'POST', '/zones/all-off');
    expect(off.json().applied).toContain(13);
    expect(emulator.getZone(13).power).toBe(false);
    const created = await json(app, 'POST', '/scenes', {
      name: 'Dinner',
      source: 2,
      zones: [{ zone: 13, volume: 15 }],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await json(app, 'POST', `/scenes/${id}/activate`)).json().applied).toEqual([13]);
    expect(emulator.getZone(13)).toMatchObject({ power: true, source: 2, volume: 15 });
    expect(
      (await json(app, 'POST', '/scenes', { name: 'Bad', source: 2, zones: [] })).statusCode,
    ).toBe(400);
    expect((await json(app, 'DELETE', `/scenes/${id}`)).statusCode).toBe(204);
  });

  it('updates the home name', async () => {
    const { app } = await setup();
    const res = await json(app, 'PATCH', '/config', { home: { name: 'Lake House' } });
    expect(res.json().home).toEqual({ name: 'Lake House' });
    expect((await json(app, 'GET', '/snapshot')).json().config.home.name).toBe('Lake House');
    expect(
      (await json(app, 'PATCH', '/config', { home: { name: 'x'.repeat(41) } })).statusCode,
    ).toBe(400);
  });

  it('updates polling settings', async () => {
    const { app } = await setup();
    const res = await json(app, 'PATCH', '/config', { polling: { mirrorPrimaryMs: 750 } });
    expect(res.json().polling.mirrorPrimaryMs).toBe(750);
    expect(
      (await json(app, 'PATCH', '/config', { polling: { mirrorPrimaryMs: 5 } })).statusCode,
    ).toBe(400);
  });
});

describe('WebSocket events', () => {
  it('sends a snapshot, then live events, and registers an interactive client', async () => {
    const { app, controller } = await setup();
    const messages: Array<{ type: string; [k: string]: unknown }> = [];
    const ws = await app.injectWS(
      '/api/v1/events',
      {},
      {
        onInit: (socket) => socket.on('message', (d) => messages.push(JSON.parse(String(d)))),
      },
    );
    await vi.waitFor(() => expect(messages[0]?.type).toBe('snapshot'));
    expect(controller.getSystem().polling.interactiveClients).toBe(1);
    await json(app, 'PATCH', '/zones/15', { power: true });
    await vi.waitFor(() =>
      expect(
        messages.some((m) => m.type === 'zone.changed' && m.zone === 15 && m.origin === 'api'),
      ).toBe(true),
    );
    ws.terminate();
    await vi.waitFor(() => expect(controller.getSystem().polling.interactiveClients).toBe(0));
  });
});

describe('JsonFileConfigStore', () => {
  it('returns defaults when missing, writes atomically, skips unchanged writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oz-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const store = new JsonFileConfigStore(join(dir, 'nested', 'config.json'));
    const config = await store.load();
    expect(config.mirrors).toEqual([]);
    await store.save({ ...config, zones: { '11': { name: 'Patio', enabled: true } } });
    const onDisk = JSON.parse(await readFile(store.path, 'utf8'));
    expect(onDisk.zones['11'].name).toBe('Patio');
    expect((await new JsonFileConfigStore(store.path).load()).zones['11']?.name).toBe('Patio');
  });

  it('refuses to load a corrupt file rather than overwriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oz-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'config.json'), '{ nope');
    await expect(new JsonFileConfigStore(join(dir, 'config.json')).load()).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
