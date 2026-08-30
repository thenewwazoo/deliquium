import type {
  API,
  AccessoryPlugin,
  Logging,
  PlatformConfig,
  Service,
  StaticPlatformPlugin,
} from 'homebridge'

import { connect, pickSecrets } from './leap.js'
import { computeWindow, runRamp, DEFAULTS, type Direction, type Light } from './ramp.js'

const PLUGIN_NAME = 'homebridge-deliquium'
const PLATFORM_NAME = 'Deliquium'

export interface RampConfig {
  name?: string
  cooldownMinutes?: number
  maxMinutes?: number | null
  lights?: Light[]
}

const DIRECTIONS: Direction[] = ['dim', 'brighten']

/**
 * Drop anything malformed rather than failing at fade time. A ramp with nothing
 * usable left publishes no accessory at all — an empty switch in the Home app is
 * worse than a missing one, because it looks like it works.
 */
function usableLights(ramp: RampConfig, log: Logging): Light[] {
  const label = ramp.name ?? 'unnamed ramp'
  return (ramp.lights ?? []).filter((light, i) => {
    const where = `${label} light ${i + 1}`
    if (typeof light?.zone !== 'string' || !light.zone.startsWith('/zone/')) {
      log.error(`config: ${where} needs a zone like "/zone/7"`)
      return false
    }
    if (typeof light.target !== 'number' || light.target < 0 || light.target > 100) {
      log.error(`config: ${where} (${light.zone}) needs a target between 0 and 100`)
      return false
    }
    if (!DIRECTIONS.includes(light.direction)) {
      log.error(`config: ${where} (${light.zone}) needs a direction of "dim" or "brighten"`)
      return false
    }
    return true
  })
}

export interface DeliquiumConfig extends PlatformConfig {
  secrets?: unknown
  location?: { lat?: number }
  switchResetSeconds?: number
  ramps?: RampConfig[]
}

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DeliquiumPlatform)
}

/**
 * Static platform: one switch per configured ramp. Nothing is cached between
 * restarts, and nothing needs to be — a fade in progress lives in the dimmer.
 */
class DeliquiumPlatform implements StaticPlatformPlugin {
  readonly log: Logging
  readonly config: DeliquiumConfig
  readonly api: API

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log
    this.config = (config ?? {}) as DeliquiumConfig
    this.api = api
  }

  accessories(callback: (accessories: AccessoryPlugin[]) => void): void {
    const { location, ramps } = this.config

    const problems: string[] = []
    if (!this.config.secrets) {
      problems.push('secrets is not set: copy the secrets array from your homebridge-lutron-caseta-leap platform block')
    }
    if (typeof location?.lat !== 'number') {
      problems.push('location.lat must be a number (negative in the southern hemisphere)')
    }
    if (!Array.isArray(ramps) || ramps.length === 0) {
      problems.push('no ramps configured')
    }
    if (problems.length) {
      for (const p of problems) {
        this.log.error(`config: ${p}`)
      }
      callback([])
      return
    }

    const switches: AccessoryPlugin[] = []
    for (const ramp of ramps!) {
      const label = ramp.name ?? 'unnamed'
      const declared = ramp.lights?.length ?? 0
      const lights = usableLights(ramp, this.log)
      if (!lights.length) {
        if (declared === 0) {
          // A perfectly reasonable state: the ramp exists, its lights come later.
          this.log.info(`ramp "${label}" has no lights yet; its switch will appear once you add some`)
        } else {
          const which = declared === 1
            ? 'its only light is not usable'
            : `none of its ${declared} lights are usable`
          this.log.warn(`ramp "${label}": ${which}, so it has no switch`)
        }
        continue
      }
      switches.push(new RampSwitch(this, { ...ramp, lights }))
    }
    callback(switches)
  }
}

class RampSwitch implements AccessoryPlugin {
  readonly name: string

  private readonly platform: DeliquiumPlatform
  private readonly log: Logging
  private readonly api: API
  private readonly ramp: RampConfig
  private readonly resetMs: number
  private readonly cooldownMs: number

  private lastRunAt = 0
  private on = false
  private resetTimer: NodeJS.Timeout | null = null
  private service?: Service

  constructor(platform: DeliquiumPlatform, ramp: RampConfig) {
    this.platform = platform
    this.log = platform.log
    this.api = platform.api
    this.ramp = ramp
    this.name = ramp.name ?? 'Sunset Ramp'
    this.resetMs = (platform.config.switchResetSeconds ?? 5) * 1000
    this.cooldownMs = (ramp.cooldownMinutes ?? 60) * 60 * 1000
  }

  getServices(): Service[] {
    const { Service: S, Characteristic } = this.api.hap

    const info = new S.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'deliquium')
      .setCharacteristic(Characteristic.Model, 'Sunset Ramp')
      .setCharacteristic(Characteristic.SerialNumber, this.name)

    const service = new S.Switch(this.name)
    service.getCharacteristic(Characteristic.On)
      .onGet(() => this.on)
      .onSet(value => {
        this.handleSet(Boolean(value))
      })

    this.service = service
    return [info, service]
  }

  /**
   * The switch is a button, not a state. Turning it on starts the ramp and,
   * independently, schedules the switch back to off so HomeKit can re-trigger
   * it tomorrow. The reset is deliberately not tied to the ramp's outcome —
   * a stuck "on" would silently kill every future evening.
   */
  private handleSet(value: boolean): void {
    if (!value) {
      this.on = false
      return
    }

    this.on = true
    this.scheduleReset()

    this.trigger().catch((err: unknown) => {
      this.log.error(`${this.name}: ramp failed — ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private scheduleReset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer)
    }
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null
      this.on = false
      this.service?.updateCharacteristic(this.api.hap.Characteristic.On, false)
    }, this.resetMs)
    this.resetTimer.unref?.()
  }

  private async trigger(): Promise<void> {
    const now = Date.now()
    if (now - this.lastRunAt < this.cooldownMs) {
      this.log.info(`${this.name}: ignoring trigger, last ran ${Math.round((now - this.lastRunAt) / 60000)}min ago`)
      return
    }
    this.lastRunAt = now

    const { location } = this.platform.config
    const lights = this.ramp.lights ?? []

    const window = computeWindow({
      lat: location!.lat!,
      maxMinutes: this.ramp.maxMinutes ?? DEFAULTS.maxMinutes,
    })
    if (window.skip) {
      this.log.info(`${this.name}: nothing to do (${window.note})`)
      return
    }
    if (window.note) {
      this.log.info(`${this.name}: ${window.note}`)
    }
    this.log.info(`${this.name}: ramping over ${Math.round(window.seconds / 60)}min (civil twilight at ${location!.lat} degrees)`)

    const secrets = pickSecrets(this.platform.config.secrets)
    // The bridge is found on the network; there is nothing to configure.
    const session = await connect({
      bridgeId: secrets.bridgeid,
      ca: secrets.ca,
      cert: secrets.cert,
      key: secrets.key,
    })

    try {
      await runRamp({ session, lights, fadeSeconds: window.seconds, log: this.log })
    } finally {
      session.close()
    }
  }
}
