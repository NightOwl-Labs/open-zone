import type { ConnectionStatus } from './events.ts';
import type { TileColor } from './config.ts';
import type { ModelDescriptor, SourceId, UnitId, ZoneId, ZoneState } from './model.ts';

export type MirrorRole =
  | { groupId: string; role: 'primary' }
  | { groupId: string; role: 'follower'; volumeOffset: number; sub?: boolean };

/** A zone as presented to API consumers. */
export interface ZoneView {
  zone: ZoneId;
  name: string | null;
  /** False for zones marked unused (no speakers). Hidden from controls. */
  enabled: boolean;
  /** Chosen tile color (used when tiles are colored by zone); null = default. */
  color: TileColor | null;
  /** Last known hardware state; null until the zone has been read. */
  state: ZoneState | null;
  /** Epoch ms of the last successful read or acknowledged write. */
  updatedAt: number | null;
  mirror: MirrorRole | null;
}

export interface SourceView {
  source: SourceId;
  name: string | null;
  /** False when hidden from source pickers. The amp cannot report which inputs are connected. */
  enabled: boolean;
  /** Chosen color; null = default for this source number. */
  color: TileColor | null;
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

/**
 * Temporary "quiet" changes made by Mute all / Lower all, so they can be undone.
 * Only zones the controller changed are listed; followers of a mirror follow
 * their primary and are never listed themselves.
 */
export interface QuietView {
  /** Zones muted by Mute all (they were unmuted before). */
  muted: ZoneId[];
  /** Zones lowered by Lower all: volume before (`from`) and after (`to`). */
  lowered: Array<{ zone: ZoneId; from: number; to: number }>;
}

export interface SystemView {
  model: ModelDescriptor;
  connection: { status: ConnectionStatus; error: string | null; transport: string };
  units: UnitId[];
  queue: QueueStats;
  polling: { mirrorActive: boolean; interactiveClients: number };
  quiet: QuietView;
  /** True when running against the built-in emulator instead of hardware. */
  simulator?: boolean;
}
