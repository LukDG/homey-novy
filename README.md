# Novy for Homey

Homey app (`be.lukdg.novy`) for local control of Novy cooker hoods over Bluetooth Low Energy.
The app talks to the hood the same way the official Novy app does. No cloud involved.

Developed and tested with a **Novy Pureline** (product type 6911). Other Novy hoods that work
with the Novy app over Bluetooth (Pureline Pro, Cloud, ...) use the same protocol and will
probably work too.

## Features

- **Two devices per hood**, so it is always clear what is on:
  - *Novy hood*: extraction on/off and speed (0–100 %), recirculation mode, status (off,
    running, boost, run-on) with the remaining timer, grease filter alarm and remaining hours
  - *Novy hood light*: on/off, brightness and colour temperature (white or ambient). It has no
    connection of its own and works through the hood device
- **Dashboard widget** with extraction, light and air quality on one tile
- **Optional features**, added automatically when the hood supports them: auto mode, keypad
  lock, carbon filter, temperature, humidity and CO2
- **Pairing like the Novy app**: the hood is confirmed with the on/off button on the Novy
  remote control (or skipped)
- **Flows**
  - Triggers: status changed, grease filter needs cleaning, carbon filter needs replacing
    (the light device has Homey's standard light cards)
  - Conditions: recirculation on, auto mode on, keypad lock on, status is
  - Actions: fan speed, run on and switch off, recirculation, auto mode, keypad lock, reset
    grease/carbon filter, power button, store default speed, send raw command, and on the light
    device: light on in white or ambient mode
- **Log** on the app settings page (in memory only, max 256 KB)
- Translated in all 13 languages Homey supports

## Development

```
homey app run --remote          # run on your Homey Pro
npm test                        # protocol parser tests
```

`app.json` is edited directly (no Homey Compose). Release with
`node scripts/set-version.js "English" "Nederlands"` (see `VERSIONING.md`).

## Protocol

Nordic UART Service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`; ASCII frames `[cmd;arg;…]` to RX
(`…0002`), replies on TX (`…0003`). Hoods advertise service `8ec90001-f315-4f60-9fb8-838830daea50`.

- Commands answer with an ACK `[1;1;value]`; getters `[n;0]` answer `[1;1;value]`, `[0;0]` = not supported.
- Status `[400;0]` returns a 16-byte binary packet, `[402;0]`–`[404;0]` 20-byte packets.

| Cmd | Meaning | Frame |
|---|---|---|
| 10 | power button (on / off with run-on) | `[10;0]` |
| 15 / 16 / 36 | light ambient / white / off | `[16;0]` |
| 21 / 22 | brightness / colour temperature 0–255 | `[21;1;200]` |
| 23 / 24 | reset grease / carbon filter | `[23;0]` |
| 25 | recirculation on/off | `[25;1;1]` |
| 26 | auto mode on/off | `[26;1;1]` |
| 28 / 29 | fan speed 0–100 % / fan on-off | `[28;1;60]` |
| 38 / 39 | hood on / off | `[39;0]` |
| 41 | store current speed as default | `[41;0]` |
| 54 | keypad lock on/off | `[54;1;1]` |
| 104 / 105 / 106 | temperature (°C) / humidity (‰) / CO2 (ppm) | `[104;0]` |
| 116 / 127 / 129 / 140 | auto mode / carbon filter available / remaining / keypad lock | `[116;0]` |
| 206 / 207 / 213 | serial / product type / OEM id | `[206;0]` |
| 300 / 301 | pairing: wait for remote / check confirmation | `[300;0]`, `[301;1;0]` |
| 400–404 | binary status packets | `[400;0]` |

Pairing sequence (same as the Novy app): `[402;0]`, `[39;0]`, `[300;0]`, then `[301;1;0]` every
second until the reply starts with `1` (on/off pressed on the remote), then `[213;0]`.

Status packet layout based on [bwynants/hass-purelinepro](https://github.com/bwynants/hass-purelinepro) (MIT).

## Author

Luk De Groote — https://github.com/LukDG
