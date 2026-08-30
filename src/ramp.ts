import SunCalc from 'suncalc'
import type { LeapSession } from './leap.js'

export type Direction = 'dim' | 'brighten'

export interface Light {
  zone: string
  /** Where this light should end up, 0-100. */
  target: number
  /** Which way this light travels. A property of the light's own transition, so
   *  one ramp can dim some lights and raise others in the same action. */
  direction: Direction
  note?: string
}

export interface Logger {
  info(message: string): void
  warn(message: string): void
}

export interface RampWindow {
  skip: boolean
  seconds: number
  requestedSeconds: number | null
  from: string
  to: string
  note: string | null
}

export type Action = 'fade' | 'skip' | 'error'

export interface Verdict {
  action: Action
  reason: string
}

export interface RampResult extends Verdict {
  light: Light
  actual?: number | undefined
  fadeTime?: string
  dryRun?: boolean
}

export const DEFAULTS = {
  maxMinutes: null as number | null,
}

// The ramp spans civil twilight, and this is not configurable.
//   sunset  -0.833 deg  the sun's upper limb goes below the apparent horizon
//                       (0.267 semidiameter + ~0.567 refraction)
//   dusk    -6 deg      civil twilight ends; the sky is dark
// suncalc's names are unhelpful here — its "dusk" is the -6 boundary, not nautical.
const FROM = 'sunset'
const TO = 'dusk'

/** LEAP wants fade durations as HH:MM:SS. */
export function formatFadeTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
}

export interface ComputeWindowOptions {
  lat: number
  now?: Date
  maxMinutes?: number | null
}

/**
 * How long the ramp should take: the length of civil twilight.
 *
 * Twilight *length* is a function of solar declination — which comes from the
 * date — and latitude. Longitude decides only when twilight happens, never how
 * long it lasts, so it is not an input, and neither is the clock. Latitude is
 * signed; the southern hemisphere works by giving a negative value and the
 * seasons follow from the date.
 *
 * The seasonal behaviour the whole feature wants falls out of this for free.
 */
export function computeWindow({ lat, now = new Date(), maxMinutes = DEFAULTS.maxMinutes }: ComputeWindowOptions): RampWindow {
  if (typeof lat !== 'number' || Number.isNaN(lat)) {
    throw new Error('location.lat is required (a number; negative in the southern hemisphere)')
  }

  // Longitude is passed as 0 purely because suncalc demands one. It cancels out.
  const times = SunCalc.getTimes(now, lat, 0)
  const start = times[FROM as keyof typeof times] as Date | undefined
  const end = times[TO as keyof typeof times] as Date | undefined
  const usable = (d: Date | undefined): d is Date => d instanceof Date && !Number.isNaN(d.getTime())

  // Above roughly 60.5 degrees the sun never reaches -6 for a few weeks around
  // midsummer, so there is no twilight to match and nothing sensible to do.
  if (!usable(start) || !usable(end)) {
    return {
      skip: true,
      seconds: 0,
      requestedSeconds: null,
      from: FROM,
      to: TO,
      note: `civil twilight does not end at ${lat} degrees on this date`,
    }
  }

  const raw = Math.round((end.getTime() - start.getTime()) / 1000)
  const capped = typeof maxMinutes === 'number' && maxMinutes > 0
  const seconds = capped ? Math.min(raw, maxMinutes * 60) : raw
  const note = capped && raw > maxMinutes * 60
    ? `twilight is ${Math.round(raw / 60)}min, capped to ${maxMinutes}min`
    : null

  return { skip: false, seconds, requestedSeconds: raw, from: FROM, to: TO, note }
}

/**
 * Whether a single light should move. Pure, so the interesting rule is testable.
 *
 * A light only ever moves *towards* its target from the configured side. That is
 * both halves of the feature at once: it implements "leave it alone if it is
 * already past the target", and it guarantees a ramp can never undo a manual
 * adjustment, in either direction.
 *
 * A light that is off reports 0, which needs no special case. Dimming cannot go
 * below it, so an off light is skipped; brightening can, so an off light is turned
 * on and raised — which is the point of `brighten`.
 */
export function decide(
  light: Pick<Light, 'target' | 'direction'>,
  actual: number | undefined | null,
): Verdict {
  if (typeof actual !== 'number') {
    return { action: 'skip', reason: 'level unreadable' }
  }

  const { direction } = light
  const pastTarget = direction === 'dim'
    ? light.target >= actual
    : light.target <= actual

  if (pastTarget) {
    if (actual === 0) {
      return { action: 'skip', reason: 'off' }
    }
    const side = direction === 'dim' ? 'at or below' : 'at or above'
    return { action: 'skip', reason: `already at ${actual}%, ${side} target ${light.target}%` }
  }

  const from = actual === 0 ? 'off' : `${actual}%`
  return { action: 'fade', reason: `${from} -> ${light.target}%` }
}

export interface RunRampOptions {
  session: LeapSession
  lights: Light[]
  fadeSeconds: number
  dryRun?: boolean
  log?: Logger
}

/**
 * Read each light, decide, and issue at most one fade apiece.
 *
 * Deliberately fire-and-forget: the dimmer runs the fade itself, so nothing here
 * needs to survive. A human touching a switch mid-fade supersedes it in hardware,
 * which is why there is no override-tracking code.
 */
export async function runRamp({ session, lights, fadeSeconds, dryRun = false, log = console }: RunRampOptions): Promise<RampResult[]> {
  const fadeTime = formatFadeTime(fadeSeconds)
  const results: RampResult[] = []

  for (const light of lights) {
    const label = light.note ? `${light.zone} (${light.note})` : light.zone
    let actual: number | undefined
    try {
      actual = await session.level(light.zone)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn(`${label}: could not read level — ${reason}`)
      results.push({ light, action: 'error', reason })
      continue
    }

    const verdict = decide(light, actual)
    if (verdict.action === 'skip') {
      log.info(`${label}: skip (${verdict.reason})`)
      results.push({ light, actual, ...verdict })
      continue
    }

    if (dryRun) {
      log.info(`${label}: WOULD ${light.direction} ${verdict.reason} over ${fadeTime}`)
      results.push({ light, actual, ...verdict, dryRun: true })
      continue
    }

    try {
      await session.fadeTo(light.zone, light.target, fadeTime)
      log.info(`${label}: ${light.direction} ${verdict.reason} over ${fadeTime}`)
      results.push({ light, actual, ...verdict, fadeTime })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn(`${label}: fade command failed — ${reason}`)
      results.push({ light, actual, action: 'error', reason })
    }
  }

  return results
}
