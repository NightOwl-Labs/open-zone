# open-zone — Implementation Plan

Each phase ends with something that can be demonstrated. Hardware is needed from Phase 2 onward. Everything else runs on the simulator.

## Phase 0: Scaffold ✅

- npm workspaces monorepo (`shared`, `core`, `drivers`, `server`, `ui`), TypeScript strict mode, ESLint, Prettier, vitest.
- CI: lint, typecheck and test on every push.
- **Done when:** `npm test` passes on a fresh clone.

## Phase 1: Core and simulator (no hardware) ✅

- `shared`: zod schemas for ZoneState, ModelDescriptor, MirrorGroup, Config and API payloads.
- `drivers/simulator`: an in-memory 18-zone amp with configurable latency and a "press the keypad" hook to simulate out-of-band changes.
- `core`: CommandQueue (priorities, timeout, inter-command gap, RTT metric), ZoneStateCache with pending-write masking, EventBus, ControllerService.
- MirrorEngine with full unit tests: immediate fan-out, poll-detected primary change, the volume-offset rule, the detach rule, keypad rejection, and the no-chains rule.
- **Done when:** the test suite covers every row of the mirror-engine table in ARCHITECTURE §7.

## Phase 2: Monoprice driver and hardware bring-up — code ✅, hardware validation pending

- Pure codec (`parseStatus`, `formatSet`) tested against fixtures.
- Serial transport (`serialport`) and a TCP transport.
- `oz-probe` CLI: list ports, open a port, `?10`/`?20`/`?30`, set and read back, measure RTT, capture raw bytes as new fixtures.
- **Hardware checks:** cable chipset and pinout (straight-through vs null-modem), echo and prompt format, the LS keypad field on zones with and without keypads, command spacing that never drops a command, actual timings for single-zone and unit queries.
- Built ahead of plan: the PollScheduler tiers and reconnect/recovery logic (planned for Phase 3) live in the core and are tested against the emulator.
- **Done when:** `oz-probe` controls all installed zones, and measured timings are recorded in `docs/hardware-notes.md`. If needed, the default poll intervals are revised.

## Phase 3: Server ✅ (hardware recovery test pending)

- Fastify app: REST routes, WebSocket events, OpenAPI docs, static hosting, and a no-op auth hook.
- JSON ConfigStore (atomic writes, schema versioning).
- PollScheduler tiers (mirror-primary, mirror-follower audit, interactive, idle) driven by the number of mirrors and connected clients.
- Startup and recovery state machine (ARCHITECTURE §8).
- **Done when:** curl and `wscat` can drive the simulator and the real amp. Unplugging and replugging USB recovers automatically.

## Phase 4: UI (PWA) — first version ✅

- Zones list, zone detail, mirrors editor (keypad zones disabled), settings (port picker, discovery, intervals, zone and source names, RTT readout).
- Optimistic updates with rollback on `command.failed`. Throttled volume sliders.
- PWA manifest so it can be added to the phone home screen. A service worker needs HTTPS (or localhost) and is deferred until auth/TLS is added.
- **Done when:** every zone can be controlled from a phone over the LAN, with changes showing within about 1 poll interval.

## Phase 5: Mirroring on hardware and tuning

- Run mirror groups on the real amp. Change the primary from its keypad and confirm followers follow within the poll interval.
- Tune the 500 ms primary poll and the follower-audit interval using the RTT metric.
- Soak test: 24 h with mirrors enabled, checking for missed commands, memory growth and CPU on the Pi 3.
- **Done when:** a keypad change on the primary reaches the followers in under 1 s with no dropped commands over 24 h.

## Phase 6: Deployment

- `install.sh`: Node check, user and group (`dialout`), data directory, systemd unit, and a udev rule generated from the attached adapter.
- Optional Dockerfile (pass `--device /dev/amp0` to the container).
- Power-loss test: pull the plug with mirrors enabled. Confirm the service returns and the groups re-sync. Then repeat with no mirrors and confirm the bus stays idle until a client connects.
- **Done when:** a clean Pi OS arm64 install goes from zero to running with one command.

## Backlog (future releases)

Auth · MQTT / Home Assistant adapter · adaptive polling · additional amp drivers (Russound, Nuvo, Dayton, Xantech) · Capacitor iOS/Android · scenes, presets and schedules · per-zone volume limits · multiple devices on separate ports.
