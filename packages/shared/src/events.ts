import type { MirrorGroup } from './config.ts';
import type { ZoneId, ZonePatch, ZoneState } from './model.ts';
import type { SourceView } from './views.ts';

/** What caused a state change. */
export type ChangeOrigin =
  /** A request through the controller API (REST, WS, future integrations). */
  | 'api'
  /** The controller propagating a mirror master's state to a child. */
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
  | { type: 'zone.renamed'; zone: ZoneId; name: string | null }
  | { type: 'source.updated'; source: SourceView }
  | { type: 'mirror.updated'; group: MirrorGroup }
  | { type: 'mirror.deleted'; groupId: string }
  | { type: 'mirror.offsetChanged'; groupId: string; zone: ZoneId; volumeOffset: number }
  | {
      type: 'mirror.childDetached';
      groupId: string;
      zone: ZoneId;
      reason: DetachReason;
      property?: string;
    }
  | { type: 'connection.changed'; status: ConnectionStatus; error?: string }
  | { type: 'command.failed'; zone?: ZoneId; patch?: ZonePatch; error: string };

export type ControllerEventType = ControllerEvent['type'];
