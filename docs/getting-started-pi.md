# Getting started on a Raspberry Pi

This runs open-zone on the Pi with the **built-in emulator**, so you can try the full UI before the amplifier is connected. Switching to the real amp later is one command.

## 1. Prepare the Pi (one time)

1. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In the imager settings, set the hostname to `open-zone`, enable SSH, and add your Wi-Fi if you're not using Ethernet.
2. SSH in (`ssh <user>@open-zone.local`), then install Node 24 and git:
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   sudo usermod -aG dialout $USER   # serial-port access, needed for the real amp
   ```
   Log out and back in so the group change applies.

## 2. Install open-zone

```sh
git clone https://github.com/NightOwl-Labs/open-zone.git
cd open-zone
git checkout feat/server-and-ui     # until the PRs are merged to main
./scripts/install.sh
```

The script installs dependencies and builds the UI. Expect a few minutes on a Pi 3. You may see an `install-scripts` warning for `@serialport/bindings-cpp`; it's harmless, because prebuilt arm64 binaries are included.

## 3. Run it with the emulator

```sh
npm run simulate
```

Open **http://open-zone.local:8080** on your phone. The server log also prints the Pi's IP address in case `.local` names don't resolve on your network. Press Ctrl+C to stop.

The emulator acts like three stacked 10761 units (18 zones). Zones 11–15, 21–25 and 31–35 report wall keypads; zones 16, 26 and 36 don't, so those can become mirror followers. Its settings are kept separately in `data/simulator/config.json`, so nothing you try now carries over to the real amp.

### Things to try

- **Settings → Home:** name your home (shown at the top of every screen) and pick compact, normal or large spacing for this device.

- **Zones:** turn zones on, change sources and volume, tap a zone name for tone, balance and renaming.
- **Settings → Sources:** name your sources, e.g. "Sonos" or "TV". Turn off inputs you don't use so they disappear from the zone source lists.
- **Settings → Zones:** name zones, and turn off zones with no speakers. Units are detected automatically, but each unit always reports all 6 zones.
- **Mirrors:** create a mirror with a keypad zone (e.g. 11) as primary and 16 and 26 following it. Change the primary and the followers change too.
- **Settings → Simulated keypad:** press "Vol +" or "Next source" on the primary. This is a change made at the wall rather than in the app, and the followers pick it up within about half a second. Try it on a follower too: a volume change becomes an offset, and anything else removes the zone from the mirror.
- **Add to Home Screen** from Safari or Chrome to get a full-screen, app-like icon.

## 4. Keep it running (optional)

To start open-zone at boot and restart it after a crash or power loss:

```sh
./scripts/install-service.sh --simulate     # emulator
journalctl -u open-zone -f                  # watch the logs
```

## 5. Switch to the real amplifier

Once the cable is connected, run the hardware probe first (see [hardware-validation.md](hardware-validation.md)). Stop the emulator or service before you do, because the probe needs the serial port to itself:

```sh
sudo systemctl stop open-zone 2>/dev/null; npm run probe
```

Then run against the amp:

```sh
npm start                                   # foreground
./scripts/install-service.sh                # or as a service (replaces the simulator service)
```

By default the real-amp config uses `/dev/amp0`. The probe prints a udev rule that creates that name for your adapter. Until you install the rule, edit `data/config.json` and set `device.transport.path` to e.g. `/dev/ttyUSB0`.

## Updating

```sh
git pull && ./scripts/install.sh && sudo systemctl restart open-zone
```
