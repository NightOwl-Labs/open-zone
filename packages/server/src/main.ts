#!/usr/bin/env node
/**
 * open-zone server entry point.
 *
 *   npm start                     # real hardware (config: data/config.json)
 *   npm start -- --simulate       # built-in emulator (config: data/simulator/config.json)
 *
 * Options / environment:
 *   --port <n>    OZ_PORT      HTTP port (default 8080)
 *   --host <h>    OZ_HOST      bind address (default 0.0.0.0, all interfaces)
 *   --data <dir>  OZ_DATA_DIR  directory holding config.json
 */
import { hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Controller, type Logger } from '@open-zone/core';
import { createDevice } from '@open-zone/drivers';
import { buildApp } from './app.ts';
import { JsonFileConfigStore } from './config-file.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');

const { values } = parseArgs({
  options: {
    simulate: { type: 'boolean', default: false },
    port: { type: 'string' },
    host: { type: 'string' },
    data: { type: 'string' },
  },
});

const port = Number(values.port ?? process.env.OZ_PORT ?? 8080);
const host = values.host ?? process.env.OZ_HOST ?? '0.0.0.0';
const dataDir =
  values.data ??
  process.env.OZ_DATA_DIR ??
  join(repoRoot, 'data', values.simulate ? 'simulator' : '');

const stamp = () => new Date().toISOString().slice(11, 23);
const logger: Logger = {
  debug: (m, ...a) => process.env.OZ_DEBUG && console.debug(stamp(), 'debug', m, ...a),
  info: (m, ...a) => console.log(stamp(), m, ...a),
  warn: (m, ...a) => console.warn(stamp(), 'WARN', m, ...a),
  error: (m, ...a) => console.error(stamp(), 'ERROR', m, ...a),
};

const store = new JsonFileConfigStore(join(dataDir, 'config.json'));
let config = await store.load();
if (values.simulate && config.device.transport.type !== 'simulator') {
  // Three stacked units; zones x6 have no keypad so they can be mirror children.
  const keypadZones = [1, 2, 3].flatMap((u) => [1, 2, 3, 4, 5].map((i) => u * 10 + i));
  config = {
    ...config,
    device: { ...config.device, transport: { type: 'simulator', units: 3, keypadZones } },
  };
  await store.save(config);
}

const { driver, transport, emulator } = createDevice(config);
const controller = new Controller({
  driver,
  store,
  transportDescription: transport.description,
  logger,
});
controller.bus.on('connection.changed', (e) =>
  logger.info(`connection: ${e.status}${e.error ? ` (${e.error})` : ''}`),
);

await controller.start();
const app = await buildApp({
  controller,
  ...(emulator && { emulator }),
  uiDir: join(repoRoot, 'packages/ui/dist'),
});
await app.listen({ port, host });

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a!.address);
logger.info(`open-zone ${values.simulate ? '(SIMULATOR) ' : ''}listening on port ${port}`);
logger.info(`config: ${store.path}`);
for (const url of [
  `http://${hostname().replace(/\.local$/, '')}.local:${port}`,
  ...addresses.map((a) => `http://${a}:${port}`),
]) {
  logger.info(`  ${url}`);
}

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) process.exit(1);
  stopping = true;
  logger.info(`${signal}: shutting down`);
  await app.close();
  await controller.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
