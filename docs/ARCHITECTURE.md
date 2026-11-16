# open-zone — Architecture

Controller for RS-232 multi-zone amplifiers. It runs on any Linux host, with a Raspberry Pi 3 as the reference target. The first driver is for the **Monoprice 10761** 6-zone amp, with up to 3 units stacked (18 zones).

Status: draft, 2026-11-15.

---

## 1. Requirements

| #   | Requirement                                                                                                                                                                                                                                                                                                                          | Source |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| R1  | Up to 18 zones (3 stacked 10761 units) over **one** serial port. Expansion units (2 and 3) are chained to unit 1, the main unit. Sources are shared.                                                                                                                                                                                 | user   |
| R2  | Any UI can poll the state of every zone, change a zone's settings, and have the changes pushed to the hardware.                                                                                                                                                                                                                      | user   |
| R3  | Mirroring: one primary zone drives one or more follower zones. **All** settings are mirrored.                                                                                                                                                                                                                                        | user   |
| R4  | A follower zone must have **no keypad**. This is checked when the mirror is set up. As a backup, an out-of-band change to a follower is handled this way: a volume change becomes an offset, and any other change breaks the zone out of the mirror.                                                                                 | user   |
| R5  | A change the API makes to a primary is sent to its followers right away. The cache is updated so the next poll finds nothing to do.                                                                                                                                                                                                  | user   |
| R6  | Mirror poll interval is configurable, starting at 500 ms. Adaptive timing may come later.                                                                                                                                                                                                                                            | user   |
| R7  | After a power loss the service recovers on its own. Background polling happens **only if a mirror is enabled**. Otherwise state is synced only while a user is interacting.                                                                                                                                                          | user   |
| R8  | Phone-first browser UI that can later be packaged as an iOS or Android app.                                                                                                                                                                                                                                                          | user   |
| R9  | Config, including zone and source naming and mirror groups, is done from the UI. Storage stays lightweight.                                                                                                                                                                                                                          | user   |
| R9a | The amp cannot report which source inputs are connected, so sources can be disabled. Disabled sources are hidden from zone pickers and rejected by the API, though keypads and mirrors may still select them.                                                                                                                        | user   |
| R9b | A zone following an active mirror shows no controls of its own, only what it follows. Each follower has a volume offset that can be set in the mirror editor (±38) or learned from a direct volume change.                                                                                                                           | user   |
| R9c | Units are auto-detected (a unit is present if its first zone answers). Zones are not: every unit reports 6 zones whether or not speakers are wired. Zones can therefore be disabled, which hides them, rejects commands to them and keeps them out of mirrors. A zone in a mirror must be removed from it before it can be disabled. | user   |
| R10 | Other multi-zone amp models can be added later. Integrations (MQTT, Home Assistant) and auth can be added later **without changing core decisions**.                                                                                                                                                                                 | user   |
| R11 | Local network only, no auth in v1. No user roles, ever.                                                                                                                                                                                                                                                                              | user   |

---

## 2. Tech stack decision

**Decision: TypeScript on Node.js, from the backend through the UI.**

|                                   | TypeScript / Node                                                          | Python / asyncio                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Your fluency                      | High                                                                       | Would need to learn                                                                                                 |
| Serial I/O                        | `serialport` is mature, with prebuilt arm64 binaries                       | `pyserial-asyncio` is mature                                                                                        |
| Prior art for this amp            | None worth reusing                                                         | `pymonoprice` (the Home Assistant integration). It is a useful protocol reference, but a small, synchronous library |
| API framework                     | Fastify + `@fastify/websocket` + zod → OpenAPI                             | FastAPI + Pydantic → OpenAPI built in                                                                               |
| Sharing types with the UI         | **The same zod schemas** in server, UI and future mobile app               | Types must be generated from OpenAPI, so there are two languages                                                    |
| Mobile path                       | React PWA → Capacitor wraps the same code                                  | Same, but the UI is JS anyway, so you work in two languages                                                         |
| Pi 3 footprint                    | About 60–80 MB RSS                                                         | About 40–60 MB RSS                                                                                                  |
| Latency                           | Both are far faster than the serial bus, which is the real bottleneck (§5) | Same                                                                                                                |
| Future Home Assistant integration | Through MQTT discovery. Works from either language                         | A native HA integration would be easier in Python                                                                   |

