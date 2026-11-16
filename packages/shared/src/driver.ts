import type { ModelDescriptor, SettableProp, UnitId, ZoneId, ZoneState } from './model.ts';

/**
 * A model-specific amplifier driver.
 *
 * Callers must serialize calls (the core's CommandQueue does this): a driver
 * may assume at most one request is in flight at a time.
 */
export interface AmpDriver {
  readonly model: ModelDescriptor;
  open(): Promise<void>;
  close(): Promise<void>;
  readonly isOpen: boolean;
  /** Called when the underlying link drops unexpectedly. Returns an unsubscribe function. */
  onDisconnect(listener: (error?: Error) => void): () => void;
  /** Units (1-based) that answer on this link. */
  discoverUnits(): Promise<UnitId[]>;
  queryZone(zone: ZoneId): Promise<ZoneState>;
  queryUnit(unit: UnitId): Promise<ZoneState[]>;
  set(zone: ZoneId, prop: SettableProp, value: number | boolean): Promise<void>;
}

export class DriverTimeoutError extends Error {
  readonly command: string;
  readonly received: string;
  constructor(command: string, received: string) {
    super(`Timed out waiting for response to ${JSON.stringify(command)}`);
    this.name = 'DriverTimeoutError';
    this.command = command;
    this.received = received;
  }
}
