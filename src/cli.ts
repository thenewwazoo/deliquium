#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

import { connect, pickSecrets, type AreaDefinition, type LeapSession, type ZoneDefinition } from './leap.js'
import { computeWindow, runRamp, formatFadeTime, DEFAULTS, type Light } from './ramp.js'
import type { DeliquiumConfig, RampConfig } from './index.js'

const args = process.argv.slice(2)
const command = args[0]

const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const has = (name: string): boolean => args.includes(`--${name}`)

const usage = `deliquium — gradual twilight lighting for Lutron Caseta

  deliquium list    --config <file>              list dimmable lights by room
  deliquium window  --config <file>              show the computed ramp window
  deliquium run     --config <file> [options]    run a ramp
  deliquium restore --config <file> --level <n>  set configured lights to <n>

options:
  --ramp <name>     which ramp to use (default: the first)
  --now <iso>       pretend it is this date, e.g. 2026-12-21T16:30:00
  --minutes <n>     run: override the computed duration (skips suncalc)
  --dry-run         run: decide and print, send nothing
  --zone <href>     restore: only this zone, e.g. /zone/7
`

if (!command || has('help')) {
  console.log(usage)
  process.exit(0)
}

const configPath = flag('config', 'config.json')!
let config: DeliquiumConfig
try {
  config = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8')) as DeliquiumConfig
} catch (err) {
  console.error(`could not read config ${configPath}: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

// Config mistakes are the common failure here; a stack trace helps nobody.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  // `deliquium list | head` closes the pipe early. That is the shell working, not
  // an error worth printing.
  if (err.code === 'EPIPE') {
    process.exit(0)
  }
  console.error(`error: ${err.message}`)
  process.exit(1)
})
process.on('unhandledRejection', (err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

const when = (): Date => {
  const raw = flag('now')
  if (!raw) {
    return new Date()
  }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) {
    console.error(`--now "${raw}" is not a date`)
    process.exit(1)
  }
  return d
}

const open = async (): Promise<LeapSession> => {
  const secrets = pickSecrets(config.secrets)
  return connect({
    bridgeId: secrets.bridgeid,
    ca: secrets.ca,
    cert: secrets.cert,
    key: secrets.key,
  })
}

const pickRamp = (): RampConfig => {
  const wanted = flag('ramp')
  const ramps = config.ramps ?? []
  const ramp = wanted ? ramps.find(r => r.name === wanted) : ramps[0]
  if (!ramp) {
    console.error(wanted ? `no ramp named "${wanted}"` : 'no ramps configured')
    process.exit(1)
  }
  return ramp
}

const log = {
  info: (message: string) => { console.log(message) },
  warn: (message: string) => { console.warn(message) },
}

/**
 * The bridge reports an area's devices, which the published AreaDefinition type
 * does not describe (it declares AssociatedZones, which this firmware rejects).
 */
type AreaWithDevices = AreaDefinition & { AssociatedDevices?: { href: string }[] }

/** ZoneDefinition types ControlType; the bridge also sends AvailableControlTypes. */
const isDimmable = (zone: ZoneDefinition | undefined): boolean => {
  const available = (zone as (ZoneDefinition & { AvailableControlTypes?: string[] }) | undefined)?.AvailableControlTypes
  return available ? available.includes('Dimmed') : zone?.ControlType === 'Dimmed'
}

if (command === 'list') {
  const session = await open()
  const [areas, devices, zones] = await Promise.all([session.areas(), session.devices(), session.zones()])
  const deviceByHref = new Map(devices.map(d => [d.href, d]))
  const zoneByHref = new Map(zones.map(z => [z.href, z]))

  // Areas report their devices; each device owns at most one zone on Caseta.
  for (const area of areas) {
    const rows = (area as AreaWithDevices).AssociatedDevices ?? []
    const lights = rows
      .map(({ href }) => deviceByHref.get(href))
      .filter(device => device?.LocalZones?.[0])
      .map(device => ({ device: device!, zone: zoneByHref.get(device!.LocalZones[0]!.href) }))
      .filter(({ zone }) => zone?.Category?.IsLight && isDimmable(zone))
    if (!lights.length) {
      continue
    }
    console.log(`\n${area.Name}`)
    for (const { device, zone } of lights) {
      console.log(`  ${zone!.href.padEnd(10)} ${device.Name}`)
    }
  }
  session.close()
} else if (command === 'window') {
  const ramp = pickRamp()
  const w = computeWindow({
    lat: config.location?.lat as number,
    now: when(),
    maxMinutes: ramp.maxMinutes ?? DEFAULTS.maxMinutes,
  })
  console.log(`ramp:      ${ramp.name}`)
  console.log(`latitude:  ${config.location?.lat}`)
  console.log(`window:    ${w.from} -> ${w.to}`)
  if (w.skip) {
    console.log(`fade:      none — ${w.note}`)
  } else {
    console.log(`twilight:  ${Math.round(w.requestedSeconds! / 60)}min`)
    console.log(`fade:      ${formatFadeTime(w.seconds)}`)
    if (w.note) {
      console.log(`note:      ${w.note}`)
    }
  }
} else if (command === 'run') {
  const ramp = pickRamp()
  const override = flag('minutes')

  let seconds: number
  if (override) {
    seconds = Number(override) * 60
  } else {
    const w = computeWindow({
      lat: config.location?.lat as number,
      now: when(),
      maxMinutes: ramp.maxMinutes ?? DEFAULTS.maxMinutes,
    })
    if (w.skip) {
      console.log(`${ramp.name}: nothing to do (${w.note})`)
      process.exit(0)
    }
    seconds = w.seconds
  }

  console.log(`${ramp.name}: fade ${formatFadeTime(seconds)}${has('dry-run') ? '  (dry run)' : ''}`)
  const session = await open()
  try {
    await runRamp({ session, lights: ramp.lights ?? [], fadeSeconds: seconds, dryRun: has('dry-run'), log })
  } finally {
    session.close()
  }
} else if (command === 'restore') {
  const level = Number(flag('level'))
  if (!Number.isFinite(level)) {
    console.error('--level <n> is required')
    process.exit(1)
  }
  const ramp = pickRamp()
  const only = flag('zone')
  const lights: Light[] = (ramp.lights ?? []).filter(l => !only || l.zone === only)
  if (!lights.length) {
    console.error(only ? `ramp "${ramp.name}" has no light on ${only}` : `ramp "${ramp.name}" has no lights`)
    process.exit(1)
  }
  const session = await open()
  for (const light of lights) {
    await session.setLevel(light.zone, level)
    console.log(`${light.zone} -> ${level}${light.note ? `  (${light.note})` : ''}`)
  }
  session.close()
} else {
  console.error(`unknown command "${command}"\n\n${usage}`)
  process.exit(1)
}

// mDNS discovery leaves a timer behind that nothing here owns, so the event loop
// never empties. Flush stdout, then leave.
process.stdout.write('', () => process.exit(0))
