import type { ConnectionStatus } from './events.ts';
import type { ModelDescriptor, SourceId, UnitId, ZoneId, ZoneState } from './model.ts';

export type MirrorRole =
  { groupId: string; role: 'master' } | { groupId: string; role: 'child'; volumeOffset: number };

/** A zone as presented to API consumers. */
export interface ZoneView {
  zone: ZoneId;
  name: string | null;
  /** Last known hardware state; null until the zone has been read. */
  state: ZoneState | null;
  /** Epoch ms of the last successful read or acknowledged write. */
  updatedAt: number | null;
  mirror: MirrorRole | null;
}

export interface SourceView {
  source: SourceId;
  name: string | null;
}

export interface QueueStats {
  depth: number;
  completed: number;
  failed: number;
  lastMs: number | null;
  /** Exponentially weighted moving average of command duration. */
  avgMs: number | null;
  maxMs: number | null;
}

export interface SystemView {
  model: ModelDescriptor;
  connection: { status: ConnectionStatus; error: string | null; transport: string };
  units: UnitId[];
  queue: QueueStats;
  polling: { mirrorActive: boolean; interactiveClients: number };
}
