# deliquium

Gradual twilight lighting for Lutron Caseta, triggered from HomeKit.

HomeKit sets brightness instantly. A lighting change tied to sunset therefore lands
as a single abrupt step. This spreads that change across the twilight itself, so the
lights move at the same pace as the sky — over about half an hour, and longer in
summer than at the equinoxes.

A ramp can go either way. Dim the overheads as the light goes, bring a lamp up as
the room darkens, do both in the same action, or run the whole thing in reverse at
dawn.

## Installing

Requires Homebridge 2.x, and a Caseta Smart Bridge already paired with
`homebridge-lutron-caseta-leap` — this reuses the LEAP certificates that pairing
produced rather than pairing again.

```
sudo hb-service add homebridge-deliquium
```

Then add the platform block below to `config.json` and restart Homebridge.

## How it works

```
HomeKit automation          this plugin                   Caseta bridge
"At sunset,          →      read levels, issue       →    hardware runs the
 if anyone is home,         one GoToDimmedLevel            fade itself
 turn on <ramp switch>"     per light
```

Each part does what it is good at:

- **HomeKit** owns presence. It is the only system that knows who is home, and it
  keeps that to itself, so you've got to use Home to start the transition.
- **The plugin** knows astronomy and lighting design: how long the fade lasts, which lights move,
  and which way.
- **The dimmer** manages ramping the light itself. Caseta honours `FadeTime` on `GoToDimmedLevel`,
  so a single command produces the whole fade in hardware.

Because the fade runs in the dimmer rather than here, Homebridge can restart
mid-ramp without disturbing it, nothing polls, and a fade always looks smooth rather
than stepped. Touching a wall dimmer or a Pico supersedes it in hardware, so a
person or intentional input can override an in-progress ramp.

## Lights

Each light names a `zone`, a `target` to end at, and a `direction` to travel.

| direction | acts when | leaves it alone when |
| --- | --- | --- |
| `dim` | target is below the current level | already at or below target |
| `brighten` | target is above the current level | already at or above target |

A light only ever moves *towards* its target from the configured side. That one rule
covers both halves: it leaves alone anything already past the target, and it
guarantees a ramp will never undo a manual adjustment. Re-triggering a ramp is
idempotent.

A light that is off reports `0`, which the same rule handles. Dimming cannot go below
it, so an off light stays off; brightening can, so an off light is switched on and
raised across the full twilight. On a Caseta plug-in dimmer that ramp begins from
darkness rather than jumping to a minimum level first.

`direction` belongs to the light, so a single ramp can dim some lights and raise
others in one action:

```json
{
  "name": "Living Room Sunset Ramp",
  "lights": [
    { "zone": "/zone/7",  "target": 11, "direction": "dim",      "note": "Recessed Lights" },
    { "zone": "/zone/34", "target": 60, "direction": "brighten", "note": "Chair Lamp" }
  ]
}
```

`zone` values are LEAP zone hrefs; `deliquium list` prints them. On Caseta a zone
maps one-to-one to a single device. (RA3 and QSX differ, where a zone can aggregate
several load controllers.)

A light missing a `zone`, `target` or `direction` is reported at startup and left
out. A ramp with no usable lights publishes no switch, since a switch with nothing
behind it looks like it works.

## The window

The ramp spans **civil twilight**:

| boundary | solar altitude | meaning |
| --- | --- | --- |
| start | **-0.833 deg** | the sun's upper limb drops below the apparent horizon (0.267 deg semidiameter plus about 0.567 deg of refraction) |
| end | **-6 deg** | civil twilight ends; the sky is dark |

That gap is what makes the ramp seasonal. At 40 degrees it runs 27 minutes at the
equinoxes, 33 at midsummer and 31 at midwinter; at 55 degrees, 36 and 58 and 46.

The plugin uses the *length* of that window and never its absolute times, so the
ramp lasts one twilight whenever it is triggered. Morning and evening civil twilight
are exactly the same length at every latitude and date, which is why a dawn ramp
needs nothing extra — give it its own switch and let the automation choose the hour.

**Latitude is the only location input.** Twilight length depends on solar
declination, which comes from the date, and on latitude. Longitude decides when
twilight happens, never how long it lasts: across 349 degrees of longitude the
computed length moves by two seconds. Latitude is signed, so the southern hemisphere
is a negative number and the seasons follow from the date.

One decimal place is within about 20 seconds of the true length, so the only error
worth worrying about is being in the wrong city.

The duration matches the twilight exactly. `maxMinutes` adds a ceiling if you want
one; see the bridge notes for why you might.

## High latitudes

Above roughly 60.5 degrees the sun does not reach -6 for a few weeks around
midsummer. Twilight never ends, so there is no window to match and the ramp is
skipped for those weeks, logged as such. The same latitude behaves normally the rest
of the year, and its midwinter twilight is long and slow.

