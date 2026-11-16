import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { promisify } from 'node:util';
import {
  MonopriceDriver,
  MonopriceEmulator,
  SerialTransport,
  formatSet,
  listSerialPorts,
  type SerialPortInfo,
  type Transport,
} from '@open-zone/drivers';
import type { SettableProp, UnitId, ZoneId, ZoneState } from '@open-zone/shared';
import {
  RecordingTransport,
  listen,
  rawExchange,
  type RawResult,
  type Transcript,
} from './recorder.ts';
import { stats, type Report } from './report.ts';
import { detail, type Prompter } from './ui.ts';

export interface ProbeOptions {
  port: string | undefined;
  baud: number;
  timeoutMs: number;
  soakSeconds: number;
  allowWrites: boolean;
  testZone: ZoneId | undefined;
  simulate: boolean;
}

export interface Ctx {
  opts: ProbeOptions;
  ui: Prompter;
  report: Report;
  transcript: Transcript;
  transport: RecordingTransport;
  driver: MonopriceDriver;
  emulator?: MonopriceEmulator;
  units: UnitId[];
  zones: Map<ZoneId, ZoneState>;
  /** Original state of every zone the probe has written to, for restore. */
  originals: Map<ZoneId, ZoneState>;
  keypadZones: ZoneId[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const hasStatus = (r: RawResult) => />\d{22}/.test(r.response);

// ───────────────────────────── environment ─────────────────────────────

export async function checkEnvironment(report: Report): Promise<void> {
  report.section('1. Environment');
  const env = report.environment;
  env.node = process.version;
  env.platform = `${platform()} ${release()} (${arch()})`;
  try {
    env.board = (await readFile('/proc/device-tree/model', 'utf8')).replace(/\0/g, '').trim();
  } catch {
    env.board = 'unknown (not a Raspberry Pi, or /proc/device-tree unavailable)';
  }
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  const nodeOk = major > 22 || (major === 22 && minor >= 18);
  report.add({
    id: 'node-version',
    status: nodeOk ? 'pass' : 'fail',
    summary: `Node ${process.version} on ${env.platform}${env.board ? `, ${env.board}` : ''}`,
  });
  if (platform() === 'linux') {
    try {
      const { stdout } = await promisify(execFile)('id', ['-Gn']);
      const groups = stdout.trim().split(/\s+/);
      env.groups = groups.join(' ');
      const ok = groups.includes('dialout') || process.getuid?.() === 0;
      report.add({
        id: 'dialout-group',
        status: ok ? 'pass' : 'warn',
        summary: ok
          ? 'User can access serial ports (dialout group)'
          : 'User is not in the dialout group — run: sudo usermod -aG dialout $USER, then log out and in',
      });
    } catch {
      /* not fatal */
    }
  }
}

// ───────────────────────────── ports ─────────────────────────────

export async function choosePort(
  opts: ProbeOptions,
  ui: Prompter,
  report: Report,
): Promise<string | undefined> {
  report.section('2. Serial ports');
  let ports: SerialPortInfo[] = [];
  try {
    ports = await listSerialPorts();
  } catch (e) {
    report.add({ id: 'list-ports', status: 'warn', summary: `Could not list ports: ${errMsg(e)}` });
  }
  report.environment.ports = ports;
  for (const p of ports) {
    detail(
      `${p.path}  ${p.chipset ?? p.manufacturer ?? ''}  ${p.vendorId ? `${p.vendorId}:${p.productId}` : ''}  ${p.serialNumber ?? ''}`,
    );
  }
  const usb = ports.filter((p) => p.vendorId);
  const adapter = (path: string) => ports.find((p) => p.path === path);
  let chosen = opts.port;
  if (!chosen) {
    if (await exists('/dev/amp0')) chosen = '/dev/amp0';
    else if (usb.length === 1) chosen = usb[0]!.path;
    else if (usb.length > 1) chosen = await ui.ask('Which port is the amplifier on?', usb[0]!.path);
  }
  if (!chosen) {
    report.add({
      id: 'port',
      status: 'fail',
      summary:
        'No USB serial adapter found. Is it plugged in? Check `dmesg | tail` after plugging it in.',
    });
    report.find('USB-serial adapter chipset', 'no adapter found', 'fail');
    return undefined;
  }
  const info = adapter(chosen);
  const chipset = info?.chipset ?? (info?.vendorId ? `unknown vendor ${info.vendorId}` : 'unknown');
  const goodChip = info?.chipset === 'FTDI' || info?.chipset === 'Silicon Labs CP210x';
  report.add({
    id: 'port',
    status: info?.chipset ? (goodChip ? 'pass' : 'info') : 'info',
    summary: `Using ${chosen} (${chipset})`,
    data: { ...info },
  });
  report.find(
    'USB-serial adapter chipset',
    `${chipset}${info?.vendorId ? ` (${info.vendorId}:${info.productId}${info.serialNumber ? `, serial ${info.serialNumber}` : ''})` : ''}`,
    info?.chipset ? 'pass' : 'info',
  );
  if (info?.vendorId && info.productId) {
    const match = info.serialNumber ? `ATTRS{serial}=="${info.serialNumber}", ` : '';
    report.environment.udevRule = `SUBSYSTEM=="tty", ATTRS{idVendor}=="${info.vendorId}", ATTRS{idProduct}=="${info.productId}", ${match}SYMLINK+="amp0", GROUP="dialout", MODE="0660"`;
  }
  return chosen;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── link ─────────────────────────────

export function makeTransport(
  opts: ProbeOptions,
  path: string,
  baud: number,
  transcript: Transcript,
  emulator?: MonopriceEmulator,
): RecordingTransport {
  const inner: Transport = emulator
    ? emulator.createTransport()
    : new SerialTransport({ path, baudRate: baud });
  return new RecordingTransport(inner, transcript);
}

/** Open the port and find a baud rate the amp answers at. Returns the working transport. */
export async function establishLink(
  opts: ProbeOptions,
  path: string,
  report: Report,
  transcript: Transcript,
  emulator?: MonopriceEmulator,
): Promise<{ transport: RecordingTransport; baud: number } | undefined> {
  report.section('3. Link');
  const order = [opts.baud, ...BAUD_RATES.filter((b) => b !== opts.baud)];
  const tried: RawResult[] = [];
  for (const baud of order) {
    const transport = makeTransport(opts, path, baud, transcript, emulator);
    try {
      await transport.open();
    } catch (e) {
      const msg = errMsg(e);
      const hint = /EACCES|permission/i.test(msg)
        ? ' — add your user to the dialout group'
        : /EBUSY|locked/i.test(msg)
          ? ' — another program (ModemManager? a running open-zone?) has the port open'
          : '';
      report.add({ id: 'open', status: 'fail', summary: `Cannot open ${path}: ${msg}${hint}` });
      return undefined;
    }
    await listen(transport, 150); // let any power-on chatter drain
    const r = await rawExchange(transport, '?10\r', { quietMs: 300, maxMs: 1500 });
    const r2 = hasStatus(r)
      ? r
      : await rawExchange(transport, '?11\r', { quietMs: 300, maxMs: 1500 });
    tried.push(r, ...(r2 === r ? [] : [r2]));
    if (hasStatus(r) || hasStatus(r2)) {
      report.add({
        id: 'baud',
        status: baud === 9600 ? 'pass' : 'warn',
        summary: `Amplifier answers at ${baud} baud${baud !== 9600 ? ' (not the 9600 default — someone changed it)' : ''}`,
        raw: [r2 === r ? r : r2],
      });
      report.find('Working baud rate', String(baud), 'pass');
      return { transport, baud };
    }
    await transport.close();
    if (emulator) break;
  }
  const anyBytes = tried.some((r) => r.response.length > 0);
  report.add({
    id: 'baud',
    status: 'fail',
    summary: anyBytes
      ? 'Received bytes but no valid status at any baud rate — likely wrong baud or line noise. See raw capture.'
      : 'No response at any baud rate. Check: amp powered on; cable in the RS-232 port of unit 1 (the main unit); ' +
        'TX/RX crossing (try a null-modem adapter if using straight-through, or vice versa).',
    raw: tried.slice(0, 4),
  });
  report.find('Working baud rate', 'none — amplifier did not answer', 'fail');
  return undefined;
}

// ───────────────────────────── protocol format ─────────────────────────────

export async function checkFormat(ctx: Ctx): Promise<void> {
  const { report, transport } = ctx;
  report.section('4. Response format');
  const zone = await rawExchange(transport, '?11\r', { quietMs: 300 });
  const unit = await rawExchange(transport, '?10\r', { quietMs: 300 });
  const echo = zone.response.startsWith('?11');
  const prompt = zone.response.includes('#');
  const records = (unit.response.match(/>\d{22}/g) ?? []).length;
  report.add({
    id: 'format',
    status: echo && prompt ? 'pass' : 'warn',
    summary: `Echo: ${echo ? 'yes' : 'NO'}; "#" prompt: ${prompt ? 'yes' : 'NO'}; ?10 returned ${records} status record(s)`,
    raw: [zone, unit],
  });
  report.find(
    'Does the amp echo commands and end responses with "#"?',
    `echo=${echo}, prompt=${prompt}`,
    echo && prompt ? 'pass' : 'warn',
  );
  report.find(
    'Does the batch unit query (?10) return all 6 zones?',
    records === 6 ? 'yes' : `no — ${records} records (driver will use per-zone queries)`,
    records === 6 ? 'pass' : 'warn',
  );
}

export async function checkUnits(ctx: Ctx): Promise<void> {
  const { report, transport } = ctx;
  report.section('5. Stacked units');
  const raws: RawResult[] = [];
  const units: UnitId[] = [];
  let absent: RawResult | undefined;
  for (const u of [1, 2, 3]) {
    const r = await rawExchange(transport, `?${u}1\r`, { quietMs: 300, maxMs: 1500 });
    raws.push(r);
    if (hasStatus(r)) units.push(u);
    else absent ??= r;
  }
  ctx.units = units;
  report.add({
    id: 'units',
    status: units.length ? 'pass' : 'fail',
    summary: `Units answering: ${units.join(', ') || 'none'}`,
    raw: raws,
  });
  report.find('Stacked units detected', units.join(', ') || 'none', units.length ? 'pass' : 'fail');
  if (absent) {
    report.find(
      'What does the amp send for a unit that is not installed?',
      absent.response
        ? `"${absent.response.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`
        : 'nothing (silence)',
    );
  }
}

export async function readAllZones(ctx: Ctx): Promise<void> {
  const { report, driver } = ctx;
  report.section('6. Zone status (parsed by the open-zone driver)');
  const failures: string[] = [];
  for (const u of ctx.units) {
    try {
      for (const s of await driver.queryUnit(u)) ctx.zones.set(s.zone, s);
    } catch (e) {
      failures.push(`unit ${u}: ${errMsg(e)}`);
      for (let i = 1; i <= 6; i++) {
        try {
          const s = await driver.queryZone(u * 10 + i);
          ctx.zones.set(s.zone, s);
        } catch (e2) {
          failures.push(`zone ${u * 10 + i}: ${errMsg(e2)}`);
        }
      }
    }
  }
  console.log('      zone  pwr  mute dnd  vol  trb  bas  bal  src  keypad  pa');
  for (const s of ctx.zones.values()) {
    const b = (x: boolean) => (x ? 'on ' : '-  ');
    detail(
      `${s.zone}    ${b(s.power)}  ${b(s.mute)} ${b(s.dnd)} ${String(s.volume).padStart(3)}  ${String(s.treble).padStart(3)}  ${String(s.bass).padStart(3)}  ${String(s.balance).padStart(3)}  ${String(s.source).padStart(3)}  ${s.keypad ? 'yes   ' : 'no    '}  ${s.pa ? 'on' : '-'}`,
    );
  }
  report.add({
    id: 'parse',
    status: failures.length ? 'warn' : 'pass',
    summary: failures.length
      ? `Parsed ${ctx.zones.size} zones with ${failures.length} problem(s): ${failures.join('; ')}`
      : `Driver parsed all ${ctx.zones.size} zones`,
    data: { zones: [...ctx.zones.values()] },
  });
}

export async function checkKeypads(ctx: Ctx): Promise<void> {
  const { report, ui } = ctx;
  report.section('7. Keypad detection (LS field)');
  const reported = [...ctx.zones.values()].filter((s) => s.keypad).map((s) => s.zone);
  ctx.keypadZones = reported;
  if (!ui.interactive) {
    report.add({
      id: 'keypads',
      status: 'skip',
      summary: `Amp reports keypads on: ${reported.join(', ') || 'none'} (not confirmed — non-interactive run)`,
    });
    report.find(
      'Does the LS field reliably show which zones have keypads?',
      `reports ${reported.join(', ') || 'none'}; unconfirmed`,
      'skip',
    );
    return;
  }
  const answer = await ui.ask(
    'Which zones PHYSICALLY have a wall keypad connected? (comma-separated, "none" for none)',
    reported.join(',') || 'none',
  );
  const actual =
    answer === 'none'
      ? []
      : answer
          .split(/[,\s]+/)
          .map(Number)
          .filter(Boolean);
  const same = actual.length === reported.length && actual.every((z) => reported.includes(z));
  ctx.keypadZones = actual;
  report.add({
    id: 'keypads',
    status: same ? 'pass' : 'fail',
    summary: same
      ? `LS field matches reality: ${reported.join(', ') || 'none'}`
      : `LS field (${reported.join(', ') || 'none'}) does NOT match reality (${actual.join(', ') || 'none'}) — mirror setup cannot rely on it`,
    data: { reported, actual },
  });
  report.find(
    'Does the LS field reliably show which zones have keypads?',
    same
      ? 'yes'
      : `no — reported ${reported.join(',') || 'none'}, actual ${actual.join(',') || 'none'}`,
    same ? 'pass' : 'fail',
  );
}

// ───────────────────────────── timing ─────────────────────────────

export async function checkTiming(ctx: Ctx): Promise<void> {
  const { report, driver } = ctx;
  report.section('8. Timing (read-only)');
  const zoneIds = [...ctx.zones.keys()];
  const zoneT: number[] = [];
  const unitT: number[] = [];
  let failures = 0;
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    try {
      await driver.queryZone(zoneIds[i % zoneIds.length]!);
      zoneT.push(performance.now() - t);
    } catch {
      failures++;
    }
  }
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    try {
      await driver.queryUnit(ctx.units[i % ctx.units.length]!);
      unitT.push(performance.now() - t);
    } catch {
      failures++;
    }
  }
  const z = stats(zoneT);
  const u = stats(unitT);
  const sweep = u ? Math.round(u.avg * ctx.units.length) : null;
  report.add({
    id: 'timing',
    status: failures ? 'warn' : 'pass',
    summary:
      `Single-zone query avg ${z?.avg ?? '-'} ms (p95 ${z?.p95 ?? '-'}); ` +
      `unit query avg ${u?.avg ?? '-'} ms (p95 ${u?.p95 ?? '-'}); ` +
      `full sweep of ${ctx.units.length} unit(s) ≈ ${sweep ?? '-'} ms` +
      (failures ? `; ${failures} failures` : ''),
    data: { zoneQuery: z, unitQuery: u, fullSweepMs: sweep, failures },
  });
  if (z) {
    const busy = (primaries: number) => Math.round(((z.avg * primaries) / 500) * 100);
    report.find(
      'Bus time for a 500 ms mirror poll',
      `1 primary ≈ ${busy(1)}%, 2 primaries ≈ ${busy(2)}%, 3 primaries ≈ ${busy(3)}% of the bus`,
      busy(1) < 40 ? 'pass' : 'warn',
    );
    report.find(
      'Query timings (avg / p95)',
      `zone ${z.avg}/${z.p95} ms, unit ${u?.avg ?? '-'}/${u?.p95 ?? '-'} ms, full sweep ≈ ${sweep ?? '-'} ms`,
    );
  }
}

export async function checkGap(ctx: Ctx): Promise<void> {
  const { report, driver } = ctx;
  report.section('9. Back-to-back commands (read-only)');
  const zoneIds = [...ctx.zones.keys()];
  const results: Record<string, { ok: number; failed: number }> = {};
  let safe: number | undefined;
  for (const gap of [0, 10, 25, 50, 100]) {
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < 20; i++) {
      const zone = zoneIds[i % zoneIds.length]!;
      try {
        const s = await driver.queryZone(zone);
        if (s.zone === zone) ok++;
        else failed++;
      } catch {
        failed++;
        await sleep(300); // let the amp recover before continuing
      }
      if (gap) await sleep(gap);
    }
    results[`${gap}ms`] = { ok, failed };
    if (failed === 0 && safe === undefined) safe = gap;
  }
  report.add({
    id: 'gap',
    status: safe === undefined ? 'warn' : 'pass',
    summary:
      safe === undefined
        ? 'Errors at every gap tested — see data'
        : `Smallest gap with no errors: ${safe} ms (${Object.entries(results)
            .map(([g, r]) => `${g}: ${r.failed} err`)
            .join(', ')})`,
    data: results,
  });
  report.find(
    'Minimum safe gap between commands',
    safe === undefined ? 'none found up to 100 ms' : `${safe} ms`,
    safe === undefined ? 'warn' : 'pass',
  );
}

