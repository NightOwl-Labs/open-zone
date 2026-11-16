# open-zone

Controller for RS-232 multi-zone amplifiers. It runs on any Linux host; the reference target is a Raspberry Pi 3. It provides a REST/WebSocket API and a phone-first web UI. The first driver is for the Monoprice 10761 6-zone amp, with up to 3 units stacked (18 zones).

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## Status

Built so far: the core controller, the mirror engine, the Monoprice driver, the emulator, the `oz-probe` hardware validation tool, the REST/WebSocket server, and the phone-first web UI. Real-hardware validation is in progress.

**Try it on a Pi with the emulator:** [docs/getting-started-pi.md](docs/getting-started-pi.md)

## Development

Requires Node ≥ 22.18 (Node 24 LTS recommended). TypeScript runs directly on Node, so there is no build step.

```sh
npm install
npm run check                    # lint, typecheck, format check, tests
npm run build                    # build the UI
npm run simulate                 # server + UI on :8080 against the emulator
npm run dev:ui                   # hot-reloading UI on :5173 (with `npm run simulate` running)
npm run probe -- --simulate      # hardware probe against the built-in emulator
```

- [Hardware validation on the Pi](docs/hardware-validation.md)
