import type { SettableProp, ZoneId, ZonePatch, ZoneState } from '@open-zone/shared';
import { Listeners, type Transport } from '../transports/transport.ts';
import { MONOPRICE_10761, formatStatus, parseCommand } from './codec.ts';

export interface EmulatorOptions {
  /** Number of stacked units present (1..3). */
  units?: number;
  /** Zones that report a connected wall keypad. */
  keypadZones?: readonly ZoneId[];
  /** Delay before the amp starts answering a command, in ms. */
  latencyMs?: number;
  /**
   * Simulate wire time at this baud rate (10 bits per byte). Leave undefined
   * for instant responses (fast tests).
   */
  baudRate?: number;
  /** Echo received commands back (the real amp does). */
  echo?: boolean;
  /** Ignore non-power set commands for zones that are powered off. */
  ignoreSetsWhenOff?: boolean;
}

/**
 * In-memory emulation of a stack of Monoprice 10761 amplifiers speaking the
 * RS-232 protocol. Used as the "simulator" device and to test the real driver.
 */
export class MonopriceEmulator {
  readonly units: number;
  private readonly zones = new Map<ZoneId, ZoneState>();
  private readonly opts: Required<Omit<EmulatorOptions, 'baudRate' | 'keypadZones'>> & {
    baudRate: number | undefined;
  };
  private readonly transports = new Set<EmulatorTransport>();
  /** Every command received, without the trailing CR. */
  readonly received: string[] = [];

  constructor(options: EmulatorOptions = {}) {
    this.units = options.units ?? 1;
    this.opts = {
      units: this.units,
      latencyMs: options.latencyMs ?? 0,
      baudRate: options.baudRate,
      echo: options.echo ?? true,
      ignoreSetsWhenOff: options.ignoreSetsWhenOff ?? false,
    };
    const keypads = new Set(options.keypadZones ?? []);
    for (let u = 1; u <= this.units; u++) {
      for (let i = 1; i <= MONOPRICE_10761.zonesPerUnit; i++) {
        const zone = u * 10 + i;
        this.zones.set(zone, {
          zone,
          pa: false,
          power: false,
          mute: false,
          dnd: false,
          volume: 10,
          treble: 7,
          bass: 7,
          balance: 10,
          source: 1,
          keypad: keypads.has(zone),
        });
      }
    }
  }

  createTransport(): Transport {
    const t = new EmulatorTransport(this);
    this.transports.add(t);
    return t;
  }

  getZone(zone: ZoneId): ZoneState {
    const z = this.zones.get(zone);
    if (!z) throw new Error(`Zone ${zone} not present`);
    return { ...z };
  }

  /** Simulate a change made at a wall keypad or the front panel (not via RS-232). */
  pressKeypad(zone: ZoneId, patch: ZonePatch): void {
    const z = this.zones.get(zone);
    if (!z) throw new Error(`Zone ${zone} not present`);
    Object.assign(z, patch);
  }

  setKeypadConnected(zone: ZoneId, connected: boolean): void {
    const z = this.zones.get(zone);
    if (!z) throw new Error(`Zone ${zone} not present`);
    z.keypad = connected;
  }

  private responding = true;

  /**
   * Stop (or resume) answering while the link stays up — what the host sees
   * when the amp loses power but the USB adapter does not.
   */
  setResponding(responding: boolean): void {
    this.responding = responding;
  }

  /** Simulate the serial link dropping (cable pulled, adapter unplugged). */
  dropLink(): void {
    for (const t of this.transports) t.drop();
  }

  /** @internal Process one command and return the bytes the amp sends back. */
  handle(raw: string): string {
    this.received.push(raw);
    if (!this.responding) return '';
    const echo = this.opts.echo ? `${raw}\r` : '';
    const cmd = parseCommand(raw);
    switch (cmd.kind) {
      case 'queryZone': {
        const z = this.zones.get(cmd.zone);
        return z ? `${echo}\r\n#${formatStatus(z)}\r\r\n#` : '';
      }
      case 'queryUnit': {
        if (cmd.unit < 1 || cmd.unit > this.units) return '';
        let out = echo;
        for (let i = 1; i <= MONOPRICE_10761.zonesPerUnit; i++) {
          out += `\r\n#${formatStatus(this.zones.get(cmd.unit * 10 + i)!)}\r`;
        }
        return `${out}\r\n#`;
      }
      case 'set': {
        const z = this.zones.get(cmd.zone);
        if (!z) return '';
        if (!(this.opts.ignoreSetsWhenOff && !z.power && cmd.prop !== 'power')) {
          applySet(z, cmd.prop, cmd.value);
        }
        return `${echo}\r\n#`;
      }
      case 'unknown':
        return `${echo}\r\n#`;
    }
  }

  /** @internal */
  get timing(): { latencyMs: number; baudRate: number | undefined } {
    return { latencyMs: this.opts.latencyMs, baudRate: this.opts.baudRate };
  }

  /** @internal */
  detach(t: EmulatorTransport): void {
    this.transports.delete(t);
  }
}

function applySet(z: ZoneState, prop: SettableProp, value: number): void {
  if (prop === 'power' || prop === 'mute' || prop === 'dnd') {
    z[prop] = value === 1;
    return;
  }
  const spec = MONOPRICE_10761.properties[prop];
  if (value >= spec.min && value <= spec.max) z[prop] = value;
}

class EmulatorTransport implements Transport {
  readonly description = 'monoprice-10761 emulator';
  private open_ = false;
  private pending = '';
  private readonly data = new Listeners<[string]>();
  private readonly closed = new Listeners<[Error | undefined]>();
  /** Time the emulated wire becomes free; responses are serialized on it. */
  private wireFreeAt = 0;
  private readonly amp: MonopriceEmulator;

  constructor(amp: MonopriceEmulator) {
    this.amp = amp;
  }

  get isOpen(): boolean {
    return this.open_;
  }

  async open(): Promise<void> {
    this.open_ = true;
  }

  async close(): Promise<void> {
    this.open_ = false;
    this.pending = '';
  }

  drop(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.closed.emit(new Error('Emulated link dropped'));
  }

  async write(data: string): Promise<void> {
    if (!this.open_) throw new Error('Emulator transport is not open');
    this.pending += data;
    let idx: number;
    while ((idx = this.pending.indexOf('\r')) !== -1) {
      const raw = this.pending.slice(0, idx).replace(/^\n+/, '');
      this.pending = this.pending.slice(idx + 1);
      if (raw.length === 0) continue;
      const response = this.amp.handle(raw);
      if (response) this.send(response, raw.length + 1);
    }
  }

  private send(response: string, requestBytes: number): void {
    const { latencyMs, baudRate } = this.amp.timing;
    const wireMs = (bytes: number) => (baudRate ? (bytes * 10 * 1000) / baudRate : 0);
    const now = Date.now();
    const start = Math.max(now + wireMs(requestBytes), this.wireFreeAt) + latencyMs;
    const done = start + wireMs(response.length);
    this.wireFreeAt = done;
    setTimeout(() => {
      if (this.open_) this.data.emit(response);
    }, done - now);
  }

  onData(listener: (chunk: string) => void): () => void {
    return this.data.add(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.closed.add(listener);
  }
}