// ───────────────────────────── writes ─────────────────────────────

async function snapshot(ctx: Ctx, zone: ZoneId): Promise<ZoneState> {
  const s = await ctx.driver.queryZone(zone);
  if (!ctx.originals.has(zone)) ctx.originals.set(zone, s);
  return s;
}

/** Put every zone the probe touched back the way it was. */
export async function restoreAll(ctx: Ctx): Promise<string[]> {
  const problems: string[] = [];
  for (const [zone, original] of ctx.originals) {
    try {
      const now = await ctx.driver.queryZone(zone);
      const props = (
        ['volume', 'treble', 'bass', 'balance', 'source', 'mute', 'dnd'] as SettableProp[]
      ).filter((p) => now[p] !== original[p]);
      // power-on first so settings land; power-off last
      if (original.power && !now.power) await ctx.driver.set(zone, 'power', true);
      for (const p of props) await ctx.driver.set(zone, p, original[p]);
      if (!original.power && now.power) await ctx.driver.set(zone, 'power', false);
      const after = await ctx.driver.queryZone(zone);
      const left = (Object.keys(original) as Array<keyof ZoneState>).filter(
        (k) => k !== 'keypad' && k !== 'pa' && after[k] !== original[k],
      );
      if (left.length) problems.push(`zone ${zone}: ${left.join(', ')} not restored`);
    } catch (e) {
      problems.push(`zone ${zone}: ${errMsg(e)}`);
    }
  }
  return problems;
}

