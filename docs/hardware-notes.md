# Hardware notes: Monoprice 10761

Findings from `oz-probe` against a real 10761 (one unit, 6 zones) on a Raspberry Pi 3 Model B with Raspberry Pi OS 64-bit and Node 24. Validated 2026-11-16.

## Link

|                   | Finding                                                    |
| ----------------- | ---------------------------------------------------------- |
| Adapter           | FTDI FT232R USB-serial (0403:6001); works out of the box   |
| Serial settings   | 9600 baud, 8N1, no flow control                            |
| Response chunking | Data arrives in ~16 ms chunks (FTDI default latency timer) |

## Protocol (as observed)

| Exchange             | Bytes on the wire                                          |
| -------------------- | ---------------------------------------------------------- |
| Zone query           | `?11\r` → `?11\r\n#>1100000000151014100500\r\r\n#`         |
| Unit query           | `?10\r` → echo, then 6 × `\r\n#>…\r` records, then `\r\n#` |
| Set command          | `<11TR10\r` → `<11TR10\r\n#`                               |
| Missing zone or unit | `?21\r` → `?21\r\n#` (echo and prompt only, no status)     |

- The echo and the `#` prompt can arrive in one chunk and the status record ~16 ms later. The driver therefore treats "echo + `#`, then 80 ms of silence" as _not present_, never just "echo + `#`".
- The amp never sends anything unsolicited. Wall-keypad changes are only visible by polling. In testing, a keypad volume change showed up in under 0.5 s with 500 ms polling.
- The keypad (LS) field matched the physically installed keypads exactly.

## Timing

| Operation            | Average | p95    |
| -------------------- | ------- | ------ |
| Single-zone query    | 49 ms   | 49 ms  |
| Unit query (6 zones) | 182 ms  | 196 ms |
| Set acknowledgement  | 26 ms   | —      |

- Back-to-back commands with **0 ms** gap: no errors in 100 queries. The default gap is now 20 ms for margin.
- 30 s soak (500 ms single-zone poll plus a 2 s unit sweep): 0 errors, 0 overruns. Mirror polling of one primary uses about 10% of the line.

## Behaviour that shaped the code

- **Settings sent to a powered-off zone are acknowledged but not applied.** The model declares `quirks.ignoresSetsWhenOff`. As a result:
  - API changes to an off zone are rejected unless the same request turns the zone on.
  - Writes are ordered power-on first and power-off last.
  - Mirror fan-out skips non-power settings while a follower is off, and re-reads and fully syncs followers when the primary powers on.
  - The UI hides source, volume and tone controls while a zone is off.
  - The simulator now behaves the same way.
- **Settings survive a zone power off/on cycle.**