Python's two real advantages are `pymonoprice` as a reference and a native Home Assistant integration. Neither outweighs having one language you already know from the hardware driver to the phone app. The bottleneck is a 9600-baud UART, not the runtime. We will still use `pymonoprice` as a protocol reference.

**Stack**

- **Runtime:** Node.js 24 LTS. **Use 64-bit Raspberry Pi OS (arm64)** on the Pi 3, because current Node builds target arm64.
- **No build step:** Node runs the TypeScript sources directly (type stripping, Node ≥ 22.18). The code uses only erasable syntax: no enums, no parameter properties. `tsc` is used only to typecheck. Deploying is `git pull && npm ci --omit=dev`.
- **Server:** Fastify, `@fastify/websocket`, `@fastify/static`, `@fastify/swagger`.
- **Validation and contract:** zod. One schema package is used by the server, the UI and tests.
- **Serial:** `serialport`.
- **UI:** React + Vite, shipped as a PWA that can be installed to the phone home screen. Capacitor later for the app stores.
- **Tests:** vitest. Hardware-free, using the simulator driver.
- **Packaging:** npm workspaces monorepo, a systemd unit, and an optional Dockerfile.

---

## 3. Layering

```
 ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐
 │ Browser/PWA  │  │ Future: app  │  │ Future: MQTT / HA    │
 └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘
        │ REST + WebSocket│                     │ subscribes to event bus
 ┌──────▼─────────────────▼──────┐   ┌──────────▼───────────┐
 │ API adapter (Fastify)         │   │ Integration adapters │   ← "adapters" layer
 │  auth hook (no-op in v1)      │   │  (none in v1)        │
 └──────────────┬────────────────┘   └──────────┬───────────┘
                │ ControllerService (in-process API)
 ┌──────────────▼───────────────────────────────▼───────────┐
 │ Core: ZoneStateCache · PollScheduler · MirrorEngine ·     │
 │       EventBus · ConfigStore (port)                       │
 └──────────────┬───────────────────────────────────────────┘
                │ AmpDriver interface
 ┌──────────────▼───────────────┐
 │ Drivers: monoprice-10761,    │
 │          simulator           │
 └──────────────┬───────────────┘
                │ Transport interface
 ┌──────────────▼───────────────┐
 │ serial (USB-RS232) · tcp     │
 └──────────────────────────────┘
```

**Rules that keep the core stable (R10):**

1. The core does no I/O directly. It talks to an `AmpDriver` and a `ConfigStore` interface.
2. The REST/WS API is only one adapter on top of `ControllerService`. MQTT or Home Assistant will be another adapter calling the same service and subscribing to the same `EventBus`. Adding one changes nothing in the core.
3. Auth is a Fastify `onRequest` hook that is registered as a no-op in v1. All routes live under `/api/v1`.

---

## 4. Core abstractions

### 4.1 Model descriptor

Each driver publishes its capabilities, and the UI builds its controls from them. A new amp model therefore needs no UI changes.

```ts
interface ModelDescriptor {
  id: 'monoprice-10761';
  maxUnits: 3;
  zonesPerUnit: 6;
  sources: 6;
  properties: {
    power: { type: 'bool' };
    mute: { type: 'bool' };
    dnd: { type: 'bool' };
    volume: { type: 'int'; min: 0; max: 38 };
    treble: { type: 'int'; min: 0; max: 14; center: 7 };
    bass: { type: 'int'; min: 0; max: 14; center: 7 };
    balance: { type: 'int'; min: 0; max: 20; center: 10 };
    source: { type: 'enum'; min: 1; max: 6 };
  };
  readOnly: { pa: 'bool'; keypad: 'bool' }; // reported, not settable
}
```

