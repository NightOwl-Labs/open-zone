# open-zone

Controller for RS-232 multi-zone amplifiers. It runs on any Linux host; the reference target is a Raspberry Pi 3. It provides a REST/WebSocket API and a phone-first web UI. The first driver is for the Monoprice 10761 6-zone amp, with up to 3 units stacked (18 zones).

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## Status

Phases 0–2 are complete: the core controller, the mirror engine, the Monoprice driver, the emulator, and the `oz-probe` hardware validation tool. The REST/WebSocket server and the phone UI come next.

## Development

Requires Node ≥ 22.18 (Node 24 LTS recommended). TypeScript runs directly on Node, so there is no build step.

```sh
npm install
npm run check                    # lint, typecheck, format check, tests
npm run probe -- --simulate      # hardware probe against the built-in emulator
```

- [Hardware validation on the Pi](docs/hardware-validation.md)