## Configuration

Add to Homebridge `config.json`:

```json
{
  "platform": "Deliquium",
  "secrets": [
    {
      "bridgeid": "032e7e88",
      "ca": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
      "key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
      "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
    }
  ],
  "location": { "lat": 51.5 },
  "switchResetSeconds": 5,
  "ramps": [
    {
      "name": "Living Room Sunset Ramp",
      "cooldownMinutes": 60,
      "lights": [
        { "zone": "/zone/7",  "target": 11, "direction": "dim",      "note": "Recessed Lights" },
        { "zone": "/zone/34", "target": 60, "direction": "brighten", "note": "Chair Lamp" }
      ]
    },
    {
      "name": "Living Room Sunrise Ramp",
      "cooldownMinutes": 60,
      "lights": [
        { "zone": "/zone/7",  "target": 50, "direction": "brighten", "note": "Recessed Lights" },
        { "zone": "/zone/34", "target": 0,  "direction": "dim",      "note": "Chair Lamp" }
      ]
    }
  ]
}
```

`secrets` is the LEAP client certificate set, in the shape
`homebridge-lutron-caseta-leap` stores it, so that array can be copied straight
across. A bare `{ ca, cert, key }` object works too.

**The bridge is not configured.** It is auto-discovered on the network over mDNS, matched against
the `bridgeid` in the secrets, and its address is remembered until a connection fails. There is no
host or port to set and no address to keep up to date.

`cooldownMinutes` ignores a repeat trigger within that span. `switchResetSeconds`
controls how long each switch stays on before resetting itself.

## The ramp switch

Each ramp publishes one HomeKit switch, and it is a **button rather than a state**.
Turning it on starts the ramp; a few seconds later it resets itself to off so
HomeKit can trigger it again the next day. That reset happens whatever the ramp did,
because a switch left on would quietly skip every day after.

To stop a ramp part way, adjust the lights. That supersedes the fade in the dimmer.

## HomeKit automations

Give each ramp a trigger and a presence condition:

1. **At Sunset** → *Only if* **Anyone is home** → turn on `Living Room Sunset Ramp`.
2. **At Sunrise** → *Only if* **Anyone is home** → turn on `Living Room Sunrise Ramp`.

Presence never reaches the plugin and does not need to. HomeKit evaluates it at the
moment of triggering, using the geofence it already maintains.

## CLI

Runs anywhere with network access to the bridge, and reads the same config shape as
the Homebridge platform block, so one file serves both.

From a checkout, after `npm run build`:

```
node dist/cli.js list    --config config.json              dimmable lights by room
node dist/cli.js window  --config config.json              the computed window
node dist/cli.js run     --config config.json --dry-run    decide and print, send nothing
node dist/cli.js run     --config config.json --minutes 2  run with an explicit duration
node dist/cli.js restore --config config.json --level 50   set configured lights to a level
```

Installing the package puts a `deliquium` command on `PATH`, and from inside a
checkout `npx deliquium …` resolves the local build. Run `npx` from anywhere else
and npm will go looking on the registry instead, so prefer the explicit path when
you are not sure.

`--ramp <name>` picks a ramp when there is more than one. `--zone <href>` narrows
`restore` to a single light; without it, `restore` sets every light in the ramp.

`--now <iso>` answers what a given date would do, without waiting for the calendar:

```
node dist/cli.js window --config config.json --now 2026-12-21T16:45:00
```

## Notes on the bridge

Established against a Smart Bridge 2 on firmware `08.28.11f000`:

- `GoToDimmedLevel` with `FadeTime` (`HH:MM:SS`) is honoured on `WallDimmer` and
  `PlugInDimmer`, including fades up from off. 30-minute fades work. Longer values
  return `201 Created`, but the bridge returns `201` for durations it may or may not
  honour and offers no telemetry to check against, so treat anything past 30 minutes
  as unverified — `maxMinutes` is the lever if a long fade ever misbehaves.
- `ZoneStatus.Level` reports the **commanded target**, updated immediately, and
  `StatusAccuracy` reads `Good` throughout a fade. Instantaneous output is not
  readable.
- `GoToLevel` supersedes a fade already in flight.
- The bridge accepts a second LEAP connection alongside an existing one.

## Development

TypeScript and ESM, requiring Homebridge 2.x.

```
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm test           # build, then node --test
```

`src/ramp.ts` holds the logic and imports nothing from Homebridge, so it is testable
without hardware. `src/leap.ts` is the bridge client, `src/index.ts` the Homebridge
wrapper, `src/cli.ts` the command line. Tests run against `dist/`, so what is
exercised is what ships.

`homebridge` is a devDependency, for types only.
