import test from 'node:test'
import assert from 'node:assert/strict'
import SunCalc from 'suncalc'
import { decide, computeWindow, formatFadeTime, DEFAULTS } from '../dist/ramp.js'

const MID = 40      // mid-latitude
const HIGH = 61.2   // Anchorage: no dusk at midsummer

const dim = (target: number) => ({ target, direction: 'dim' } as const)
const brighten = (target: number) => ({ target, direction: 'brighten' } as const)

test('formatFadeTime renders LEAP HH:MM:SS', () => {
  assert.equal(formatFadeTime(0), '00:00:00')
  assert.equal(formatFadeTime(90), '00:01:30')
  assert.equal(formatFadeTime(3600), '01:00:00')
  assert.equal(formatFadeTime(15441), '04:17:21')
  assert.equal(formatFadeTime(-5), '00:00:00', 'negative durations floor at zero')
})

// --- the decision rule ---

test('dim lowers, and skips anything already low enough', () => {
  assert.equal(decide(dim(11), 50).action, 'fade')
  assert.equal(decide(dim(11), 12).action, 'fade')
  assert.equal(decide(dim(11), 11).action, 'skip', 'already at target')
  assert.equal(decide(dim(11), 5).action, 'skip', 'already dimmer')
})

test('brighten raises, and skips anything already high enough', () => {
  assert.equal(decide(brighten(60), 20).action, 'fade')
  assert.equal(decide(brighten(60), 60).action, 'skip')
  assert.equal(decide(brighten(60), 80).action, 'skip')
})

test('an off light is skipped when dimming and turned on when brightening', () => {
  // No special case for zero: dimming cannot go below it, brightening can.
  assert.equal(decide(dim(11), 0).action, 'skip')
  assert.equal(decide(dim(11), 0).reason, 'off')

  const up = decide(brighten(60), 0)
  assert.equal(up.action, 'fade')
  assert.match(up.reason, /off -> 60%/)
})

test('the two directions disagree, and exactly one acts', () => {
  assert.equal(decide(dim(11), 40).action, 'fade')
  assert.equal(decide(brighten(11), 40).action, 'skip')
})

test('skip reasons name the side that was already satisfied', () => {
  assert.match(decide(dim(11), 5).reason, /at or below target/)
  assert.match(decide(brighten(60), 80).reason, /at or above target/)
})

test('an unreadable level is skipped rather than guessed at', () => {
  assert.equal(decide(dim(11), undefined).action, 'skip')
  assert.equal(decide(brighten(60), null).action, 'skip')
})

test('direction is read off the light, with nothing to inherit', () => {
  // A light fully describes its own transition. There is no ramp-level default,
  // so the same light always decides the same way wherever it appears.
  const light = dim(11)
  assert.equal(decide(light, 50).action, 'fade')
  assert.equal(decide(light, 5).action, 'skip')
})

// --- the window ---

test('the window is civil twilight and is not configurable', () => {
  const w = computeWindow({ lat: MID, now: new Date('2026-03-20T12:00:00Z') })
  assert.equal(w.from, 'sunset')
  assert.equal(w.to, 'dusk')
  const forced = computeWindow({ lat: MID, from: 'goldenHour', to: 'night', now: new Date('2026-03-20T12:00:00Z') } as never)
  assert.equal(forced.seconds, w.seconds)
})

test('duration is the length of the twilight', () => {
  const w = computeWindow({ lat: MID, now: new Date('2026-03-20T12:00:00Z') })
  assert.equal(w.skip, false)
  assert.ok(w.seconds > 25 * 60 && w.seconds < 29 * 60, `got ${w.seconds}s`)
})

test('time of day does not change the duration, only the date does', () => {
  const at = (t: string) => computeWindow({ lat: MID, now: new Date(`2026-03-20T${t}Z`) }).seconds
  assert.equal(at('01:00:00'), at('12:00:00'))
  assert.equal(at('12:00:00'), at('23:00:00'))
})

test('longitude is not an input at all', () => {
  const a = computeWindow({ lat: MID, now: new Date('2026-09-15T12:00:00Z') })
  const b = computeWindow({ lat: MID, lon: 151, now: new Date('2026-09-15T12:00:00Z') } as never)
  assert.equal(a.seconds, b.seconds)
})

test('twilight lengthens towards midsummer', () => {
  const eq = computeWindow({ lat: MID, now: new Date('2026-03-20T12:00:00Z') }).seconds
  const jun = computeWindow({ lat: MID, now: new Date('2026-06-21T12:00:00Z') }).seconds
  assert.ok(jun > eq, 'June solstice is the maximum at mid-latitudes')
})

test('twilight lengthens with latitude', () => {
  const date = new Date('2026-06-21T12:00:00Z')
  const low = computeWindow({ lat: 10, now: date }).seconds
  const mid = computeWindow({ lat: 40, now: date }).seconds
  const high = computeWindow({ lat: 55, now: date }).seconds
  assert.ok(low < mid && mid < high)
})

test('hemispheres mirror across the solstices', () => {
  const north = computeWindow({ lat: 45, now: new Date('2026-06-21T12:00:00Z') }).seconds
  const south = computeWindow({ lat: -45, now: new Date('2026-12-21T12:00:00Z') }).seconds
  assert.ok(Math.abs(north - south) < 60, `${north} vs ${south}`)
})

test('morning and evening twilight are the same length, so sunrise needs no window of its own', () => {
  // Load-bearing: one hardcoded sunset->dusk window serves the sunrise ramp too.
  for (const lat of [0, MID, 55]) {
    for (const day of ['2026-03-20', '2026-06-21', '2026-12-21']) {
      const t = SunCalc.getTimes(new Date(`${day}T12:00:00Z`), lat, 0)
      const morning = t.sunrise.getTime() - t.dawn.getTime()
      const evening = t.dusk.getTime() - t.sunset.getTime()
      assert.ok(Math.abs(morning - evening) < 1000, `lat ${lat} ${day}: ${morning} vs ${evening}`)
    }
  }
})

test('no twilight to match means no ramp', () => {
  const w = computeWindow({ lat: HIGH, now: new Date('2026-06-21T12:00:00Z') })
  assert.equal(w.skip, true)
  assert.equal(w.seconds, 0)
  assert.match(w.note!, /civil twilight does not end/)
})

test('the same high latitude works fine most of the year', () => {
  const w = computeWindow({ lat: HIGH, now: new Date('2026-12-21T12:00:00Z') })
  assert.equal(w.skip, false, 'midwinter twilight at 61N is long, not absent')
  assert.ok(w.seconds > 30 * 60)
})

test('duration is uncapped by default', () => {
  assert.equal(DEFAULTS.maxMinutes, null)
  const w = computeWindow({ lat: 55, now: new Date('2026-06-21T12:00:00Z') })
  assert.equal(w.seconds, w.requestedSeconds)
  assert.equal(w.note, null)
})

test('maxMinutes caps only when explicitly set', () => {
  const w = computeWindow({ lat: 55, now: new Date('2026-06-21T12:00:00Z'), maxMinutes: 30 })
  assert.equal(w.seconds, 30 * 60)
  assert.match(w.note!, /capped to 30min/)
})

test('missing latitude fails loudly', () => {
  assert.throws(() => computeWindow({} as never), /location\.lat is required/)
  assert.throws(() => computeWindow({ lat: '40' } as never), /location\.lat is required/)
})