export async function pickTestZone(ctx: Ctx): Promise<ZoneId | undefined> {
  const { opts, ui, report } = ctx;
  report.section('10. Write tests');
  if (!opts.allowWrites) {
    report.add({ id: 'writes', status: 'skip', summary: 'Skipped (--read-only)' });
    return undefined;
  }
  const off = [...ctx.zones.values()].filter((s) => !s.power).map((s) => s.zone);
  const suggestion = opts.testZone ?? off[0] ?? [...ctx.zones.keys()][0];
  if (suggestion === undefined) return undefined;
  console.log(
    '      The write tests change TREBLE by one step on one zone and then restore it.\n' +
      '      A zone that is OFF is best — nothing will be audible.',
  );
  const answer = await ui.ask(
    `Zone to use for write tests (or "skip")? Zones currently off: ${off.join(', ') || 'none'}.`,
    String(suggestion),
  );
  if (answer === 'skip') {
    report.add({ id: 'writes', status: 'skip', summary: 'Skipped by user' });
    return undefined;
  }
  const zone = Number(answer);
  if (!ctx.zones.has(zone)) {
    report.add({
      id: 'writes',
      status: 'skip',
      summary: `Zone ${answer} not found; write tests skipped`,
    });
    return undefined;
  }
  return zone;
}