### 4.2 Driver and transport

```ts
interface Transport {
  // serial, tcp, loopback
  open(): Promise<void>;
  close(): Promise<void>;
  write(bytes: string): Promise<void>;
  onData(cb: (chunk: string) => void): void;
}

interface AmpDriver {
  readonly model: ModelDescriptor;
  discover(): Promise<UnitId[]>; // which stacked units answer
  queryZone(zone: ZoneId): Promise<ZoneState>;
  queryUnit(unit: UnitId): Promise<ZoneState[]>; // batch query, e.g. ?10
  set(zone: ZoneId, prop: SettableProp, value: number | boolean): Promise<void>;
}
```

**CommandQueue** lives in the core and wraps every driver call. It is the only path to the wire, and drivers assume their calls are serialized.

- One command is in flight at a time, with a per-command timeout and retry.
- There is a configurable inter-command gap, because the amp drops commands sent back to back.
- **Two priorities: user/mirror writes go ahead of polls**, so user-facing latency is not stuck behind a poll sweep.
- It records a rolling round-trip time (RTT) metric, which shows whether the poll interval is too aggressive.

### 4.3 Monoprice 10761 protocol (summary; to verify on hardware)

- 9600 8N1 by default. Commands end with CR, and the amp echoes them.
- Zone IDs: unit _u_, zone _z_ → `u z`, so 11–16, 21–26 and 31–36. Unit query: `?10`, `?20`, `?30`.
- Query `?11` → `#>11PAPRMUDTVOTRBSBLCHLS`: two digits each for PA, power, mute, DND, volume, treble, bass, balance, source, and keypad (LS).
- Set: `<11VO20`, `<11CH03`, `<11PR01`, and so on.
- The **LS (keypad connected) field is how we check R4**. A zone may become a follower only if `keypad === false`.

The codec is pure functions (`parseStatus`, `formatSet`) and is unit-tested against captured byte fixtures.

---

## 5. Serial bus budget (why polling is structured this way)

At 9600 baud the bus carries about 1 byte/ms.

| Operation                       | Bytes (approx.) | Bus time                |
| ------------------------------- | --------------- | ----------------------- |
| Single-zone query `?11` + reply | ~30             | ~30 ms + amp turnaround |
| Unit query `?10` (6 zones)      | ~165            | ~170 ms + turnaround    |
| Full sweep of 3 units           | ~500            | **~500 ms+**            |
| One set command + echo          | ~15             | ~15 ms + gap            |

**A full 18-zone sweep at 500 ms would use the whole bus**, leaving no room for user commands. So polling is split into tiers:

| Tier                      | What                                 | When                                 | Default          |
| ------------------------- | ------------------------------------ | ------------------------------------ | ---------------- |
| **Mirror-primary poll**   | `?xx` for each _primary_ zone only   | Only while ≥1 mirror is enabled      | 500 ms           |
| **Mirror-follower audit** | `?xx` for followers (R4 backup rule) | Only while ≥1 mirror is enabled      | 5 s, round-robin |
| **Interactive sweep**     | `?u0` for each installed unit        | Only while ≥1 UI client is connected | 2 s              |
| **Idle**                  | nothing                              | No mirrors, no clients               | —                |

With one primary, the mirror poll uses about 10–15% of the bus. All intervals are set in config, and the RTT metric shows whether they fit. Later options: raising the amp's baud rate if the hardware supports it, and adaptive timing (R6).

---

## 6. State cache and write path

`ZoneStateCache` holds the last known state of every zone, a `lastSyncedAt` time, and a set of **pending writes** per zone.

**Write path (API → hardware):**

