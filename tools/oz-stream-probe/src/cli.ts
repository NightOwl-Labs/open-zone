#!/usr/bin/env node
/**
 * oz-stream-probe — find network streamers and record what they report.
 * Read-only: it asks for status and never controls playback.
 *
 *   npm run probe:streamers                   # discover Chromecasts, watch each for 60 s
 *   npm run probe:streamers -- --seconds 120  # watch longer (change tracks meanwhile)
 *   npm run probe:streamers -- --host 192.168.1.42
 *
 * Writes stream-probe-report-<time>.md and .json in the current directory.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CAST_PORT,
  CastClient,
  browse,
  type CastMessage,
  type NowPlaying,
  type ServiceInstance,
} from '@open-zone/streamers';

const HELP = `oz-stream-probe — discover streamers and record their now-playing data

Options:
  --host <ip>        Skip discovery and probe this Cast device
  --port <n>         Port for --host (default 8009; Cast groups use their own port)
  --seconds <n>      How long to watch each device (default 60)
  --discover <ms>    How long to listen for mDNS answers (default 3000)
  --out <dir>        Where to write the report (default: current directory)
  --help, -h         Show this help
`;

interface DeviceLog {
  name: string;
  model: string | null;
  address: string;
  port: number;
  connected: boolean;
  error: string | null;
  apps: string[];
  nowPlaying: NowPlaying[];
  /** Metadata fields seen per app, e.g. { Spotify: ["title","artist",...] }. */
  fieldsByApp: Record<string, string[]>;
  messages: Array<{
    t: number;
    dir: 'in' | 'out';
    ns: string;
    from: string;
    to: string;
    payload: unknown;
  }>;
}

const stamp = () => new Date().toISOString().slice(11, 19);

function describe(np: NowPlaying | null): string {
  if (!np) return 'nothing casting';
  const what = [np.title, np.artist, np.album].filter(Boolean).join(' — ') || '(no track details)';
  return `${np.app ?? 'unknown app'} · ${np.state} · ${what}${np.artUrl ? ' · art ✓' : ''}`;
}

async function watch(
  device: { name: string; model: string | null; address: string; port: number },
  seconds: number,
) {
  const log: DeviceLog = {
    ...device,
    connected: false,
    error: null,
    apps: [],
    nowPlaying: [],
    fieldsByApp: {},
    messages: [],
  };
  const client = new CastClient(device.address, device.port);
  let currentApp = 'unknown';
  client.on('message', (dir, m: CastMessage) => {
    let payload: unknown = m.payload;
    try {
      payload = JSON.parse(m.payload);
    } catch {
      /* keep raw */
    }
    if (m.namespace.endsWith('heartbeat')) return; // noise
    log.messages.push({
      t: Date.now(),
      dir,
      ns: m.namespace,
      from: m.sourceId,
      to: m.destinationId,
      payload,
    });
    // Record which metadata fields each app actually sends.
    const status = (payload as { type?: string; status?: Array<{ media?: { metadata?: object } }> })
      ?.status;
    const md = Array.isArray(status) ? status[0]?.media?.metadata : undefined;
    if (md) {
      const app = currentApp;
      log.fieldsByApp[app] = [
        ...new Set([...(log.fieldsByApp[app] ?? []), ...Object.keys(md)]),
      ].sort();
    }
  });
  client.on('receiver', (apps) => {
    const casting = apps.find((a) => !a.isIdleScreen);
    currentApp = casting?.displayName ?? casting?.appId ?? 'unknown';
    for (const a of apps) {
      const n = a.displayName ?? a.appId;
      if (!log.apps.includes(n)) log.apps.push(n);
    }
  });
  client.on('nowPlaying', (np) => {
    if (np) log.nowPlaying.push(np);
    console.log(`  ${stamp()}  ${device.name}: ${describe(np)}`);
  });
  try {
    await client.connect();
    log.connected = true;
    console.log(`  ${stamp()}  ${device.name}: connected`);
    const refresh = setInterval(() => client.refresh(), 10_000);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(refresh);
  } catch (err) {
    log.error = err instanceof Error ? err.message : String(err);
    console.log(`  ${stamp()}  ${device.name}: ${log.error}`);
  } finally {
    client.close();
  }
  return log;
}