export async function checkWrites(ctx: Ctx, zone: ZoneId): Promise<void> {
  const { report, driver, transport } = ctx;
  const before = await snapshot(ctx, zone);
  const t1 = before.treble >= 14 ? 13 : before.treble + 1;

  // Raw acknowledgement format for a same-value set (no change on the amp).
  const ack = await rawExchange(transport, formatSet(zone, 'treble', before.treble), {
    quietMs: 300,
  });
  report.add({
    id: 'set-format',
    status: ack.response.includes('#') ? 'pass' : 'warn',
    summary: `Set command acknowledgement captured (first byte ${ack.firstByteMs ?? '-'} ms)`,
    raw: [ack],
  });
  report.find(
    'What does the amp send back for a set command?',
    ack.response ? `"${ack.response.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"` : 'nothing',
  );

  // Read-after-write.
  const tw = performance.now();
  await driver.set(zone, 'treble', t1);
  const setMs = Math.round(performance.now() - tw);
  const readBack = await driver.queryZone(zone);
  const sticks = readBack.treble === t1;
  report.add({
    id: 'read-after-write',
    status: sticks ? 'pass' : 'fail',
    summary: `Set treble ${before.treble}→${t1} on zone ${zone} (${before.power ? 'on' : 'off'}): ack in ${setMs} ms; immediate read-back shows ${readBack.treble}`,
  });
  report.find('Set acknowledgement time', `${setMs} ms`);
  if (!before.power) {
    report.find(
      'Do settings sent to a powered-OFF zone stick?',
      sticks ? 'yes' : 'NO — mirror must power followers on before other writes',
      sticks ? 'pass' : 'warn',
    );
  } else {
    report.find(
      'Is a write visible to an immediate re-query?',
      sticks ? 'yes' : 'no',
      sticks ? 'pass' : 'warn',
    );
  }

  // Rapid alternating writes with no gap.
  let errors = 0;
  for (let i = 0; i < 10; i++) {
    try {
      await driver.set(zone, 'treble', i % 2 ? t1 : before.treble);
    } catch {
      errors++;
    }
  }
  const final = await driver.queryZone(zone);
  const lastValue = t1; // the 10th write (i = 9, odd) sets t1
  report.add({
    id: 'rapid-writes',
    status: errors === 0 && final.treble === lastValue ? 'pass' : 'warn',
    summary: `10 back-to-back writes: ${errors} errors; final value ${final.treble} (expected ${lastValue})`,
  });
  report.find(
    'Are 10 back-to-back set commands all applied?',
    errors === 0 && final.treble === lastValue
      ? 'yes'
      : `no — ${errors} errors, final ${final.treble} vs ${lastValue}`,
    errors === 0 && final.treble === lastValue ? 'pass' : 'warn',
  );
  await driver.set(zone, 'treble', before.treble);
}

