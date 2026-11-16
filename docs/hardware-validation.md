# Hardware validation (oz-probe)

`oz-probe` checks the RS-232 link to the amplifier and answers the hardware questions that open-zone's defaults depend on. It writes a report to send back so those defaults can be tuned.

## What it answers

| #   | Question                                                            | Why it matters                                                                      |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Which USB-serial chipset is the adapter?                            | FTDI and CP210x are reliable; the probe prints a udev rule for a stable `/dev/amp0` |
| 2   | Which baud rate does the amp answer at? It scans 9600–230400        | The config default                                                                  |
| 3   | Does the amp echo commands and end each response with a `#` prompt? | The driver uses these to tell when a response is complete                           |
| 4   | Does the batch query `?10` return all 6 zones?                      | If not, the driver falls back to per-zone queries                                   |
| 5   | Which stacked units answer, and what does a missing unit send back? | Unit discovery                                                                      |
| 6   | Does the keypad (LS) field match the keypads physically installed?  | Mirror setup refuses to use zones with a keypad as children                         |
| 7   | How long do zone, unit and full-sweep queries take?                 | Poll intervals and how much of the serial line they use                             |
| 8   | What is the smallest safe gap between commands?                     | The `queue.interCommandGapMs` default                                               |
| 9   | What does a set command send back, and how fast?                    | How the driver detects that a write was accepted                                    |
| 10  | Do settings sent to a powered-off zone stick?                       | Mirror write ordering                                                               |
| 11  | Are settings kept when a zone is powered off and on? _(optional)_   | Mirror power handling                                                               |
| 12  | Does the amp send anything on its own when a keypad is used?        | If it did, polling could be reduced                                                 |
| 13  | Is 500 ms mirror polling plus a 2 s UI sweep stable?                | Validates the default poll intervals                                                |

## Safety

- Read-only checks run first.
- The write tests change **treble by one step** on one zone you choose. A zone that is off is suggested, so nothing is audible. Every change is reverted.
- The power test is **opt-in**. It turns a zone on for about 2 seconds, and the prompt shows the volume it will play at first.
- Ctrl+C restores any zones the probe has changed before it exits.
- Use `--read-only` to skip every write.

## Set up the Pi 3

1. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In the imager, enable SSH and set a hostname such as `open-zone`.
2. Install Node 24 and git:
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   node -v   # v24.x
   ```
3. Give your user access to serial ports, then log out and back in:
   ```sh
   sudo usermod -aG dialout $USER
   ```
4. Get the code. Only runtime dependencies are needed; there is no build step:
   ```sh
   git clone https://github.com/NightOwl-Labs/open-zone.git
   cd open-zone
   npm ci --omit=dev
   ```
   You may see an `install-scripts` warning for `@serialport/bindings-cpp`. It is harmless: prebuilt arm64 binaries ship with the package, so nothing needs compiling.

## Run the probe

1. Plug the USB-serial adapter into the Pi and the cable into the RS-232 port of the **master** amplifier (unit 1). Power the amp on.
2. Check that the adapter was detected:
   ```sh
   ls /dev/ttyUSB* /dev/ttyACM*
   ```
3. Run the probe. The keypad test needs you at a wall keypad, so have a phone or second person ready, or skip that step when prompted.
   ```sh
   npm run probe
   ```
   Useful options:
   ```sh
   npm run probe -- --port /dev/ttyUSB0      # choose the port
   npm run probe -- --read-only --yes        # unattended, no writes
   npm run probe -- --soak 120               # longer polling soak test
   npm run probe -- --help
   ```
4. Send back the `oz-probe-report-<time>.md` file from the current directory. The `.json` file has the full byte-level transcript if more detail is needed.

## If it can't talk to the amp

| Symptom                            | Try                                                                                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot open … EACCES`             | You're not in `dialout` yet. Log out and back in after step 3.                                                                                                                                                 |
| `Cannot open … EBUSY`              | Another program has the port open. Check `sudo lsof /dev/ttyUSB0`; if ModemManager is installed, run `sudo systemctl disable --now ModemManager`.                                                              |
| No response at any baud rate       | Is the amp on, and is the cable in the master unit's RS-232 port? TX and RX may need crossing: if you're using a straight-through cable, add a null-modem adapter, and if you're already using one, remove it. |
| Bytes received but no valid status | Wrong baud rate or a noisy cable. The raw capture in the report shows exactly what came back.                                                                                                                  |

## Dry run without hardware

```sh
npm run probe -- --simulate
```

This runs every check against the built-in emulator: two stacked units, with keypads on zones 11 and 21.
