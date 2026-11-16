/** A byte-stream link to a device (serial port, TCP serial bridge, emulator). */
export interface Transport {
  /** Human-readable description, e.g. "/dev/amp0 @ 9600". */
  readonly description: string;
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: string): Promise<void>;
  /** Subscribe to received data. Returns an unsubscribe function. */
  onData(listener: (chunk: string) => void): () => void;
  /** Subscribe to unexpected closes. Returns an unsubscribe function. */
  onClose(listener: (error?: Error) => void): () => void;
}

/** Small helper so transports share listener bookkeeping. */
export class Listeners<T extends unknown[]> {
  private readonly set = new Set<(...args: T) => void>();
  add(fn: (...args: T) => void): () => void {
    this.set.add(fn);
    return () => this.set.delete(fn);
  }
  emit(...args: T): void {
    for (const fn of [...this.set]) fn(...args);
  }
}