export async function checkPowerCycle(ctx: Ctx, zone: ZoneId): Promise<void> {
  const { report, driver, ui } = ctx;
  const before = await snapshot(ctx, zone);
  if (before.power) {
    report.add({
      id: 'power-cycle',
      status: 'skip',
      summary: `Zone ${zone} is on; power test needs a zone that is off`,
    });
    return;
  }
  const ok = await ui.confirm(
    `Power test: turn zone ${zone} ON for ~2 s and back OFF? Audio on source ${before.source} may play at volume ${before.volume}/38.`,
    false,
  );
  if (!ok) {
    report.add({ id: 'power-cycle', status: 'skip', summary: 'Power test skipped' });
    report.find('Are settings kept across zone power off/on?', 'not tested', 'skip');
    return;
  }
  await driver.set(zone, 'power', true);
  await sleep(1000);
  const onState = await driver.queryZone(zone);
  await driver.set(zone, 'power', false);
  await sleep(500);
  const offState = await driver.queryZone(zone);
  const fields: SettableProp[] = ['volume', 'treble', 'bass', 'balance', 'source', 'mute'];
  const changedOn = fields.filter((f) => onState[f] !== before[f]);
  const changedOff = fields.filter((f) => offState[f] !== before[f]);
  report.add({
    id: 'power-cycle',
    status: onState.power && !offState.power ? 'pass' : 'warn',
    summary: `On: power=${onState.power}, changed [${changedOn.join(', ') || 'nothing'}]; off again: power=${offState.power}, changed [${changedOff.join(', ') || 'nothing'}]`,
    data: { before, onState, offState },
  });
  report.find(
    'Are settings kept across zone power off/on?',
    changedOn.length || changedOff.length
      ? `no — changed: ${[...new Set([...changedOn, ...changedOff])].join(', ')}`
      : 'yes',
    changedOn.length || changedOff.length ? 'warn' : 'pass',
  );
}

