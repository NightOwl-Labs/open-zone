# open-zone

Phone-first control for RS-232 multi-zone amplifiers, running on a Raspberry Pi (or any Linux host). The first supported amp is the **Monoprice 10761** 6-zone amplifier, up to 3 stacked units (18 zones) on one serial port.

- **Zones:** power, source, volume, mute, tone, balance and do-not-disturb for every zone
- **Mirrors:** followers copy a primary zone, with a per-follower volume offset; wall-keypad changes on the primary are followed within about half a second
- **Scenes:** any number of them, each with one source, a preset volume per zone and optional "turn others off"; plus **All off**
- **Naming:** zones, sources and the home; hide unused zones and sources
- **Designs:** four (Classic, Studio, Console, Tiles), with compact, normal and large spacing
- **Recovery:** comes back automatically after a power loss
- **Simulator:** a built-in amp emulator, so everything can be tried without hardware

Local network only for now: no login yet.

---

## Bootstrap from a fresh Raspberry Pi

These steps take a blank SD card to a running controller. Tested on a Raspberry Pi 3 Model B with Raspberry Pi OS Lite (64-bit).

### What you need

- Raspberry Pi 3 or newer, a microSD card (8 GB+) and a power supply
- **USB-to-RS232 adapter.** FTDI-based ones are the most reliable; CP210x also works.
- Serial cable to the amp's RS-232 port on **unit 1** (the main unit)

### 1. Flash the SD card

In [Raspberry Pi Imager](https://www.raspberrypi.com/software/), choose **Raspberry Pi OS Lite (64-bit)**. Before writing, open the settings (⚙ / "Edit settings") and:

- set the **hostname**, e.g. `open-zone` (used in the URLs below)
- create a **username and password**
- add your **Wi-Fi**, unless you're using Ethernet
- under Services, enable **SSH**

Boot the Pi and wait a minute.

### 2. Log in and install the prerequisites

From your computer:

```sh
ssh <user>@open-zone.local
```

Then on the Pi:

```sh
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo usermod -aG dialout $USER          # serial-port access
exit                                    # log out so the group change applies
```

Log back in with `ssh <user>@open-zone.local`.

### 3. Get open-zone and install it

```sh
git clone https://github.com/NightOwl-Labs/open-zone.git
cd open-zone
./scripts/install.sh                    # installs dependencies and builds the UI (a few minutes on a Pi 3)
```

### 4. Try it with the simulator (no amp needed)

```sh
npm run simulate
```

Open **http://open-zone.local:8080** on your phone. If `.local` names don't resolve on your network, the log also prints the Pi's IP address. The simulator acts like three stacked units and keeps its settings separate from the real amp's. Press **Ctrl+C** to stop it.

### 5. Connect the amplifier and validate the link

Plug in the USB adapter, connect the cable to the amp, power the amp on, then run:

```sh
ls /dev/ttyUSB*                         # the adapter, e.g. /dev/ttyUSB0
npm run probe                           # about 3 minutes; answer the prompts
```

The probe checks the link, timings and keypad detection, makes only harmless changes (one treble step, then restored), and writes `oz-probe-report-<time>.md`. See [docs/hardware-validation.md](docs/hardware-validation.md) for what each check means.

### 6. Give the adapter a stable name

The probe prints a udev rule at the end. Install it so the adapter is always `/dev/amp0`, the app's default:

```sh
echo '<rule printed by the probe>' | sudo tee /etc/udev/rules.d/99-open-zone.rules
sudo udevadm control --reload && sudo udevadm trigger && sudo udevadm settle
ls -l /dev/amp0                         # → ttyUSB0
```

<details><summary>Skip the rule and point at the port directly</summary>

```sh
mkdir -p data
echo '{"device":{"transport":{"type":"serial","path":"/dev/ttyUSB0","baudRate":9600}}}' > data/config.json
```

`ttyUSB0` can change name after a reboot if other USB serial devices are attached, which is why the rule is preferred.
</details>

### 7. Run it against the amp

```sh
npm start
```

The log should show `connected: units 1` (or `1, 2, 3` for a stack). Open **http://open-zone.local:8080**. Your real zones appear, and changes made at the wall keypads show up within a couple of seconds. Press **Ctrl+C** when you're done looking.

### 8. Install as a service

This starts open-zone at boot and restarts it after crashes or power loss:

```sh
./scripts/install-service.sh
systemctl status open-zone              # "active (running)"
journalctl -u open-zone -f              # live log (Ctrl+C stops watching)
```

### 9. Set it up in the app

- **Settings → Home:** name your home, and choose spacing and a design for this device. Each design has its own address, e.g. `/console` for a wall tablet.
- **Settings → Sources and Zones:** name them, and switch off any that aren't connected. The amp can't detect which inputs or zones are in use.
- **Mirrors:** pick a primary zone and followers. Followers must be zones **without** a wall keypad.
- **Scenes:** create one-tap presets. They appear at the top of the Zones screen next to **All off**.
- On your phone, use **Share → Add to Home Screen** for an app-like icon.

---

## Day-to-day

| To…                                 | Run (in the `open-zone` folder)                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| Update to the latest version        | `git pull && ./scripts/install.sh && sudo systemctl restart open-zone`             |
| Stop / start the service            | `sudo systemctl stop open-zone` / `sudo systemctl start open-zone`                 |
| Re-run the hardware probe           | `sudo systemctl stop open-zone && npm run probe && sudo systemctl start open-zone` |
| Switch the service to the simulator | `./scripts/install-service.sh --simulate`                                          |
| Remove the service                  | `./scripts/install-service.sh --uninstall`                                         |

Configuration lives in `data/config.json` (`data/simulator/config.json` for the simulator) and is edited from the app. Port, bind address and data directory can be changed with `OZ_PORT`, `OZ_HOST` and `OZ_DATA_DIR`.

## Troubleshooting

| Symptom                                   | Fix                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot open … EACCES`                    | Not in the `dialout` group yet. Run `sudo usermod -aG dialout $USER`, then log out and back in.                                                                |
| `Cannot open … EBUSY`                     | Something else has the port, often the service while you run the probe. Stop it with `sudo systemctl stop open-zone`.                                          |
| `/dev/amp0` missing after adding the rule | Run `sudo udevadm settle`, or unplug and replug the adapter. Check the values with `udevadm info -a -n /dev/ttyUSB0 \| grep -E 'idVendor\|idProduct\|serial'`. |
| Probe: no response at any baud rate       | Amp powered? Cable in unit 1's RS-232 port? Try adding or removing a null-modem adapter (TX/RX crossing).                                                      |
| Page won't load at `open-zone.local`      | Use the IP address printed in the log (`journalctl -u open-zone`), or check the phone is on the same network.                                                  |
| "Zone is off" when changing a setting     | The 10761 ignores settings sent to an off zone. Turn it on first.                                                                                              |

## Documentation

- [Getting started on a Pi (simulator walkthrough)](docs/getting-started-pi.md)
- [Hardware validation with `oz-probe`](docs/hardware-validation.md)
- [Hardware notes for the Monoprice 10761](docs/hardware-notes.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## Development

Requires Node ≥ 22.18 (Node 24 LTS recommended). The server runs TypeScript directly on Node; only the UI has a build step.

```sh
npm install
npm run check                    # lint, typecheck, format check, tests
npm run build                    # build the UI
npm run simulate                 # server + UI on :8080 against the emulator
npm run dev:ui                   # hot-reloading UI on :5173 (with `npm run simulate` running)
npm run probe -- --simulate      # hardware probe against the emulator
```
