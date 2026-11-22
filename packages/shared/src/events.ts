import type { Config, MirrorGroup, Scene } from './config.ts';
import type { ZoneId, ZonePatch, ZoneState } from './model.ts';
import type { QuietView, SourceView } from './views.ts';

/** What caused a state change. */
export type ChangeOrigin =
  /** A request through the controller API (REST, WS, future integrations). */
  | 'api'
  /** The controller propagating a mirror primary's state to a follower. */
  | 'mirror'
  /** A difference discovered by polling (keypad, front panel, another controller). */
  | 'poll';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type DetachReason = 'property-changed' | 'keypad-detected' | 'zone-removed';

export type ControllerEvent =
  | {
      type: 'zone.changed';
      zone: ZoneId;
      /** Only the properties that changed (pa/keypad included when they change). */
      changes: ZonePatch & { pa?: boolean; keypad?: boolean };
      state: ZoneState;
      origin: ChangeOrigin;
    }
  | { type: 'zone.updated'; zone: ZoneId; name: string | null; enabled: boolean }
  | { type: 'source.updated'; source: SourceView }
  | { type: 'mirror.updated'; group: MirrorGroup }
  | { type: 'mirror.deleted'; groupId: string }
  | { type: 'mirror.offsetChanged'; groupId: string; zone: ZoneId; volumeOffset: number }
  | {
      type: 'mirror.followerDetached';
      groupId: string;
      zone: ZoneId;
      reason: DetachReason;
      property?: string;
    }
  | { type: 'config.updated'; config: Config }
  | { type: 'scene.updated'; scene: Scene }
  | { type: 'scene.deleted'; sceneId: string }
  | ({ type: 'scene.activated'; sceneId: string } & ActivationResult)
  | ({ type: 'zones.allOff' } & ActivationResult)
  | {
      type: 'quiet.changed';
      action: 'mute-all' | 'unmute-all' | 'lower-all' | 'restore-volume';
      quiet: QuietView;
      /** Zones commanded by this action. */
      applied: ZoneId[];
    }
  | { type: 'connection.changed'; status: ConnectionStatus; error?: string }
  | { type: 'command.failed'; zone?: ZoneId; patch?: ZonePatch; error: string };

/** Outcome of a scene activation or all-off. */
export interface ActivationResult {
  /** Zones that were commanded. */
  applied: ZoneId[];
  /** Zones left alone, with the reason (e.g. following a mirror, disabled). */
  skipped: Array<{ zone: ZoneId; reason: string }>;
}

export type ControllerEventType = ControllerEvent['type'];