// ───────────────────────────── keypad change detection ─────────────────────────────

export async function checkKeypadChange(ctx: Ctx): Promise<void> {
  const { report, ui, driver, transport } = ctx;
  report.section('11. Keypad change detection');
  if (!ui.interactive || ctx.keypadZones.length === 0) {
    report.add({
      id: 'keypad-change',
      status: 'skip',
      summary:
        ctx.keypadZones.length === 0
          ? 'No keypad zones'
          : 'Needs someone at a keypad (interactive run)',
    });
    report.find(
      'Does the amp send anything unsolicited when a keypad is used?',
      'not tested',
      'skip',
    );
    return;
  }
  const answer = await ui.ask(
    `Which keypad zone can you reach? (or "skip")`,
    String(ctx.keypadZones[0]),
  );
  if (answer === 'skip') {
    report.add({ id: 'keypad-change', status: 'skip', summary: 'Skipped by user' });
    return;
  }
  const zone = Number(answer);
  const before = await driver.queryZone(zone);
  await ui.pause(
    `Go to the keypad for zone ${zone}. Press Enter here, then within 20 s press VOLUME UP once or twice on the keypad.`,
  );
  if (ctx.emulator)
    setTimeout(() => ctx.emulator!.pressKeypad(zone, { volume: before.volume + 2 }), 1500);
  const t0 = performance.now();
  let unsolicited = '';
  let detectedMs: number | undefined;
  let after: ZoneState | undefined;
  while (performance.now() - t0 < 20_000) {
    unsolicited += await listen(transport, 450); // nothing is outstanding: anything here was pushed by the amp
    after = await driver.queryZone(zone);
    if (
      after.volume !== before.volume ||
      after.power !== before.power ||
      after.source !== before.source
    ) {
      detectedMs = Math.round(performance.now() - t0);
      break;
    }
  }
  report.add({
    id: 'keypad-change',
    status: detectedMs !== undefined ? 'pass' : 'warn',
    summary:
      detectedMs !== undefined
        ? `Change seen by polling after ${detectedMs} ms (volume ${before.volume}→${after?.volume}). Unsolicited bytes: ${unsolicited ? JSON.stringify(unsolicited) : 'none'}`
        : 'No change seen within 20 s',
    data: { before, after, unsolicited },
  });
  report.find(
    'Does the amp send anything unsolicited when a keypad is used?',
    unsolicited ? `yes: ${JSON.stringify(unsolicited)}` : 'no — polling is required',
  );
  if (
    detectedMs !== undefined &&
    after &&
    (await ui.confirm(`Restore zone ${zone} volume to ${before.volume}?`, true))
  ) {
    await driver.set(zone, 'volume', before.volume);
  }
}