1. Validate the request against the model descriptor.
2. Queue the writes. An API write sends every property in the request, because the cache may be stale when nothing is polling. A mirror fan-out sends **only the properties that differ** from the follower's cached state.
3. While a write is pending, poll results for _that property of that zone_ are ignored, so a stale poll cannot undo a write that is still in flight.
4. When the amp acknowledges the write, update the cache and emit `zone.changed`.
5. If the zone is a mirror primary, the MirrorEngine sends the change to its followers straight away (R5) through the same path and updates their cache. The next poll then sees no difference.

The UI applies changes optimistically and reconciles with `zone.changed` events. A write that fails produces `command.failed`, and the UI rolls back.

---

## 7. Mirror engine

**Group model** (persisted):

```ts
interface MirrorGroup {
  id: string;
  name?: string;
  enabled: boolean;
  primary: ZoneId;
  followers: { zone: ZoneId; volumeOffset: number }[]; // offset starts at 0
}
```

**Constraints, enforced when a group is created or edited:**

- A follower must report `keypad === false`. If it doesn't, the API returns 409 with a reason.
- A zone can belong to only one group, as either primary or follower. No chains.
- The primary may have a keypad. That is the expected case.

**Expected follower state** = primary state, with `volume = clamp(primary.volume + offset, 0, 38)`.

**Sources of change, and how each is handled:**

| Event                                                                         | Action                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| API changes the primary                                                       | Write the primary, then send the changed properties to every follower right away          |
| Primary poll finds a difference from the cache (keypad or front-panel change) | Update the cache, then send only the changed properties to every follower                 |
| Follower audit or API finds the follower's **volume** ≠ expected              | `offset = follower.volume − primary.volume`, then persist it. Emit `mirror.offsetChanged` |
| Follower audit or API finds **any other** property ≠ expected                 | Remove the follower from the group, then persist. Emit `mirror.followerDetached`          |
| A follower reports `keypad === true` during an audit                          | Detach it with reason `keypad-detected`                                                   |

**Enabling a group:** run a full sync, which reads the primary and writes the expected state to each follower. Then start the poll tier.

---

## 8. Startup and recovery (R7)

1. systemd starts the service (`Restart=always`, `After=dev-amp0.device`).
2. Load config. If the serial port is missing, retry with backoff and set `connection.status = 'disconnected'`.
3. If **any mirror group is enabled**: discover units, sweep all zones once, sync each enabled group from its primary, and start the mirror poll tiers.
4. Otherwise do nothing until a UI client connects. Then do the interactive sweep for as long as clients remain connected.
5. If the serial port drops or the amp stops responding (for example the amp was power-cycled), mark the state stale, reconnect, re-sweep, and re-sync the mirror groups.

The cache is **not** persisted, because the amp is the source of truth. Only config is written, and only when it changes, to keep wear on the SD card low.

**Stable device path:** add a udev rule that maps the adapter's USB vendor:product and serial number to `/dev/amp0`. A setup script prints a rule tailored to whichever adapter is plugged in.

---

## 9. API (v1)

All JSON. Schemas come from the shared zod package and are published as OpenAPI at `/api/v1/docs`.

| Method         | Path                       | Purpose                                                                                                  |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET            | `/api/v1/system`           | Model descriptor, installed units, connection status, queue RTT                                          |
| POST           | `/api/v1/system/discover`  | Re-detect stacked units                                                                                  |
| GET            | `/api/v1/zones`            | All zones: state, name, mirror role                                                                      |
| GET            | `/api/v1/zones/:id`        | One zone                                                                                                 |
| PATCH          | `/api/v1/zones/:id`        | Partial update `{ volume?, source?, power?, … }`                                                         |
| PATCH          | `/api/v1/zones/:id/config` | `{ name?, enabled? }`: rename, or disable an unused zone                                                 |
| GET            | `/api/v1/sources`          | Shared sources (1–6) with names and enabled flags                                                        |
| PATCH          | `/api/v1/sources/:id`      | `{ name?, enabled? }`: rename, or hide an unused source from pickers (the API then rejects selecting it) |
| GET / POST     | `/api/v1/mirrors`          | List or create mirror groups                                                                             |
| PATCH / DELETE | `/api/v1/mirrors/:id`      | Edit, enable/disable, or delete a group                                                                  |
| GET / PATCH    | `/api/v1/config`           | Serial port, baud, poll intervals                                                                        |
| GET            | `/api/v1/serial-ports`     | List candidate ports for the settings UI                                                                 |
| WS             | `/api/v1/events`           | Sends a snapshot on connect, then events                                                                 |

