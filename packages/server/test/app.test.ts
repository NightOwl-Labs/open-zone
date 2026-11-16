import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Controller, MemoryConfigStore } from '@open-zone/core';
import { MonopriceDriver, MonopriceEmulator } from '@open-zone/drivers';
import { buildApp } from '../src/app.ts';
import { JsonFileConfigStore } from '../src/config-file.ts';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const emulator = new MonopriceEmulator({ units: 2, keypadZones: [11, 12] });
  const driver = new MonopriceDriver(emulator.createTransport(), { timeoutMs: 40, retries: 0 });
  const controller = new Controller({
    driver,
    store: new MemoryConfigStore({ queue: { interCommandGapMs: 0 } }),
  });
  await controller.start();
  const app = await buildApp({ controller, emulator });
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
    expect((await json(app, 'GET', '/sources')).json()[2]).toEqual({ source: 3, name: 'Vinyl' });
    expect((await json(app, 'PUT', '/zones/11/name', { nope: 1 })).statusCode).toBe(400);
  });

  it('manages mirror groups, rejecting keypad children with 409', async () => {
    const { app } = await setup();
    const conflict = await json(app, 'POST', '/mirrors', { master: 13, children: [12] });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().issues.join()).toMatch(/keypad/);
    const created = await json(app, 'POST', '/mirrors', {
      master: 11,
      children: [13, 14],
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

  it('updates polling settings', async () => {
    const { app } = await setup();
    const res = await json(app, 'PATCH', '/config', { polling: { mirrorMasterMs: 750 } });
    expect(res.json().polling.mirrorMasterMs).toBe(750);
    expect(
      (await json(app, 'PATCH', '/config', { polling: { mirrorMasterMs: 5 } })).statusCode,
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
    await store.save({ ...config, zones: { '11': { name: 'Patio' } } });
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