// ───────────────────────────── soak ─────────────────────────────

export async function checkSoak(ctx: Ctx): Promise<void> {
  const { report, driver, opts } = ctx;
  report.section(`12. Polling soak (${opts.soakSeconds} s, read-only)`);
  if (opts.soakSeconds <= 0) {
    report.add({ id: 'soak', status: 'skip', summary: 'Skipped (--soak 0)' });
    return;
  }
  const primary = [...ctx.zones.keys()][0]!;
  const latencies: number[] = [];
  let errors = 0;
  let overruns = 0;
  let sweeps = 0;
  const end = performance.now() + opts.soakSeconds * 1000;
  let lastSweep = 0;
  console.log(`      Polling zone ${primary} every 500 ms and sweeping all units every 2 s…`);
  while (performance.now() < end) {
    const tick = performance.now();
    try {
      await driver.queryZone(primary);
      latencies.push(performance.now() - tick);
    } catch {
      errors++;
    }
    if (tick - lastSweep >= 2000) {
      lastSweep = tick;
      sweeps++;
      for (const u of ctx.units) {
        try {
          await driver.queryUnit(u);
        } catch {
          errors++;
        }
      }
    }
    const spent = performance.now() - tick;
    if (spent > 500) overruns++;
    await sleep(Math.max(0, 500 - spent));
  }
  const s = stats(latencies);
  report.add({
    id: 'soak',
    status: errors === 0 ? 'pass' : 'warn',
    summary: `${latencies.length} primary polls + ${sweeps} sweeps: ${errors} errors, ${overruns} overruns of the 500 ms budget; poll latency avg ${s?.avg ?? '-'} ms, max ${s?.max ?? '-'} ms`,
    data: { polls: s, sweeps, errors, overruns },
  });
  report.find(
    'Is 500 ms mirror polling + 2 s UI sweep stable?',
    errors === 0 && overruns === 0 ? 'yes' : `${errors} errors, ${overruns} overruns`,
    errors === 0 && overruns === 0 ? 'pass' : 'warn',
  );
}
