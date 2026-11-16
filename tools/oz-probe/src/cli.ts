#!/usr/bin/env node
/**
 * oz-probe — hardware validation for open-zone.
 *
 * Run on the Pi with the amplifier connected:
 *   npm run probe                       # interactive, auto-detects the port
 *   npm run probe -- --port /dev/ttyUSB0
 *   npm run probe -- --read-only --yes  # unattended, no writes
 *   npm run probe -- --simulate         # dry run against the built-in emulator
 *
 * Produces oz-probe-report-<time>.md and .json in the current directory.
 */
import { parseArgs } from 'node:util';
import { MonopriceDriver, MonopriceEmulator } from '@open-zone/drivers';
import {
  checkEnvironment,
  checkFormat,
  checkGap,
  checkKeypadChange,
  checkKeypads,
  checkPowerCycle,
  checkSoak,
  checkTiming,
  checkUnits,
  checkWrites,
  choosePort,
  establishLink,
  pickTestZone,
  readAllZones,
  restoreAll,
  type Ctx,
  type ProbeOptions,
} from './checks.ts';
import { Transcript } from './recorder.ts';
import { Report } from './report.ts';
import { ICON, Prompter, bold, heading, line } from './ui.ts';

const HELP = `oz-probe — validate an RS-232 amplifier connection for open-zone

Options:
  --port <path>      Serial device (default: /dev/amp0, or the only USB serial adapter)
  --baud <n>         Baud rate to try first (default 9600; others are scanned if it fails)
  --timeout <ms>     Per-command response timeout (default 1000)
  --soak <seconds>   Length of the polling soak test (default 30, 0 to skip)
  --zone <id>        Zone to use for write tests (default: first zone that is off)
  --read-only        Never send set commands
  --yes, -y          Non-interactive: accept defaults, skip tests that need a person
  --out <dir>        Where to write the report (default: current directory)
  --simulate         Run against the built-in emulator instead of hardware
  --help, -h         Show this help
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      baud: { type: 'string', default: '9600' },
      timeout: { type: 'string', default: '1000' },
      soak: { type: 'string', default: '30' },
      zone: { type: 'string' },
      'read-only': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      out: { type: 'string', default: process.cwd() },
      simulate: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const opts: ProbeOptions = {
    port: values.port,
    baud: Number(values.baud),
    timeoutMs: Number(values.timeout),
    soakSeconds: Number(values.soak),
    allowWrites: !values['read-only'],
    testZone: values.zone ? Number(values.zone) : undefined,
    simulate: values.simulate,
  };
  const ui = new Prompter(!values.yes && process.stdin.isTTY === true);
  const report = new Report();
  const transcript = new Transcript();
  report.environment.options = { ...opts };

  console.log(bold('open-zone hardware probe'));
  console.log(
    'This checks the serial link to the amplifier and answers the open hardware\n' +
      'questions for open-zone. It only changes treble by one step (and power, only if\n' +
      'you agree), and restores everything it changes.',
  );

  let ctx: Ctx | undefined;
  let interrupted = false;
  const onSigint = async () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\nInterrupted — restoring zones…');
    if (ctx) await restoreAll(ctx).catch(() => {});
    process.exit(130);
  };
  process.on('SIGINT', () => void onSigint());

  try {
    await checkEnvironment(report);
    const emulator = opts.simulate
      ? new MonopriceEmulator({
          units: 2,
          keypadZones: [11, 21],
          latencyMs: 15,
          baudRate: 9600,
          ignoreSetsWhenOff: true,
        })
      : undefined;
    const path = opts.simulate ? 'simulator' : await choosePort(opts, ui, report);
    if (!path) return finish(report, transcript, values.out, ui);
    const link = await establishLink(opts, path, report, transcript, emulator);
    if (!link) return finish(report, transcript, values.out, ui);

    const driver = new MonopriceDriver(link.transport, { timeoutMs: opts.timeoutMs, retries: 0 });
    // The transport is already open; attach the driver's listeners without reopening.
    await driver.open();
    ctx = {
      opts,
      ui,
      report,
      transcript,
      transport: link.transport,
      driver,
      ...(emulator && { emulator }),
      units: [],
      zones: new Map(),
      originals: new Map(),
      keypadZones: [],
    };

    await checkFormat(ctx);
    await checkUnits(ctx);
    if (ctx.units.length === 0) return finish(report, transcript, values.out, ui);
    await readAllZones(ctx);
    await checkKeypads(ctx);
    await checkTiming(ctx);
    await checkGap(ctx);
    const testZone = await pickTestZone(ctx);
    if (testZone !== undefined) {
      await checkWrites(ctx, testZone);
      await checkPowerCycle(ctx, testZone);
    }
    await checkKeypadChange(ctx);
    await checkSoak(ctx);

    heading('13. Restore');
    const problems = await restoreAll(ctx);
    report.add({
      id: 'restore',
      status: problems.length ? 'fail' : 'pass',
      summary: problems.length
        ? `Could not fully restore: ${problems.join('; ')}`
        : ctx.originals.size
          ? `Restored ${ctx.originals.size} zone(s) to their original settings`
          : 'Nothing to restore',
    });
    await driver.close();
  } catch (e) {
    report.add({
      id: 'crash',
      title: 'Unexpected error',
      status: 'fail',
      summary: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
    if (ctx) await restoreAll(ctx).catch(() => {});
  }
  return finish(report, transcript, values.out, ui);
}

async function finish(
  report: Report,
  transcript: Transcript,
  out: string,
  ui: Prompter,
): Promise<number> {
  ui.close();
  heading('Summary');
  for (const f of report.findings) line(f.status, `${f.question}: ${bold(f.answer)}`);
  if (typeof report.environment.udevRule === 'string') {
    console.log(
      `\n  Suggested udev rule (/etc/udev/rules.d/99-open-zone.rules):\n  ${report.environment.udevRule}`,
    );
  }
  const { md, json } = await report.write(out, transcript);
  console.log(`\n${ICON[report.worst]} Report written to:\n  ${md}\n  ${json}`);
  console.log('\nSend the .md file (or both) back so the defaults can be tuned to your hardware.');
  return report.worst === 'fail' ? 1 : 0;
}

process.exitCode = await main();
