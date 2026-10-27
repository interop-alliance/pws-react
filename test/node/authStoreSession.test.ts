/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Connected-session tests for the four-state machine: a real seed-derived
 * identity and a real (fake-indexeddb) LocalStore open, with the network edges
 * stubbed (`startWasSync` a no-op, `requestGrants` mocked per test). Covers:
 *
 * - a failed connected activation falls back to a usable `local` replica (never
 *   dead-ends) and surfaces the open error;
 * - `reconnect()` keeps the seed (and stays in `reconnect`) when the re-grant
 *   fails, instead of wiping the seed and logging out;
 * - `boot()` with a grant set that does not cover every configured collection
 *   lands `reconnect` (the proactive banner);
 * - `destroy()` tears the session down WITHOUT wiping the persisted record, so a
 *   fresh `boot()` re-opens it `connected`.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { IZcap } from '@interop/data-integrity-core'
import {
  createAuthStore,
  type WasAuthStore
} from '../../src/session/authStore.js'
import {
  createSeedStore,
  type SeedStore
} from '../../src/identity/seedStore.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import {
  persistAppSession,
  restoreAppSession
} from '../../src/identity/appSession.js'
import { requestGrants } from '../../src/auth/loginFlow.js'
import { parseGrants } from '../../src/grants.js'
import { startWasSync } from '../../src/storage/wasSync.js'
import { hasStore } from '../../src/storage/storageManager.js'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../../src/log.js'
import type { StoreRegistry, WasAppConfig } from '../../src/config.js'

// Replace the live replication bootstrap with an inert resolver.
vi.mock('../../src/storage/wasSync.js', () => ({
  startWasSync: vi.fn(async () => ({})),
  // The login-time descriptor read answers "no descriptor" (an unprovisioned
  // server); a read that FAILED would fail the activation instead.
  readRemoteDescriptors: vi.fn(async () => ({ descriptors: {}, failures: [] }))
}))

// Keep the real login flow but make the re-grant request controllable per test.
vi.mock('../../src/auth/loginFlow.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/auth/loginFlow.js')>()
  return { ...actual, requestGrants: vi.fn() }
})

const requestGrantsMock = vi.mocked(requestGrants)
const startWasSyncMock = vi.mocked(startWasSync)

function baseConfig(collections: { key: string; id: string }[]): WasAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    collections,
    appUrl: 'http://localhost:5173/test-app',
    // A unique base name per config so the RxDB databases never collide
    // across tests sharing the one process-wide fake-indexeddb.
    dbName: `was-react-${Math.random().toString(36).slice(2)}`
  }
}

const registry: StoreRegistry = {}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function pastIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function newSeedStore(): SeedStore {
  return createSeedStore({
    dbName: `was-react-session-${Math.random().toString(36).slice(2)}`,
    idb: new IDBFactory()
  })
}

function noteGrants(): IZcap[] {
  return [
    {
      id: 'urn:zcap:notes',
      invocationTarget: 'http://localhost:3999/space/space-1/notes'
    }
  ] as unknown as IZcap[]
}

/**
 * An INTERNALLY CONSISTENT grant set for a different server origin (the same
 * space id): what `parseGrants` alone cannot catch, and the reconnect
 * continuity check exists for.
 */
function otherServerGrants(): IZcap[] {
  return [
    {
      id: 'urn:zcap:notes',
      invocationTarget: 'http://elsewhere.example:3999/space/space-1/notes'
    }
  ] as unknown as IZcap[]
}

// Well beyond the default 1h near-expiry warning, so the watch never fires.
const FAR_FUTURE_MS = 4 * 60 * 60 * 1000

// Track created stores so their expiry-watch intervals never outlive a test.
const liveStores: WasAuthStore[] = []

beforeEach(() => {
  requestGrantsMock.mockReset()
})

afterEach(async () => {
  while (liveStores.length > 0) {
    await liveStores.pop()!.getState().destroy()
  }
  vi.restoreAllMocks()
})

