import {
  DriverTimeoutError,
  ZoneNotPresentError,
  zonesForUnit,
  type AmpDriver,
  type ModelDescriptor,
  type SettableProp,
  type UnitId,
  type ZoneId,
  type ZoneState,
} from '@open-zone/shared';
import { Listeners, type Transport } from '../transports/transport.ts';
import {
  MONOPRICE_10761,
  formatSet,
  formatUnitQuery,
  formatZoneQuery,
  parseStatusLines,
} from './codec.ts';

export interface MonopriceDriverOptions {
  /** Max wait for a complete response, per attempt. */
  timeoutMs?: number;
  /** Extra attempts after a timeout. */
  retries?: number;
  /** Use the batch "?u0" unit query; when false, query each zone individually. */
  useUnitQuery?: boolean;
  /** Raw traffic tap for diagnostics. */
  onTraffic?: (direction: 'tx' | 'rx', data: string) => void;
}

/**
 * How long the line must stay quiet before an echo + "#" with no status record
 * is taken to mean "no such zone". Status records arrive within ~16 ms of the
 * prompt (FTDI latency timer), so this leaves a wide margin.
 */
const ABSENT_QUIET_MS = 80;

/** Echo and prompt, but no status record: the amp has no such zone or unit. */
function onlyEchoAndPrompt(buf: string): boolean {
  return buf.includes('#') && !buf.includes('>');
}

/** True when a "#" prompt follows the last status record (the response is complete). */
function promptAfterLastStatus(buf: string): boolean {
  const last = buf.lastIndexOf('>');
  return last !== -1 && buf.indexOf('#', last) !== -1;
}

export class MonopriceDriver implements AmpDriver {
  readonly model: ModelDescriptor = MONOPRICE_10761;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly useUnitQuery: boolean;
  private readonly onTraffic: MonopriceDriverOptions['onTraffic'];
  private buffer = '';
  private waiter: { check: () => void; fail: (err: Error) => void } | undefined;
  private readonly disconnects = new Listeners<[Error | undefined]>();
  private unsubscribers: Array<() => void> = [];

  constructor(transport: Transport, options: MonopriceDriverOptions = {}) {
    this.transport = transport;
    this.timeoutMs = options.timeoutMs ?? 1000;
    this.retries = options.retries ?? 1;
    this.useUnitQuery = options.useUnitQuery ?? true;
    this.onTraffic = options.onTraffic;
  }

  get isOpen(): boolean {
    return this.transport.isOpen;
  }

  async open(): Promise<void> {
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [
      this.transport.onData((chunk) => {
        this.onTraffic?.('rx', chunk);
        this.buffer += chunk;
        this.waiter?.check();
      }),
      this.transport.onClose((err) => {
        this.waiter?.fail(err ?? new Error('Link closed'));
        this.disconnects.emit(err);
      }),
    ];
    await this.transport.open();
  }

  async close(): Promise<void> {
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
    await this.transport.close();
  }

  onDisconnect(listener: (error?: Error) => void): () => void {
    return this.disconnects.add(listener);
  }

  async discoverUnits(): Promise<UnitId[]> {
    const found: UnitId[] = [];
    for (let unit = 1; unit <= this.model.maxUnits; unit++) {
      try {
        await this.queryZone(unit * 10 + 1);
        found.push(unit);
      } catch (err) {
        if (!(err instanceof ZoneNotPresentError || err instanceof DriverTimeoutError)) throw err;
      }
    }
    return found;
  }

  async queryZone(zone: ZoneId): Promise<ZoneState> {
    const find = (buf: string) => parseStatusLines(buf).find((s) => s.zone === zone);
    return this.exchange(
      formatZoneQuery(zone),
      (buf) => (promptAfterLastStatus(buf) ? find(buf) : undefined),
      find,
      (buf, cmd) => (onlyEchoAndPrompt(buf) ? new ZoneNotPresentError(cmd) : undefined),
    );
  }

  async queryUnit(unit: UnitId): Promise<ZoneState[]> {
    const expected = zonesForUnit(this.model, unit);
    if (!this.useUnitQuery) {
      const out: ZoneState[] = [];
      for (const zone of expected) out.push(await this.queryZone(zone));
      return out;
    }
    const collect = (buf: string) => {
      const byZone = new Map(parseStatusLines(buf).map((s) => [s.zone, s]));
      return expected.every((z) => byZone.has(z)) ? expected.map((z) => byZone.get(z)!) : undefined;
    };
    return this.exchange(
      formatUnitQuery(unit),
      (buf) => (promptAfterLastStatus(buf) ? collect(buf) : undefined),
      collect,
      (buf, cmd) => (onlyEchoAndPrompt(buf) ? new ZoneNotPresentError(cmd) : undefined),
    );
  }

  async set(zone: ZoneId, prop: SettableProp, value: number | boolean): Promise<void> {
    const cmd = formatSet(zone, prop, value);
    const echo = cmd.slice(0, -1);
    await this.exchange(
      cmd,
      (buf) => {
        const at = buf.indexOf(echo);
        return at !== -1 && buf.indexOf('#', at + echo.length) !== -1 ? true : undefined;
      },
      (buf) => (buf.includes(echo) ? true : undefined),
    );
  }

  /**
   * Send a command and wait until `complete` returns a value. On timeout,
   * `fallback` may still salvage a usable result from what was received.
   */
  private async exchange<T>(
    cmd: string,
    complete: (buf: string) => T | undefined,
    fallback: (buf: string) => T | undefined,
    whenQuiet?: (buf: string, cmd: string) => Error | undefined,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.attempt(cmd, complete, fallback, whenQuiet);
      } catch (err) {
        if (!(err instanceof DriverTimeoutError)) throw err;
        lastError = err;
      }
    }
    throw lastError!;
  }

  private attempt<T>(
    cmd: string,
    complete: (buf: string) => T | undefined,
    fallback: (buf: string) => T | undefined,
    whenQuiet?: (buf: string, cmd: string) => Error | undefined,
  ): Promise<T> {
    if (!this.transport.isOpen) return Promise.reject(new Error('Driver is not open'));
    if (this.waiter)
      return Promise.reject(new Error('Concurrent request; calls must be serialized'));
    return new Promise<T>((resolve, reject) => {
      this.buffer = '';
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        clearTimeout(quiet);
        this.waiter = undefined;
      };
      const timer = setTimeout(() => {
        done();
        const salvaged = fallback(this.buffer);
        if (salvaged !== undefined) resolve(salvaged);
        else reject(new DriverTimeoutError(cmd, this.buffer));
      }, this.timeoutMs);
      this.waiter = {
        check: () => {
          const result = complete(this.buffer);
          if (result !== undefined) {
            done();
            resolve(result);
            return;
          }
          // An answer that stops short (echo + prompt, no data) means "not present".
          if (whenQuiet) {
            clearTimeout(quiet);
            quiet = setTimeout(() => {
              const err = whenQuiet(this.buffer, cmd);
              if (err) {
                done();
                reject(err);
              }
            }, ABSENT_QUIET_MS);
          }
        },
        fail: (err) => {
          done();
          reject(err);
        },
      };
      this.onTraffic?.('tx', cmd);
      this.transport.write(cmd).catch((err: Error) => {
        done();
        reject(err);
      });
    });
  }
}