**WebSocket events:** `snapshot`, `zone.changed` (diff only), `zone.updated`, `source.updated`, `mirror.updated`, `mirror.offsetChanged`, `mirror.followerDetached`, `connection.changed`, `command.failed`.
Commands go through REST and the WebSocket only pushes. This keeps the API simple to call from curl, scripts and future integrations.

---

## 10. Config store

A single JSON file, by default `/var/lib/open-zone/config.json` (path can be overridden with `OZ_DATA_DIR`).

- It is validated with zod when loaded, and carries a `schemaVersion` so it can be migrated later.
- Writes are atomic: write to a temp file, fsync, then rename.
- It holds the serial settings, poll intervals, zone names, source names and mirror groups.

SQLite would be over-engineered for a few KB of config. The `ConfigStore` interface means it can be swapped in later if history or scenes need it.

---

## 11. UI

- React + Vite PWA, served by the same Fastify process at `/`. Reachable at `http://<pi-hostname>.local` through Avahi/mDNS, which Raspberry Pi OS includes.
- Screens:
  1. **Zones:** a list of cards showing name, power, source, a volume slider, and a mirror badge.
  2. **Zone detail:** all controls (tone, balance, mute, DND).
  3. **Mirrors:** pick the primary, then the followers. Zones that have keypads are shown but disabled, with the reason.
  4. **Settings:** serial port, discovery, poll intervals, zone and source names, and live bus RTT.
- Volume sliders send updates throttled to about 1 every 150 ms, sending the final value on release, so the bus doesn't flood.
- Future: wrap with Capacitor. Native apps will need an HTTP exception for the LAN address (iOS ATS) and a way to discover the server (mDNS or manual entry).

---

## 12. Repository layout

```
packages/
  shared/    zod schemas, types, ModelDescriptor types  (no deps on node)
  core/      cache, scheduler, mirror engine, event bus, ControllerService
  drivers/   transports (serial, tcp, loopback), monoprice-10761, simulator
  server/    Fastify app, config store, entrypoint, systemd/udev assets
  ui/        React + Vite PWA
tools/
  oz-probe   Hardware validation CLI: answers the open hardware questions and writes a report (see docs/hardware-validation.md)
docs/
```

---

## 13. Future-proofing checklist (R10)

| Future feature                  | Where it goes                                                                      | Core change?                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth (API key or login)         | Fastify `onRequest` hook, plus a token in the WebSocket handshake                  | No                                                                                                                                                    |
| MQTT / Home Assistant           | New adapter package subscribing to `EventBus` and calling `ControllerService`      | No                                                                                                                                                    |
| Another amp model               | New driver + `ModelDescriptor`                                                     | No                                                                                                                                                    |
| Adaptive polling                | `PollScheduler` strategy                                                           | No (internal to scheduler)                                                                                                                            |
| Scenes / schedules              | New service on top of `ControllerService`; the config schema version is bumped     | No                                                                                                                                                    |
| iOS / Android app               | Capacitor wrapping `packages/ui`                                                   | No                                                                                                                                                    |
| Multiple amps on separate ports | A `Device` registry: several driver instances, with zone IDs namespaced per device | Small change. The v1 API already nests zones under a single implicit device, so `/devices/:id/zones` can be added without breaking the existing paths |