/**
 * Persists a valid, matching session and drives `boot()` to `connected`.
 */
async function connectedStore({
  config,
  seedStore,
  registry: reg = registry,
  grants = noteGrants(),
  expires = futureIso(FAR_FUTURE_MS)
}: {
  config: WasAppConfig
  seedStore: SeedStore
  registry?: StoreRegistry
  grants?: IZcap[]
  expires?: string
}): Promise<{ store: WasAuthStore; seed: Uint8Array }> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const identity = await deriveIdentity({ seed })
  await persistAppSession({
    session: {
      seed,
      controllerDid: identity.controllerDid,
      baseUrl: 'http://localhost:3999',
      spaceId: 'space-1',
      grants,
      expires
    },
    store: seedStore
  })
  const store = createAuthStore({ config, registry: reg, seedStore })
  liveStores.push(store)
  await store.getState().boot()
  return { store, seed }
}

describe('activateConnected fallback on failure', () => {
  it('falls back to a usable local replica and surfaces the open error', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const identity = await deriveIdentity({ seed })
    const seedStore = newSeedStore()
    await persistAppSession({
      session: {
        seed,
        controllerDid: identity.controllerDid,
        baseUrl: 'http://localhost:3999',
        spaceId: 'space-1',
        grants: noteGrants(),
        expires: futureIso(FAR_FUTURE_MS)
      },
      store: seedStore
    })

    // Hydrate throws on the FIRST call (the connected open) and succeeds after,
    // so the connected activation fails but the local fallback opens cleanly.
    let hydrateCalls = 0
    const flakyRegistry: StoreRegistry = {
      notes: {
        hydrate: async () => {
          hydrateCalls++
          if (hydrateCalls === 1) {
            throw new Error('hydrate boom')
          }
        },
        upsert: () => {},
        drop: () => {},
        clear: () => {}
      }
    }
    const store = createAuthStore({
      config: baseConfig([{ key: 'notes', id: 'notes' }]),
      registry: flakyRegistry,
      seedStore
    })
    liveStores.push(store)

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.getState().boot()

    // The connected activation failed, but the app never dead-ends: it lands in
    // a usable `local` replica with the open error surfaced.
    expect(store.getState().status).toBe('local')
    expect(hasStore()).toBe(true)
    expect(store.getState().error).toBeTruthy()
  })

  it('keeps the activation error when the local fallback fails too', async () => {
    // Hydrate succeeds for the boot (a clean `local`), then throws on every
    // later call: the connected activation fails, and so does the fallback's
    // re-open of the anonymous replica, with a different message.
    let hydrateCalls = 0
    const brokenRegistry: StoreRegistry = {
      notes: {
        hydrate: async () => {
          hydrateCalls++
          if (hydrateCalls === 1) {
            return
          }
          throw new Error(
            hydrateCalls === 2 ? 'connected hydrate boom' : 'local hydrate boom'
          )
        },
        upsert: () => {},
        drop: () => {},
        clear: () => {}
      }
    }
    const store = createAuthStore({
      config: baseConfig([{ key: 'notes', id: 'notes' }]),
      registry: brokenRegistry,
      seedStore: newSeedStore()
    })
    liveStores.push(store)
    await store.getState().boot()
    expect(store.getState().status).toBe('local')

    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    try {
      const seed = crypto.getRandomValues(new Uint8Array(32))
      await expect(
        store.getState().connectWithGrants({ seed, grants: noteGrants() })
      ).rejects.toThrow(/connected hydrate boom/)

      // The fallback's own failure is warned about, not surfaced in its place,
      // and the session still lands local, with no replica attached.
      expect(
        capture.events.some(
          event =>
            event.level === 'warn' &&
            event.msg.includes('re-open the anonymous local replica') &&
            event.err instanceof Error
        )
      ).toBe(true)
      expect(store.getState().error).toMatch(/connected hydrate boom/)
      expect(store.getState().status).toBe('local')
      expect(store.getState().controllerDid).toBeNull()
    } finally {
      setLogger(previous)
    }
  })
})

