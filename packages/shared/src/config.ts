import { z } from 'zod';

export const CONFIG_SCHEMA_VERSION = 1;

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

export const MirrorChildSchema = z.object({
  zone: z.number().int(),
  /** Child volume = clamp(master volume + offset). Learned from out-of-band volume changes. */
  volumeOffset: z.number().int().default(0),
});

export const MirrorGroupSchema = z.object({
  id: z.string().min(1),
  name: name.optional(),
  enabled: z.boolean().default(true),
  master: z.number().int(),
  children: z.array(MirrorChildSchema).default([]),
});

export const PollingConfigSchema = z.object({
  /** How often mirror master zones are polled while any mirror is enabled. */
  mirrorMasterMs: z.number().int().min(100).default(500),
  /** How often each mirror child is audited (round-robin) while any mirror is enabled. */
  mirrorChildAuditMs: z.number().int().min(250).default(5000),
  /** How often all units are swept while at least one UI client is connected. */
  interactiveMs: z.number().int().min(250).default(2000),
});

export const QueueConfigSchema = z.object({
  /** Idle time enforced between consecutive commands on the wire. */
  interCommandGapMs: z.number().int().min(0).default(50),
  /** Max wait for a complete response. */
  commandTimeoutMs: z.number().int().min(50).default(1000),
  /** Retries after a timeout before the command is failed. */
  retries: z.number().int().min(0).max(5).default(1),
});

export const ConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
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
  zones: z.record(zoneKey, z.object({ name })).default({}),
  sources: z.record(sourceKey, z.object({ name })).default({}),
  mirrors: z.array(MirrorGroupSchema).default([]),
});

export type TransportConfig = z.infer<typeof TransportConfigSchema>;
export type MirrorChild = z.infer<typeof MirrorChildSchema>;
export type MirrorGroup = z.infer<typeof MirrorGroupSchema>;
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