function markdown(devices: DeviceLog[], discovered: ServiceInstance[], seconds: number): string {
  const lines = [
    `# Streamer probe report`,
    '',
    `Generated ${new Date().toISOString()}; watched each device for ${seconds} s.`,
    '',
    `## Discovered (${discovered.length})`,
    '',
    '| Name | Model | Address | TXT keys |',
    '| ---- | ----- | ------- | -------- |',
    ...discovered.map(
      (d) =>
        `| ${d.txt.fn ?? d.instance} | ${d.txt.md ?? '—'} | ${d.addresses.join(', ') || '—'}:${d.port ?? '—'} | ${Object.keys(d.txt).join(', ')} |`,
    ),
    '',
  ];
  for (const d of devices) {
    lines.push(`## ${d.name}`, '');
    lines.push(
      `- Model: ${d.model ?? '—'}`,
      `- Connected: ${d.connected ? 'yes' : `no (${d.error})`}`,
    );
    lines.push(`- Apps seen: ${d.apps.join(', ') || 'none'}`);
    for (const [app, fields] of Object.entries(d.fieldsByApp)) {
      lines.push(`- Metadata fields from ${app}: ${fields.join(', ')}`);
    }
    lines.push(`- Now-playing updates: ${d.nowPlaying.length}`, '');
    if (d.nowPlaying.length) {
      lines.push('| Time | App | State | Title | Artist | Album | Art | Position / duration |');
      lines.push('| ---- | --- | ----- | ----- | ------ | ----- | --- | ------------------- |');
      for (const n of d.nowPlaying) {
        lines.push(
          `| ${new Date(n.at).toISOString().slice(11, 19)} | ${n.app ?? '—'} | ${n.state} | ${n.title ?? '—'} | ${n.artist ?? '—'} | ${n.album ?? '—'} | ${n.artUrl ? 'yes' : 'no'} | ${n.position ?? '—'} / ${n.duration ?? '—'} |`,
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string', default: String(CAST_PORT) },
      seconds: { type: 'string', default: '60' },
      discover: { type: 'string', default: '3000' },
      out: { type: 'string', default: process.cwd() },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const seconds = Number(values.seconds);
  let discovered: ServiceInstance[] = [];
  let targets: Array<{ name: string; model: string | null; address: string; port: number }>;
  if (values.host) {
    const port = Number(values.port);
    targets = [{ name: `${values.host}:${port}`, model: null, address: values.host, port }];
  } else {
    console.log(`Looking for Cast devices (${Number(values.discover) / 1000} s)…`);
    discovered = await browse('_googlecast._tcp.local', { timeoutMs: Number(values.discover) });
    for (const d of discovered) {
      console.log(
        `  • ${d.txt.fn ?? d.instance} — ${d.txt.md ?? 'unknown model'} at ${d.addresses.join(', ') || d.host}:${d.port}`,
      );
    }
    if (discovered.length === 0) {
      console.log(
        'No Cast devices answered. Check that this machine is on the same network, or pass --host <ip>.',
      );
    }
    targets = discovered
      .filter((d) => d.addresses[0] && d.port)
      .map((d) => ({
        name: d.txt.fn ?? d.instance,
        model: d.txt.md ?? null,
        address: d.addresses[0]!,
        port: d.port!,
      }));
  }
  if (targets.length === 0) return 1;
  console.log(
    `\nWatching ${targets.length} device(s) for ${seconds} s. Play, pause or skip tracks now to capture changes.\n`,
  );
  const devices = await Promise.all(targets.map((t) => watch(t, seconds)));
  const base = join(
    values.out,
    `stream-probe-report-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  writeFileSync(`${base}.json`, JSON.stringify({ discovered, devices }, null, 2));
  writeFileSync(`${base}.md`, markdown(devices, discovered, seconds));
  console.log(`\nReport: ${base}.md\n        ${base}.json`);
  return devices.some((d) => d.connected) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
