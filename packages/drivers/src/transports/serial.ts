import { Listeners, type Transport } from './transport.ts';

export interface SerialTransportOptions {
  path: string;
  baudRate: number;
}

type SerialPortInstance = import('serialport').SerialPort;

/**
 * USB-RS232 (or native UART) transport, 8N1, no flow control.
 * `serialport` is loaded lazily so the rest of the system (and tests) never
 * need the native binding.
 */
export class SerialTransport implements Transport {
  readonly description: string;
  private port: SerialPortInstance | undefined;
  private readonly data = new Listeners<[string]>();
  private readonly closed = new Listeners<[Error | undefined]>();
  private closing = false;
  private readonly opts: SerialTransportOptions;

  constructor(opts: SerialTransportOptions) {
    this.opts = opts;
    this.description = `${opts.path} @ ${opts.baudRate}`;
  }

  get isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    const { SerialPort } = await import('serialport');
    const port = new SerialPort({
      path: this.opts.path,
      baudRate: this.opts.baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      rtscts: false,
      autoOpen: false,
    });
    await new Promise<void>((resolve, reject) =>
      port.open((err) => (err ? reject(err) : resolve())),
    );
    this.closing = false;
    port.on('data', (buf: Buffer) => this.data.emit(buf.toString('latin1')));
    port.on('close', (err?: Error | null) => {
      if (!this.closing) this.closed.emit(err ?? new Error('Serial port closed'));
    });
    port.on('error', (err: Error) => {
      if (!this.closing) this.closed.emit(err);
    });
    this.port = port;
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) return;
    this.closing = true;
    await new Promise<void>((resolve) => port.close(() => resolve()));
    this.port = undefined;
  }

  async write(data: string): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) throw new Error(`${this.description} is not open`);
    await new Promise<void>((resolve, reject) =>
      port.write(Buffer.from(data, 'latin1'), (err) => (err ? reject(err) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      port.drain((err) => (err ? reject(err) : resolve())),
    );
  }

  onData(listener: (chunk: string) => void): () => void {
    return this.data.add(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.closed.add(listener);
  }
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  /** Best-effort chipset guess from the USB vendor id. */
  chipset?: string;
}

const CHIPSETS: Record<string, string> = {
  '0403': 'FTDI',
  '067b': 'Prolific PL2303',
  '10c4': 'Silicon Labs CP210x',
  '1a86': 'WCH CH340/CH341',
};

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const { SerialPort } = await import('serialport');
  const ports = await SerialPort.list();
  return ports.map((p) => {
    const info: SerialPortInfo = { path: p.path };
    if (p.manufacturer) info.manufacturer = p.manufacturer;
    if (p.serialNumber) info.serialNumber = p.serialNumber;
    if (p.vendorId) info.vendorId = p.vendorId.toLowerCase();
    if (p.productId) info.productId = p.productId.toLowerCase();
    const chipset = info.vendorId ? CHIPSETS[info.vendorId] : undefined;
    if (chipset) info.chipset = chipset;
    return info;
  });
}
