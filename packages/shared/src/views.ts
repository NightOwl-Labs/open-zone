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

export type PlayState = 'playing' | 'paused' | 'buffering' | 'idle';

/** What the streamer linked to a source is playing. */
export interface NowPlayingView {
  source: SourceId;
  streamerId: string;
  /** App doing the casting, e.g. "YouTube Music". */
  app: string | null;
  state: PlayState;
  title: string | null;
  artist: string | null;
  album: string | null;
  /** http(s) URL of the cover art (largest available). */
  artUrl: string | null;
  /** Seconds into the track at `at`. */
  position: number | null;
  duration: number | null;
  /** Epoch ms observed. */
  at: number;
  /** Speaker group the device is playing in, if any (details then come from the group). */
  group: string | null;
}

export type StreamerState = 'searching' | 'connecting' | 'connected' | 'offline';

/** Live connection status of a linked streamer. */
export interface StreamerStatusView {
  id: string;
  state: StreamerState;
  /** Current network address, once found. */
  address: string | null;
  error: string | null;
}

/** A streamer found on the network (Settings → Streamers → Find). */
export interface DiscoveredStreamer {
  type: 'cast';
  deviceId: string;
  name: string;
  model: string | null;
  address: string | null;
  /** Speaker groups can't be linked; their members are followed automatically. */
  isGroup: boolean;
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
