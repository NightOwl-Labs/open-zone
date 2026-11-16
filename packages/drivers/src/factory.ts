import type { AmpDriver, Config } from '@open-zone/shared';
import { MonopriceDriver, type MonopriceDriverOptions } from './monoprice/driver.ts';
import { MonopriceEmulator } from './monoprice/emulator.ts';
import { SerialTransport } from './transports/serial.ts';
import { TcpTransport } from './transports/tcp.ts';
import type { Transport } from './transports/transport.ts';

export interface CreatedDevice {
  driver: AmpDriver;
  transport: Transport;
  /** Present when the transport is the built-in simulator. */
  emulator?: MonopriceEmulator;
}

export function createTransport(config: Config): {
  transport: Transport;
  emulator?: MonopriceEmulator;
} {
  const t = config.device.transport;
  switch (t.type) {
    case 'serial':
      return { transport: new SerialTransport({ path: t.path, baudRate: t.baudRate }) };
    case 'tcp':
      return { transport: new TcpTransport({ host: t.host, port: t.port }) };
    case 'simulator': {
      const emulator = new MonopriceEmulator({
        units: t.units,
        keypadZones: t.keypadZones,
        latencyMs: 15,
        baudRate: 9600,
      });
      return { transport: emulator.createTransport(), emulator };
    }
  }
}

export function createDevice(
  config: Config,
  driverOptions: Omit<MonopriceDriverOptions, 'timeoutMs' | 'retries'> = {},
): CreatedDevice {
  const { transport, emulator } = createTransport(config);
  const driver = new MonopriceDriver(transport, {
    ...driverOptions,
    timeoutMs: config.queue.commandTimeoutMs,
    retries: config.queue.retries,
  });
  return emulator ? { driver, transport, emulator } : { driver, transport };
}
