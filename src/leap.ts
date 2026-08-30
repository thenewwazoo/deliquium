import {
  BridgeFinder,
  LEAP_PORT,
  LeapClient,
  SmartBridge,
  type AreaDefinition,
  type DeviceDefinition,
  type MultipleAreaDefinition,
  type MultipleZoneDefinition,
  type OneZoneStatus,
  type ZoneDefinition,
} from 'lutron-leap'

const DISCOVERY_TIMEOUT_MS = 10_000

export type { AreaDefinition, DeviceDefinition, ZoneDefinition }

export interface LeapSecret {
  bridgeid?: string
  ca: string
  cert: string
  key: string
}

export interface LeapSession {
  /** Current *commanded* level. The bridge does not report instantaneous output. */
  level(zone: string): Promise<number | undefined>
  /** Fade to `level` over `fadeTime` (HH:MM:SS). Runs in the dimmer, not here. */
  fadeTo(zone: string, level: number, fadeTime: string): Promise<unknown>
  /** Immediate set. Also supersedes a fade already in flight. */
  setLevel(zone: string, level: number): Promise<unknown>
  areas(): Promise<AreaDefinition[]>
  devices(): Promise<DeviceDefinition[]>
  zones(): Promise<ZoneDefinition[]>
  close(): void
}

export interface ConnectOptions {
  /** Which bridge, when more than one is on the network. Taken from the secrets. */
  bridgeId?: string
  ca: string
  cert: string
  key: string
  discoveryTimeoutMs?: number
}

/**
 * Pick LEAP client certs out of a config block. Takes the same shape
 * homebridge-lutron-caseta-leap uses — an array of { bridgeid, ca, key, cert } —
 * so the array can be copied straight across. A bare { ca, key, cert } also works.
 */
export function pickSecrets(secrets: unknown, bridgeId?: string): LeapSecret {
  if (!secrets) {
    throw new Error('no "secrets" in config: copy the secrets array from your homebridge-lutron-caseta-leap platform block')
  }
  const list = (Array.isArray(secrets) ? secrets : [secrets]) as Partial<LeapSecret>[]
  const found = bridgeId ? list.find(s => sameBridge(s?.bridgeid, bridgeId)) : list[0]
  if (!found) {
    throw new Error(`no LEAP certificates for bridge "${bridgeId}" (found: ${list.map(s => s?.bridgeid ?? '?').join(', ') || 'none'})`)
  }
  for (const field of ['ca', 'cert', 'key'] as const) {
    const value = found[field]
    if (typeof value !== 'string' || !value.includes('-----BEGIN')) {
      throw new Error(`LEAP secret "${field}" is missing or not PEM${bridgeId ? ` for bridge ${bridgeId}` : ''}`)
    }
  }
  return found as LeapSecret
}

/**
 * The same identifier is cased differently depending on where it is read: mDNS
 * advertises 032E7E88, the stored secrets say 032e7e88.
 */
export function sameBridge(a: string | undefined, b: string | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

/** Find a bridge by ID, or the first one on the network if no ID is given. */
export function discoverBridge(bridgeId?: string, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const finder = new BridgeFinder()
    const seen: string[] = []
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      // Stop the mDNS browser; nothing else will shut it down.
      finder.destroy()
      fn()
    }

    const timer = setTimeout(() => finish(() => reject(new Error(
      seen.length
        ? `no bridge matching "${bridgeId}" on the network (found ${seen.join(', ')})`
        : 'no Lutron bridge found on the network; set bridge.host if mDNS cannot reach it',
    ))), timeoutMs)
    timer.unref?.()

    finder.on('discovered', (bridge) => {
      seen.push(`${bridge.bridgeid} at ${bridge.ipAddr}`)
      if (!bridgeId || sameBridge(bridge.bridgeid, bridgeId)) {
        finish(() => resolve(bridge.ipAddr))
      }
    })
    finder.on('failed', err => finish(() => reject(err)))
    finder.beginSearching()
  })
}

/**
 * A bridge's address rarely changes, and each discovery leaves a self-perpetuating
 * refresh timer behind (tinkerhub-mdns queues one per response and does not clear
 * it on destroy), so search once and reuse the answer.
 */
let known: { bridgeId?: string, host: string } | null = null

async function open(options: ConnectOptions): Promise<{ client: LeapClient, host: string }> {
  const attempt = async (host: string): Promise<{ client: LeapClient, host: string }> => {
    const client = new LeapClient(host, LEAP_PORT, options.ca, options.key, options.cert)
    await client.connect()
    known = { bridgeId: options.bridgeId, host }
    return { client, host }
  }

  if (known && sameBridge(known.bridgeId ?? options.bridgeId, options.bridgeId ?? known.bridgeId)) {
    try {
      return await attempt(known.host)
    } catch {
      // Moved, or was never there. Fall through and search again.
      known = null
    }
  }
  return attempt(await discoverBridge(options.bridgeId, options.discoveryTimeoutMs))
}

/**
 * Open a LEAP session. Short-lived by design: connect, issue commands, close.
 * Fades run in the dimmer hardware, so there is nothing to keep alive afterwards —
 * which is also why the bridge's ping loop is left unstarted.
 */
export async function connect(options: ConnectOptions): Promise<LeapSession> {
  const { client, host } = await open(options)
  const bridge = new SmartBridge(options.bridgeId ?? host, client)

  const command = (zone: string, body: Record<string, unknown>): Promise<unknown> =>
    client.request('CreateRequest', `${zone}/commandprocessor`, body)

  return {
    async level(zone) {
      const status = await client.retrieve<OneZoneStatus>({ href: zone }, '/status')
      return status?.ZoneStatus?.Level
    },

    fadeTo(zone, level, fadeTime) {
      return command(zone, {
        Command: {
          CommandType: 'GoToDimmedLevel',
          DimmedLevelParameters: { Level: level, FadeTime: fadeTime },
        },
      })
    },

    setLevel(zone, level) {
      return command(zone, {
        Command: { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: level }] },
      })
    },

    async areas() {
      const body = await client.retrieve<MultipleAreaDefinition>({ href: '/area' })
      return body?.Areas ?? []
    },

    devices() {
      return bridge.getDeviceInfo()
    },

    async zones() {
      const body = await client.retrieve<MultipleZoneDefinition>({ href: '/zone' })
      return body?.Zones ?? []
    },

    close() {
      // drain(), not close(): close() only ends the socket and leaves in-flight
      // request timers running, which keeps the process alive.
      client.drain()
    },
  }
}