describe('reconnect() with a failing re-grant', () => {
  it('keeps the seed and stays in reconnect instead of logging out', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store, seed } = await connectedStore({ config, seedStore })
    expect(store.getState().status).toBe('connected')

    // A live 401/403 (or near-expiry) moves the session to `reconnect`.
    store.getState().notifyAccessExpired()
    expect(store.getState().status).toBe('reconnect')

    // Model the exact bug: the persisted record is now past its expiry (only
    // the grants need renewing; the seed survives).
    const identity = await deriveIdentity({ seed })
    await persistAppSession({
      session: {
        seed,
        controllerDid: identity.controllerDid,
        baseUrl: 'http://localhost:3999',
        spaceId: 'space-1',
        grants: noteGrants(),
        expires: pastIso(1000)
      },
      store: seedStore
    })

    // The re-grant popup fails; reconnect must NOT log out over it.
    requestGrantsMock.mockRejectedValue(new Error('grants dismissed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await store.getState().reconnect()

    // The seed survived (old code wiped it via restoreAppSession) and the
    // session was not torn down to `local`.
    expect(await seedStore.loadSeed()).not.toBeNull()
    expect(store.getState().status).toBe('reconnect')
    expect(store.getState().reconnecting).toBe(false)
  })
})

describe('reconnect() storage-location continuity', () => {
  it('refuses a re-grant pointing at a different server', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store } = await connectedStore({ config, seedStore })
    store.getState().notifyAccessExpired()
    expect(store.getState().status).toBe('reconnect')
    const syncCalls = startWasSyncMock.mock.calls.length

    // Internally consistent grants -- for somebody else's server.
    const grants = otherServerGrants()
    requestGrantsMock.mockResolvedValue({
      parsed: parseGrants(grants),
      grants,
      expires: futureIso(FAR_FUTURE_MS)
    })

    await store.getState().reconnect()

    expect(store.getState().status).toBe('reconnect')
    expect(store.getState().reconnecting).toBe(false)
    expect(store.getState().error).toMatch(/different storage location/)
    // The session was never re-pointed: no replication against the new target.
    expect(startWasSyncMock.mock.calls).toHaveLength(syncCalls)
  })

  it('lands connected when the re-grant keeps the same topology', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store } = await connectedStore({ config, seedStore })
    store.getState().notifyAccessExpired()
    const syncCalls = startWasSyncMock.mock.calls.length

    const grants = noteGrants()
    const expires = futureIso(FAR_FUTURE_MS)
    requestGrantsMock.mockResolvedValue({
      parsed: parseGrants(grants),
      grants,
      expires
    })

    await store.getState().reconnect()

    expect(store.getState().status).toBe('connected')
    expect(store.getState().error).toBeNull()
    expect(store.getState().expires).toBe(expires)
    // Replication restarted under the renewed grants.
    expect(startWasSyncMock.mock.calls.length).toBe(syncCalls + 1)
  })
})

describe('near-expiry watch', () => {
  it('raises the banner on a restore already inside the warning window', async () => {
    // Ten minutes left against the default one-hour warning: the restore must
    // land `connected` and then flip to `reconnect` on the deferred first
    // check -- without waiting a full watch interval.
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const { store } = await connectedStore({
      config,
      seedStore: newSeedStore(),
      expires: futureIso(10 * 60 * 1000)
    })

    expect(store.getState().status).toBe('connected')

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(store.getState().status).toBe('reconnect')
  })

  it('leaves a far-future session connected', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const { store } = await connectedStore({
      config,
      seedStore: newSeedStore()
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(store.getState().status).toBe('connected')
  })
})

describe('boot() grant coverage', () => {
  it('lands reconnect when a configured collection is uncovered', async () => {
    // Two configured collections, but the grant set only covers `notes`.
    const config = baseConfig([
      { key: 'notes', id: 'notes' },
      { key: 'tasks', id: 'tasks' }
    ])
    const seedStore = newSeedStore()
    const { store } = await connectedStore({ config, seedStore })

    expect(store.getState().status).toBe('reconnect')
  })

  it('lands connected when every collection is covered', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store } = await connectedStore({ config, seedStore })

    expect(store.getState().status).toBe('connected')
  })
})

