import { describe, expect, it } from 'vitest';
import { DriverTimeoutError, ZoneNotPresentError } from '@open-zone/shared';
import { Listeners, type Transport } from '../src/index.ts';
import { MonopriceDriver, MonopriceEmulator } from '../src/index.ts';

async function setup(
  opts: ConstructorParameters<typeof MonopriceEmulator>[0] = {},
  timeoutMs = 100,
) {
  const amp = new MonopriceEmulator(opts);
  const driver = new MonopriceDriver(amp.createTransport(), { timeoutMs, retries: 0 });
  await driver.open();
  return { amp, driver };
}

describe('MonopriceDriver against the emulator', () => {
  it('queries a single zone', async () => {
    const { amp, driver } = await setup({ keypadZones: [12] });
    amp.pressKeypad(12, { power: true, volume: 22, source: 4 });
    const s = await driver.queryZone(12);
    expect(s).toMatchObject({ zone: 12, power: true, volume: 22, source: 4, keypad: true });
  });

  it('queries a whole unit', async () => {
    const { driver } = await setup({ units: 2 });
    const states = await driver.queryUnit(2);
    expect(states.map((s) => s.zone)).toEqual([21, 22, 23, 24, 25, 26]);
  });

  it('falls back to per-zone queries when unit queries are disabled', async () => {
    const amp = new MonopriceEmulator();
    const driver = new MonopriceDriver(amp.createTransport(), { useUnitQuery: false });
    await driver.open();
    expect((await driver.queryUnit(1)).length).toBe(6);
    expect(amp.received).toEqual(['?11', '?12', '?13', '?14', '?15', '?16']);
  });

  it('sets values that read back', async () => {
    const { amp, driver } = await setup();
    await driver.set(13, 'volume', 30);
    await driver.set(13, 'power', true);
    await driver.set(13, 'source', 5);
    expect(amp.getZone(13)).toMatchObject({ volume: 30, power: true, source: 5 });
    expect((await driver.queryZone(13)).volume).toBe(30);
  });

  it('discovers stacked units', async () => {
    const { driver } = await setup({ units: 2 }, 30);
    expect(await driver.discoverUnits()).toEqual([1, 2]);
  });

  it('reports a missing zone quickly when the amp answers with only echo + prompt', async () => {
    const { driver } = await setup({ units: 1 }, 1000);
    const t0 = Date.now();
    await expect(driver.queryZone(21)).rejects.toBeInstanceOf(ZoneNotPresentError);
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it('discovers a single unit without waiting out timeouts', async () => {
    const { driver } = await setup({ units: 1 }, 1000);
    const t0 = Date.now();
    expect(await driver.discoverUnits()).toEqual([1]);
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('waits for the status record that follows the prompt in a later chunk (real FTDI timing)', async () => {
    // Captured from hardware: "?11\r\n#" first, then ">11…\r\r\n#" ~16 ms later.
    const data = new Listeners<[string]>();
    let open = false;
    const transport: Transport = {
      description: 'chunked',
      get isOpen() {
        return open;
      },
      open: async () => {
        open = true;
      },
      close: async () => {
        open = false;
      },
      write: async (cmd) => {
        setTimeout(() => data.emit(`${cmd.trim()}\r\n#`), 5);
        setTimeout(() => data.emit('>1100000000151014100500\r\r\n#'), 40);
      },
      onData: (l) => data.add(l),
      onClose: () => () => {},
    };
    const driver = new MonopriceDriver(transport, { timeoutMs: 1000, retries: 0 });
    await driver.open();
    expect(await driver.queryZone(11)).toMatchObject({ zone: 11, volume: 15, source: 5 });
  });

  it('times out on zones that do not answer', async () => {
    const { driver } = await setup({ units: 1 }, 30);
    await expect(driver.queryZone(21)).rejects.toBeInstanceOf(DriverTimeoutError);
  });

  it('handles realistic wire timing at 9600 baud', async () => {
    const { driver } = await setup({ units: 1, latencyMs: 5, baudRate: 9600 }, 1000);
    const t0 = Date.now();
    await driver.queryUnit(1);
    // ~4 bytes out + ~170 bytes back at ~1 ms/byte
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it('rejects in-flight requests when the link drops', async () => {
    const { amp, driver } = await setup({ latencyMs: 50 }, 1000);
    let disconnected = false;
    driver.onDisconnect(() => (disconnected = true));
    const p = driver.queryZone(11);
    amp.dropLink();
    await expect(p).rejects.toThrow(/dropped/);
    expect(disconnected).toBe(true);
  });

  it('refuses concurrent requests', async () => {
    const { driver } = await setup({ latencyMs: 20 }, 1000);
    const a = driver.queryZone(11);
    await expect(driver.queryZone(12)).rejects.toThrow(/serialized/);
    await a;
  });
});
