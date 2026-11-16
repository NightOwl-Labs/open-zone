import { Socket } from 'node:net';
import { Listeners, type Transport } from './transport.ts';

/** Raw TCP link to an IP-to-serial bridge (e.g. Global Caché, ser2net). */
export class TcpTransport implements Transport {
  readonly description: string;
  private socket: Socket | undefined;
  private readonly data = new Listeners<[string]>();
  private readonly closed = new Listeners<[Error | undefined]>();
  private closing = false;
  private readonly host: string;
  private readonly port: number;

  constructor(opts: { host: string; port: number }) {
    this.host = opts.host;
    this.port = opts.port;
    this.description = `tcp://${opts.host}:${opts.port}`;
  }

  get isOpen(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    const socket = new Socket();
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(this.port, this.host, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    this.closing = false;
    socket.on('data', (buf) => this.data.emit(buf.toString('latin1')));
    socket.on('close', () => {
      this.socket = undefined;
      if (!this.closing) this.closed.emit(new Error('TCP connection closed'));
    });
    socket.on('error', () => {
      /* 'close' follows and reports */
    });
    this.socket = socket;
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    this.closing = true;
    const s = this.socket;
    await new Promise<void>((resolve) => s.end(resolve));
    s.destroy();
    this.socket = undefined;
  }

  async write(data: string): Promise<void> {
    const s = this.socket;
    if (!s) throw new Error(`${this.description} is not open`);
    await new Promise<void>((resolve, reject) =>
      s.write(Buffer.from(data, 'latin1'), (err) => (err ? reject(err) : resolve())),
    );
  }

  onData(listener: (chunk: string) => void): () => void {
    return this.data.add(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.closed.add(listener);
  }
}
