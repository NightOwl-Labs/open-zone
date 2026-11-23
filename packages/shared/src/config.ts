import { z } from 'zod';

export const CONFIG_SCHEMA_VERSION = 2;

const zoneKey = z.string().regex(/^\d{2}$/, 'zone keys are two-digit zone ids, e.g. "11"');
const sourceKey = z.string().regex(/^\d+$/, 'source keys are source numbers, e.g. "1"');
const name = z.string().trim().min(1).max(40);

export const SerialTransportConfigSchema = z.object({
  type: z.literal('serial'),
  path: z.string().min(1).default('/dev/amp0'),
  baudRate: z.number().int().positive().default(9600),
});

export const TcpTransportConfigSchema = z.object({
  type: z.literal('tcp'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
});

export const SimulatorTransportConfigSchema = z.object({
  type: z.literal('simulator'),
  units: z.number().int().min(1).max(3).default(3),
  /** Zones that report a connected keypad in the simulator. */
  keypadZones: z.array(z.number().int()).default([]),
});

export const TransportConfigSchema = z.discriminatedUnion('type', [
  SerialTransportConfigSchema,
  TcpTransportConfigSchema,
  SimulatorTransportConfigSchema,
]);

/** The 16 tile colors. Shades per volume live in the UI (packages/ui/src/designs/palette.ts). */
export const TILE_COLOR_IDS = [
  'red',
  'orange',
  'amber',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'magenta',
  'rose',
  'slate',
] as const;
export const TileColorSchema = z.enum(TILE_COLOR_IDS);

export const AppearanceConfigSchema = z.object({
  /** Tint zone tiles by the source they play, or give each zone its own color. */
  tileColors: z.enum(['source', 'zone']).default('source'),
});

export const MAX_VOLUME_OFFSET = 38;

export const MirrorFollowerSchema = z.object({
  zone: z.number().int(),
  /**
   * Follower volume = clamp(primary volume + offset). Set in the mirror editor, or
   * learned when the follower's volume is changed directly.
   */
  volumeOffset: z.number().int().min(-MAX_VOLUME_OFFSET).max(MAX_VOLUME_OFFSET).default(0),
  /**
   * Subwoofer follower: the zone's preamp output feeds a sub. It follows power,
   * source, mute, DND and volume (plus offset, i.e. the sub level), but keeps
   * its own treble, bass and balance so it can be tuned for the sub.
   */
  sub: z.boolean().optional(),
});

export const MirrorGroupSchema = z.object({
  id: z.string().min(1),
  name: name.optional(),
  enabled: z.boolean().default(true),
  primary: z.number().int(),
  followers: z.array(MirrorFollowerSchema).default([]),
});

/**
 * A network streamer linked to an amp source, so zones on that source can show
 * what it is playing. Linked by the device's own id, never by IP address.
 */
export const StreamerLinkSchema = z.object({
  id: z.string().min(1),
  type: z.literal('cast'),
  /** Cast device id as announced over mDNS (TXT `id`), lower case without dashes. */
  deviceId: z.string().regex(/^[0-9a-f]{32}$/, 'a 32-character Cast device id'),
  /** The device's name when it was linked; shown while it is offline. */
  name,
  source: z.number().int().min(1),
});

export const SceneZoneSchema = z.object({
  zone: z.number().int(),
  /** Preset volume for this zone (zones can differ: stereo vs mono, 4 vs 8 ohm). */
  volume: z.number().int().min(0),
});

export const SceneSchema = z.object({
  id: z.string().min(1),
  name,
  /** Every zone in the scene is switched to this source. */
  source: z.number().int().min(1),
  zones: z.array(SceneZoneSchema).min(1),
  /** Turn off every other (enabled) zone when the scene is activated. */
  othersOff: z.boolean().default(false),
});

export const PollingConfigSchema = z.object({
  /** How often mirror primary zones are polled while any mirror is enabled. */
  mirrorPrimaryMs: z.number().int().min(100).default(500),
  /** How often each mirror follower is audited (round-robin) while any mirror is enabled. */
  mirrorFollowerAuditMs: z.number().int().min(250).default(5000),
  /** How often all units are swept while at least one UI client is connected. */
  interactiveMs: z.number().int().min(250).default(2000),
});

export const QueueConfigSchema = z.object({
  /** Idle time enforced between consecutive commands on the wire. */
  interCommandGapMs: z.number().int().min(0).default(20),
  /** Max wait for a complete response. */
  commandTimeoutMs: z.number().int().min(50).default(1000),
  /** Retries after a timeout before the command is failed. */
  retries: z.number().int().min(0).max(5).default(1),
});

export const HomeConfigSchema = z.object({
  /** Shown at the top of every screen, e.g. "Lake House". */
  name: name.optional(),
});

export const ConfigObjectSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
  home: HomeConfigSchema.prefault({}),
  appearance: AppearanceConfigSchema.prefault({}),
  device: z
    .object({
      driver: z.literal('monoprice-10761').default('monoprice-10761'),
      transport: TransportConfigSchema.default({
        type: 'serial',
        path: '/dev/amp0',
        baudRate: 9600,
      }),
    })
    .prefault({}),
  polling: PollingConfigSchema.prefault({}),
  queue: QueueConfigSchema.prefault({}),
  zones: z
    .record(
      zoneKey,
      z.object({
        name: name.optional(),
        /**
         * Disabled zones (no speakers wired) are hidden from the UI, rejected by
         * the API and cannot join mirrors. The amp always reports 6 zones per unit.
         */
        enabled: z.boolean().default(true),
        /** Tile color when tiles are colored by zone. */
        color: TileColorSchema.optional(),
      }),
    )
    .default({}),
  sources: z
    .record(
      sourceKey,
      z.object({
        name: name.optional(),
        /** Disabled sources are hidden from zone source pickers and rejected by the API. */
        enabled: z.boolean().default(true),
        /** Color for this source (tiles colored by source, and source chips). */
        color: TileColorSchema.optional(),
      }),
    )
    .default({}),
  mirrors: z.array(MirrorGroupSchema).default([]),
  scenes: z.array(SceneSchema).default([]),
  streamers: z.array(StreamerLinkSchema).default([]),
});

