import { Listeners, type Transport } from '@open-zone/drivers';

export interface TrafficEntry {
  /** ms since the probe started */
  t: number;
  dir: 'tx' | 'rx';
  link: string;
  data: string;
}

const MAX_ENTRIES = 5000;

/** Shared, capped log of every byte sent and received during the probe. */
export class Transcript {
  readonly entries: TrafficEntry[] = [];
  dropped = 0;
  private readonly t0 = performance.now();

  now(): number {
    return Math.round((performance.now() - this.t0) * 10) / 10;
  }

  add(dir: 'tx' | 'rx', link: string, data: string): void {
    if (this.entries.length >= MAX_ENTRIES) {
      this.dropped++;
      return;
    }
    this.entries.push({ t: this.now(), dir, link, data });
  }
}

/** Transport wrapper that records all traffic into a Transcript. */
export class RecordingTransport implements Transport {
  private readonly inner: Transport;
  private readonly transcript: Transcript;
  private readonly data = new Listeners<[string]>();

  constructor(inner: Transport, transcript: Transcript) {
    this.inner = inner;
    this.transcript = transcript;
    inner.onData((chunk) => {
      transcript.add('rx', inner.description, chunk);
      this.data.emit(chunk);
    });
  }

  get description(): string {
    return this.inner.description;
  }

  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  open(): Promise<void> {
    return this.inner.open();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  write(data: string): Promise<void> {
    this.transcript.add('tx', this.inner.description, data);
    return this.inner.write(data);
  }

  onData(listener: (chunk: string) => void): () => void {
    return this.data.add(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.inner.onClose(listener);
  }
}

export interface RawResult {
  command: string;
  response: string;
  /** ms from write to first received byte, null if nothing came back */
  firstByteMs: number | null;
  /** ms from write to last received byte (or to the end of the wait) */
  lastByteMs: number | null;
}

/**
 * Protocol-agnostic exchange: send bytes, collect everything until the line
 * has been quiet for `quietMs` (or `maxMs` passes). Used to discover the
 * real response format rather than assume it.
 */
export async function rawExchange(
  transport: Transport,
  command: string,
  { quietMs = 250, maxMs = 2000 }: { quietMs?: number; maxMs?: number } = {},
): Promise<RawResult> {
  let response = '';
  let firstByteMs: number | null = null;
  let lastByteMs: number | null = null;
  const start = performance.now();
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const armQuiet = () => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(finish, quietMs);
  };
  const unsubscribe = transport.onData((chunk) => {
    const t = performance.now() - start;
    firstByteMs ??= t;
    lastByteMs = t;
    response += chunk;
    armQuiet();
  });
  const hardStop = setTimeout(finish, maxMs);
  // If nothing ever arrives, give up after maxMs; otherwise after quietMs of silence.
  try {
    await transport.write(command);
    await done;
  } finally {
    clearTimeout(quietTimer);
    clearTimeout(hardStop);
    unsubscribe();
  }
  const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
  return { command, response, firstByteMs: round(firstByteMs), lastByteMs: round(lastByteMs) };
}

/** Listen without sending anything; returns whatever arrives (unsolicited output). */
export async function listen(transport: Transport, ms: number): Promise<string> {
  let got = '';
  const unsubscribe = transport.onData((c) => (got += c));
  await new Promise((r) => setTimeout(r, ms));
  unsubscribe();
  return got;
}

/** Make control characters visible: "\r\n#>11..." → "\\r\\n#>11...". */
export function escapeBytes(s: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching control bytes
  return s.replace(/[\x00-\x1f\x7f-\xff]/g, (c) => {
    if (c === '\r') return '\\r';
    if (c === '\n') return '\\n';
    if (c === '\t') return '\\t';
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}