describe('destroy()', () => {
  it('tears the session down without wiping the record and allows a re-boot', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store } = await connectedStore({ config, seedStore })
    expect(store.getState().status).toBe('connected')
    expect(hasStore()).toBe(true)

    await store.getState().destroy()

    // Torn down and returned to `boot` (not `local`).
    expect(store.getState().status).toBe('boot')
    expect(hasStore()).toBe(false)
    // The persisted record survives, so a StrictMode remount can re-boot.
    expect(await restoreAppSession({ store: seedStore })).not.toBeNull()

    await store.getState().boot()
    expect(store.getState().status).toBe('connected')
  })
})

describe('reconnect() with the session torn down while the popup is open', () => {
  /**
   * Drives a connected store to `reconnect`, parks the re-grant popup, and
   * hands back the release handle plus the in-flight `reconnect()` promise.
   */
  async function parkedReconnect() {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store } = await connectedStore({ config, seedStore })
    store.getState().notifyAccessExpired()
    expect(store.getState().status).toBe('reconnect')
    const syncStartsBefore = startWasSyncMock.mock.calls.length

    let release!: () => void
    const popup = new Promise<void>(resolve => (release = resolve))
    requestGrantsMock.mockImplementation(async () => {
      await popup
      const grants = noteGrants()
      return {
        grants,
        parsed: parseGrants(grants),
        expires: futureIso(FAR_FUTURE_MS)
      }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const pending = store.getState().reconnect()
    // Let `reconnect` reach the awaited popup.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getState().reconnecting).toBe(true)
    return { store, seedStore, pending, release, syncStartsBefore }
  }

  it('a logout completed meanwhile leaves local with no session record', async () => {
    const { store, seedStore, pending, release, syncStartsBefore } =
      await parkedReconnect()

    await store.getState().logout()
    expect(store.getState().status).toBe('local')
    const anonDid = store.getState().controllerDid

    release()
    await pending

    // The renewed grants were discarded: no record written back, no sync
    // started over the anonymous replica, and the anonymous session intact.
    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toBe(anonDid)
    expect(store.getState().reconnecting).toBe(false)
    expect(store.getState().error).toBeNull()
    expect(await restoreAppSession({ store: seedStore })).toBeNull()
    expect(startWasSyncMock.mock.calls.length).toBe(syncStartsBefore)
    expect(hasStore()).toBe(true)
  })

  it('a clear-data completed meanwhile leaves local with no session record', async () => {
    const { store, seedStore, pending, release, syncStartsBefore } =
      await parkedReconnect()

    await store.getState().clearLocalData()
    expect(store.getState().status).toBe('local')
    const anonDid = store.getState().controllerDid

    release()
    await pending

    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toBe(anonDid)
    expect(store.getState().reconnecting).toBe(false)
    expect(await seedStore.loadSeed()).toBeNull()
    expect(await restoreAppSession({ store: seedStore })).toBeNull()
    expect(startWasSyncMock.mock.calls.length).toBe(syncStartsBefore)
    expect(hasStore()).toBe(true)
  })

  it('a destroy completed meanwhile arms no expiry watch and starts no sync', async () => {
    const { store, pending, release, syncStartsBefore } =
      await parkedReconnect()

    await store.getState().destroy()
    expect(store.getState().status).toBe('boot')
    const intervals = vi.spyOn(globalThis, 'setInterval')

    release()
    await pending

    // The discarded store stays torn down: nothing re-armed the watch, no
    // controller was started, and no replica was re-opened.
    expect(store.getState().status).toBe('boot')
    expect(store.getState().reconnecting).toBe(false)
    expect(intervals).not.toHaveBeenCalled()
    expect(startWasSyncMock.mock.calls.length).toBe(syncStartsBefore)
    expect(hasStore()).toBe(false)
  })
})