/**
 * Upgrade older config files in place before validation.
 * v1 → v2: mirror groups used `master`/`children`; polling used
 * `mirrorMasterMs`/`mirrorChildAuditMs`. Renamed to primary/followers.
 */
export function migrateConfig(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const c: Record<string, unknown> = { ...input };
  if (c.schemaVersion === undefined || c.schemaVersion === 1) {
    if (Array.isArray(c.mirrors)) {
      c.mirrors = c.mirrors.map((g: unknown) => {
        if (typeof g !== 'object' || g === null) return g;
        const {
          ['master']: legacyPrimary,
          ['children']: legacyFollowers,
          ...rest
        } = g as Record<string, unknown>;
        return {
          ...rest,
          primary: rest.primary ?? legacyPrimary,
          followers: rest.followers ?? legacyFollowers,
        };
      });
    }
    if (typeof c.polling === 'object' && c.polling !== null) {
      const {
        ['mirrorMasterMs']: legacyPrimaryMs,
        ['mirrorChildAuditMs']: legacyAuditMs,
        ...polling
      } = c.polling as Record<string, unknown>;
      c.polling = {
        ...polling,
        ...(legacyPrimaryMs !== undefined && { mirrorPrimaryMs: legacyPrimaryMs }),
        ...(legacyAuditMs !== undefined && { mirrorFollowerAuditMs: legacyAuditMs }),
      };
    }
    c.schemaVersion = 2;
  }
  return c;
}

export const ConfigSchema = z.preprocess(migrateConfig, ConfigObjectSchema);

export type HomeConfig = z.infer<typeof HomeConfigSchema>;
export type AppearanceConfig = z.infer<typeof AppearanceConfigSchema>;
export type TileColor = z.infer<typeof TileColorSchema>;
export type TransportConfig = z.infer<typeof TransportConfigSchema>;
export type MirrorFollower = z.infer<typeof MirrorFollowerSchema>;
export type MirrorGroup = z.infer<typeof MirrorGroupSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type StreamerLink = z.infer<typeof StreamerLinkSchema>;
export type SceneZone = z.infer<typeof SceneZoneSchema>;
export type PollingConfig = z.infer<typeof PollingConfigSchema>;
export type QueueConfig = z.infer<typeof QueueConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

/** Parse (and fill defaults for) a config object. Throws ZodError on invalid input. */
export function parseConfig(input: unknown): Config {
  return ConfigSchema.parse(input ?? {});
}

export function defaultConfig(): Config {
  return parseConfig({});
}
