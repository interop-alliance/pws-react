/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the four-state session machine, driving a real seed-derived
 * identity and a real (fake-indexeddb) LocalStore open, with the live
 * replication bootstrap (`startPwsSync`) mocked to an inert no-op. Covers the
 * boot / local / connect / logout / clear-data transitions:
 *
 * - `boot()` with nothing persisted lands `local` (a fresh anonymous seed is
 *   persisted, the replica is opened, the entity stores hydrate empty);
 * - `boot()` with a valid persisted session lands `connected`;
 * - the anonymous seed (and DID) is stable across a second `boot()`;
 * - `connectWithGrants` and a (mocked-wallet) `login()` transition
 *   `local -> connected`, tearing down the anonymous replica but leaving its
 *   seed intact; a cancelled `login()` leaves `local` intact;
 * - `logout({ wipe })` keeps vs deletes the connected replica, landing `local`;
 * - `clearLocalData()` mints a brand-new anonymous seed/DID, empties stores,
 *   and drops any persisted connected session.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { IZcap } from '@interop/data-integrity-core'
import {
  createAuthStore,
  type PwsAuthStore
} from '../../src/session/authStore.js'
import {
  createDescriptorCache,
  createSeedStore,
  type SeedStore
} from '../../src/identity/seedStore.js'
import { PwsServerError, type CollectionEncryption } from '@interop/pws-client'
import { rootCapabilityId } from '@interop/pws-client/paths'
import {
  deriveIdentity,
  type IdentityAgents
} from '../../src/identity/agents.js'
import { persistAppSession } from '../../src/identity/appSession.js'
import { parseGrants } from '../../src/grants.js'
import {
  loginWithWallet,
  LoginCancelledError
} from '../../src/auth/loginFlow.js'
import {
  readRemoteDescriptors,
  startPwsSync
} from '../../src/storage/pwsSync.js'
import { mintRecordEncryption } from '../../src/index.js'
import { hasStore, requireStore } from '../../src/storage/storageManager.js'
import { createEntityStore } from '../../src/storage/entityStore.js'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import type { RxStorage } from 'rxdb/plugins/core'
import {
  LocalStore,
  dbNameForController
} from '../../src/storage/localStore.js'
import type { StoreRegistry, PwsAppConfig } from '../../src/config.js'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../../src/log.js'

const SPACE_URL = 'http://localhost:3999/space/space-1/'

// Inert replication: the machine's activate / persist / teardown logic runs
// without opening any network or `window`-backed replication machinery. The
// login-time descriptor read serves the mocked "server side" of descriptor
// provisioning (see `serveRemoteDescriptors`), so it stays correct for
// whichever identity connects and no test has to re-arm it.
vi.mock('../../src/storage/pwsSync.js', () => ({
  startPwsSync: vi.fn(async () => ({})),
  readRemoteDescriptors: vi.fn(
    async (options: Parameters<typeof serveRemoteDescriptors>[0]) => ({
      descriptors: await serveRemoteDescriptors(options),
      failures: []
    })
  )
}))

// The mocked server's provisioned identities (what the wallet or the dev
// provisioner would have installed collections for), keyed by controller DID.
const provisionedKaks = new Map<string, IdentityAgents['keyAgreementKey']>()

// One epoch-bearing descriptor per (controller, collection), minted on first
// read and memoized like a real server's stored descriptor: a reconnect under
// the same seed must reuse the descriptor its earlier rows were sealed under.
const mintedDescriptors = new Map<string, CollectionEncryption>()

function provisionIdentity(identity: IdentityAgents): void {
  provisionedKaks.set(identity.controllerDid, identity.keyAgreementKey)
}

/**
 * Answers a login-time descriptor read the way a provisioned server would: an
 * epoch-bearing descriptor per private collection, sealed to the connecting
 * identity's KAK (resolved from the invocation signer's controller DID). An
 * unprovisioned identity reads empty, leaving its collections fail-closed.
 */
async function serveRemoteDescriptors({
  zcapClient,
  collections
}: {
  zcapClient: unknown
  collections: { id: string; visibility?: string }[]
}): Promise<Record<string, CollectionEncryption>> {
  const { invocationSigner } = zcapClient as {
    invocationSigner: { id: string }
  }
  const controllerDid = invocationSigner.id.split('#')[0]!
  const keyAgreementKey = provisionedKaks.get(controllerDid)
  if (!keyAgreementKey) {
    return {}
  }
  const descriptors: Record<string, CollectionEncryption> = {}
  for (const { id, visibility } of collections) {
    if (visibility === 'public') {
      continue
    }
    const mintKey = `${controllerDid}:${id}`
    let descriptor = mintedDescriptors.get(mintKey)
    if (!descriptor) {
      descriptor = await mintRecordEncryption({ keyAgreementKey })
      mintedDescriptors.set(mintKey, descriptor)
    }
    descriptors[id] = descriptor
  }
  return descriptors
}

/**
 * Mints a wallet seed whose identity the mocked server has provisioned, so a
 * `connectWithGrants` under it opens epoch-aware.
 */
async function provisionedSeed(): Promise<Uint8Array> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  provisionIdentity(await deriveIdentity({ seed }))
  return seed
}

// Keep the real login flow but make the wallet step controllable per test.
vi.mock('../../src/auth/loginFlow.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/auth/loginFlow.js')>()
  return { ...actual, loginWithWallet: vi.fn() }
})

const loginWithWalletMock = vi.mocked(loginWithWallet)
const startPwsSyncMock = vi.mocked(startPwsSync)
const readRemoteDescriptorsMock = vi.mocked(readRemoteDescriptors)

const registry: StoreRegistry = {}

// Well beyond the default 1h near-expiry warning, so the watch never fires.
const FAR_FUTURE_MS = 4 * 60 * 60 * 1000

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function baseConfig(): PwsAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    collections: [{ key: 'notes', id: 'notes' }],
    appUrl: 'http://localhost:5173/test-app',
    // A unique base name per config so the RxDB / IndexedDB databases never
    // collide across tests sharing the one process-wide fake-indexeddb.
    dbName: `pws-react-${Math.random().toString(36).slice(2)}`
  }
}

function newSeedStore(): SeedStore {
  return createSeedStore({
    dbName: `pws-react-session-${Math.random().toString(36).slice(2)}`,
    idb: new IDBFactory()
  })
}

function noteGrants(): IZcap[] {
  return [
    {
      id: 'urn:zcap:notes',
      parentCapability: rootCapabilityId(SPACE_URL),
      invocationTarget: `${SPACE_URL}notes`
    }
  ] as unknown as IZcap[]
}

/**
 * Wraps a storage (the real Dexie one by default) so the first open of a
 * database `match` accepts parks on a gate. `entered` resolves once an open is
 * parked; `release()` lets it proceed, `fail(err)` makes it throw instead.
 * Every other open passes straight through. The wrapper is built over the
 * base's prototype, so every other storage method stays intact.
 */
function gatedStorage({
  match,
  base = getRxStorageDexie() as unknown as RxStorage<unknown, unknown>
}: {
  match: (databaseName: string) => boolean
  base?: RxStorage<unknown, unknown>
}): {
  storage: RxStorage<unknown, unknown>
  entered: Promise<void>
  release: () => void
  fail: (err: Error) => void
} {
  let hold = true
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => (markEntered = resolve))
  let release!: () => void
  let fail!: (err: Error) => void
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  const createStorageInstance = async (
    params: Parameters<typeof base.createStorageInstance>[0]
  ): ReturnType<typeof base.createStorageInstance> => {
    if (hold && match(params.databaseName)) {
      hold = false
      markEntered()
      await gate
    }
    return base.createStorageInstance(params)
  }
  const storage = Object.assign(Object.create(base) as typeof base, {
    createStorageInstance
  })
  return { storage, entered, release, fail }
}

/**
 * Boots a store over a gated storage and parks the connected replica's open
 * under `seed`, so the anonymous replica is detached and nothing is attached
 * in its place when the gate is entered (the window a mid-swap write lands
 * in). Resolves once the open is parked, with the write-side handles.
 */
async function enterSwap({
  config,
  seed,
  gate,
  storage = gate.storage
}: {
  config: PwsAppConfig
  seed: Uint8Array
  gate: ReturnType<typeof gatedStorage>
  storage?: RxStorage<unknown, unknown>
}): Promise<{
  store: PwsAuthStore
  anonDid: string
  connecting: Promise<void>
}> {
  const store = createAuthStore({
    config,
    registry,
    seedStore: newSeedStore(),
    storage
  })
  liveStores.push(store)
  await store.getState().boot()
  const anonDid = store.getState().controllerDid!
  const connecting = store
    .getState()
    .connectWithGrants({ seed, grants: noteGrants() })
  await gate.entered
  expect(hasStore()).toBe(false)
  return { store, anonDid, connecting }
}

async function connectedDbFor(
  config: PwsAppConfig,
  seed: Uint8Array
): Promise<string> {
  const { controllerDid } = await deriveIdentity({ seed })
  return dbNameForController({ dbName: config.dbName!, controllerDid })
}

// Track created stores so their expiry-watch intervals never outlive a test.
const liveStores: PwsAuthStore[] = []

// Probe replicas opened directly to inspect a torn-down anonymous database.
const probeStores: LocalStore[] = []

function makeStore(config: PwsAppConfig, seedStore: SeedStore): PwsAuthStore {
  const store = createAuthStore({ config, registry, seedStore })
  liveStores.push(store)
  return store
}

/**
 * Opens a fresh handle on the per-controller database `seed`/`controllerDid`
 * back for direct inspection (a probe of a replica the store has torn down).
 * Opening a deleted database RE-CREATES it empty, which is exactly what makes
 * "the anon database was deleted" assertable: reopen and expect zero rows.
 */
async function reopenReplica({
  config,
  seed,
  controllerDid
}: {
  config: PwsAppConfig
  seed: Uint8Array
  controllerDid: string
}): Promise<LocalStore> {
  const { keyAgreementKey, keyResolver } = await deriveIdentity({ seed })
  // Probe with the descriptors the anon replica minted at birth (persisted
  // beside the anon seed), so a surviving replica's rows still decrypt. After
  // a discard the cache is gone too, which is fine: the probe then expects an
  // empty database, and an empty listing runs no decrypts.
  const cache = createDescriptorCache({
    store: createSeedStore({ dbName: `${config.dbName}-anon` }),
    controller: controllerDid
  })
  const descriptors: Record<string, CollectionEncryption> = {}
  for (const { id } of config.collections) {
    const descriptor = await cache.readDescriptor({ collectionId: id })
    if (descriptor) {
      descriptors[id] = descriptor
    }
  }
  const store = await LocalStore.init({
    keyAgreementKey,
    keyResolver,
    collections: config.collections,
    dbName: dbNameForController({ dbName: config.dbName!, controllerDid }),
    descriptors
  })
  probeStores.push(store)
  return store
}

afterEach(async () => {
  while (probeStores.length > 0) {
    await probeStores.pop()!.remove()
  }
  while (liveStores.length > 0) {
    await liveStores.pop()!.getState().destroy()
  }
  vi.restoreAllMocks()
})

/**
 * Persists a valid, matching session record for `seedStore` so a `boot()`
 * restores it. Returns the seed + identity that back it.
 */
async function persistSession({
  seedStore,
  grants = noteGrants(),
  expires = futureIso(FAR_FUTURE_MS)
}: {
  seedStore: SeedStore
  grants?: IZcap[]
  expires?: string
}): Promise<{ seed: Uint8Array; controllerDid: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const identity = await deriveIdentity({ seed })
  provisionIdentity(identity)
  await persistAppSession({
    session: {
      seed,
      controllerDid: identity.controllerDid,
      spaceUrl: SPACE_URL,
      grants,
      expires
    },
    store: seedStore
  })
  return { seed, controllerDid: identity.controllerDid }
}

describe('boot()', () => {
  it('falls to local with a fresh anonymous replica when nothing is persisted', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())

    await store.getState().boot()

    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toMatch(/^did:key:/)
    expect(store.getState().expires).toBeNull()
    // The replica is open and the entity stores hydrated empty.
    expect(hasStore()).toBe(true)
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
    // The anonymous seed was minted and persisted in `<dbName>-anon`.
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    expect(await anon.loadSeed()).not.toBeNull()
  })

  it('is a no-op once the status has left boot', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    expect(store.getState().status).toBe('local')
    const did = store.getState().controllerDid
    await store.getState().boot()
    // No re-open, same identity.
    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toBe(did)
  })

  it('lands connected from a valid persisted session', async () => {
    const seedStore = newSeedStore()
    const { controllerDid } = await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)

    await store.getState().boot()

    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(controllerDid)
    expect(hasStore()).toBe(true)
  })

  it('still lands connected when a descriptor read fails during the restore', async () => {
    const capture = captureLogger('pr')
    const previous = setLogger(capture.logger)
    const seedStore = newSeedStore()
    const { controllerDid } = await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)
    // No cached descriptor yet, and the live read fails (a reload while
    // offline, or a 5xx). A restore adopts nothing, so the collection opens
    // fail-closed for the sync bootstrap to repair, rather than dropping a
    // connected user into `local`.
    readRemoteDescriptorsMock.mockResolvedValueOnce({
      descriptors: {},
      failures: [
        {
          collection: { key: 'notes', id: 'notes' },
          err: new Error(
            'Failed to read the encryption descriptor of collection "notes".'
          )
        }
      ]
    })

    await store.getState().boot()

    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(controllerDid)
    expect(store.getState().error).toBeNull()
    expect(
      capture.events.some(
        event =>
          event.level === 'warn' &&
          event.data?.collectionId === 'notes' &&
          event.err instanceof Error
      )
    ).toBe(true)
    setLogger(previous)
  })

  it('reuses the persisted anonymous seed/DID across a second boot', async () => {
    const config = baseConfig()
    const first = makeStore(config, newSeedStore())
    await first.getState().boot()
    const firstDid = first.getState().controllerDid
    // Tear the first replica down (the anon seed survives a destroy).
    await first.getState().destroy()

    const second = makeStore(config, newSeedStore())
    await second.getState().boot()

    expect(second.getState().status).toBe('local')
    expect(second.getState().controllerDid).toBe(firstDid)
  })
})

describe('connectWithGrants()', () => {
  it('a write issued during the replica swap waits and lands in the connected replica', async () => {
    const config = baseConfig()
    const seed = await provisionedSeed()
    const connectedDb = await connectedDbFor(config, seed)
    const gate = gatedStorage({ match: name => name === connectedDb })
    const { store, connecting } = await enterSwap({ config, seed, gate })
    const notes = createEntityStore<{ id: string; title: string }>('notes')

    // The write cannot settle before the swap closes, and the swap closes
    // (synchronously followed by the `connected` write) only once the parked
    // open is released: the status the write's continuation observes is the
    // proof of its ordering.
    const doc = { id: crypto.randomUUID(), title: 'mid-swap' }
    const writing = notes
      .getState()
      .insert(doc)
      .then(() => store.getState().status)

    gate.release()
    await connecting
    expect(await writing).toBe('connected')
    const { controllerDid } = await deriveIdentity({ seed })
    expect(store.getState().controllerDid).toBe(controllerDid)
    const rows = await requireStore().listEntities<{ id: string }>('notes')
    expect(rows.map(row => row.id)).toContain(doc.id)
    expect(notes.getState().byId.has(doc.id)).toBe(true)
  })

  it('a write issued during a failed activation lands in the re-opened anonymous replica', async () => {
    const config = baseConfig()
    const seed = await provisionedSeed()
    const connectedDb = await connectedDbFor(config, seed)
    const gate = gatedStorage({ match: name => name === connectedDb })
    const { store, anonDid, connecting } = await enterSwap({
      config,
      seed,
      gate
    })
    const notes = createEntityStore<{ id: string; title: string }>('notes')
    const doc = { id: crypto.randomUUID(), title: 'mid-swap' }
    const writing = notes
      .getState()
      .insert(doc)
      .then(() => store.getState().status)

    gate.fail(new Error('connected open boom'))
    await expect(connecting).rejects.toThrow('connected open boom')
    expect(await writing).toBe('local')
    expect(store.getState().controllerDid).toBe(anonDid)
    expect(store.getState().error).toMatch(/connected open boom/)
    const rows = await requireStore().listEntities<{ id: string }>('notes')
    expect(rows.map(row => row.id)).toContain(doc.id)
  })

  it('a write issued during a swap that leaves no replica rejects, and the pointer is released', async () => {
    const config = baseConfig()
    const seed = await provisionedSeed()
    const connectedDb = await connectedDbFor(config, seed)
    // The anonymous database's name is only known after boot; the second
    // gate matches it once set, so the boot-time open passes through and the
    // fallback re-open is the one that fails.
    let anonDb: string | null = null
    const connectedGate = gatedStorage({ match: name => name === connectedDb })
    const anonGate = gatedStorage({
      match: name => name === anonDb,
      base: connectedGate.storage
    })
    const { store, anonDid, connecting } = await enterSwap({
      config,
      seed,
      gate: connectedGate,
      storage: anonGate.storage
    })
    anonDb = dbNameForController({
      dbName: config.dbName!,
      controllerDid: anonDid
    })
    const notes = createEntityStore<{ id: string; title: string }>('notes')
    // Both rejections are observed later; keep them handled meanwhile.
    const connected = connecting.catch((err: Error) => err)
    const written = notes
      .getState()
      .insert({ id: crypto.randomUUID(), title: 'mid-swap' })
      .catch((err: Error) => err)

    connectedGate.fail(new Error('connected open boom'))
    await anonGate.entered
    anonGate.fail(new Error('anon re-open boom'))
    expect(await connected).toMatchObject({ message: 'connected open boom' })
    expect(await written).toMatchObject({
      message: expect.stringMatching(/LocalStore is not initialized/)
    })
    expect(hasStore()).toBe(false)
    expect(() => requireStore()).toThrow()
    expect(store.getState().error).toMatch(/connected open boom/)
    // `destroy` must not trip over the store the swap never attached.
    anonGate.release()
  })

  it("under adopt: 'leave' a mid-transition write rejects instead of following the set-aside data", async () => {
    const config = baseConfig()
    const seed = await provisionedSeed()
    const connectedDb = await connectedDbFor(config, seed)
    const gate = gatedStorage({ match: name => name === connectedDb })
    const store = createAuthStore({
      config,
      registry,
      seedStore: newSeedStore(),
      storage: gate.storage
    })
    liveStores.push(store)
    await store.getState().boot()
    const notes = createEntityStore<{ id: string; title: string }>('notes')
    const kept = { id: crypto.randomUUID(), title: 'set aside' }
    await notes.getState().insert(kept)

    const connecting = store
      .getState()
      .connectWithGrants({ seed, grants: noteGrants(), adopt: 'leave' })
    await gate.entered
    // No swap is open, so the write meets the bare no-replica error (the
    // activation has re-claimed the pointer ahead of its parked open).
    await expect(
      notes.getState().update({ ...kept, title: 'edited mid-swap' })
    ).rejects.toThrow(/LocalStore is not initialized/)

    gate.release()
    await connecting
    expect(store.getState().status).toBe('connected')
    const rows = await requireStore().listEntities<{ id: string }>('notes')
    expect(rows.map(row => row.id)).not.toContain(kept.id)
  })

  it('a login from reconnect opens no swap, so a write queued against the expired account rejects', async () => {
    const config = baseConfig()
    const seedA = await provisionedSeed()
    const seedB = await provisionedSeed()
    const connectedDbB = await connectedDbFor(config, seedB)
    // Account A connects through the ungated boot-time path; the gate parks
    // account B's open, the window a write queued mid-login would land in.
    const gate = gatedStorage({ match: name => name === connectedDbB })
    const store = createAuthStore({
      config,
      registry,
      seedStore: newSeedStore(),
      storage: gate.storage
    })
    liveStores.push(store)
    await store.getState().boot()
    await store
      .getState()
      .connectWithGrants({ seed: seedA, grants: noteGrants() })
    expect(store.getState().status).toBe('connected')
    const notes = createEntityStore<{ id: string; title: string }>('notes')
    const kept = { id: crypto.randomUUID(), title: 'account A' }
    await notes.getState().insert(kept)

    store.getState().notifyAccessExpired()
    expect(store.getState().status).toBe('reconnect')

    const identityB = await deriveIdentity({ seed: seedB })
    const grants = noteGrants()
    loginWithWalletMock.mockResolvedValue({
      seed: seedB,
      identity: identityB,
      grants,
      parsed: parseGrants(grants),
      expires: futureIso(FAR_FUTURE_MS),
      firstRun: false
    })
    const loggingIn = store.getState().login()
    await gate.entered
    expect(hasStore()).toBe(false)
    // Nothing is collected from `reconnect`, so no swap is open: the write
    // meets the bare no-replica error rather than following account A's
    // document into account B's replica as a create.
    await expect(
      notes.getState().update({ ...kept, title: 'edited mid-login' })
    ).rejects.toThrow(/LocalStore is not initialized/)

    gate.release()
    expect(await loggingIn).toEqual({ firstRun: false })
    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(identityB.controllerDid)
    const rows = await requireStore().listEntities<{ id: string }>('notes')
    expect(rows.map(row => row.id)).not.toContain(kept.id)
  })

  it('transitions local to connected under the given seed', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    expect(store.getState().status).toBe('local')

    const seed = crypto.getRandomValues(new Uint8Array(32))
    const identity = await deriveIdentity({ seed })
    provisionIdentity(identity)
    await store.getState().connectWithGrants({ seed, grants: noteGrants() })

    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(identity.controllerDid)
    expect(hasStore()).toBe(true)
  })
})

describe('login()', () => {
  it('transitions local to connected and leaves the anon seed intact', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    expect(anonSeed).not.toBeNull()

    // The wallet returns a fresh identity + grants (distinct from the anon one).
    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    const identity = await deriveIdentity({ seed: walletSeed })
    provisionIdentity(identity)
    const grants = noteGrants()
    loginWithWalletMock.mockResolvedValue({
      seed: walletSeed,
      identity,
      grants,
      parsed: parseGrants(grants),
      expires: futureIso(FAR_FUTURE_MS),
      firstRun: false
    })

    const outcome = await store.getState().login()

    expect(outcome).toEqual({ firstRun: false })
    expect(store.getState().status).toBe('connected')
    expect(store.getState().phase).toBeNull()
    expect(store.getState().controllerDid).toBe(identity.controllerDid)
    // Nothing to adopt (the local replica is empty), so the anon seed survives.
    expect(await anon.loadSeed()).toEqual(anonSeed)
  })

  it('lands connected with no replication when the wallet returned no grants', async () => {
    // A shared-only app whose user declined every share: `collections` is
    // empty, the wallet answered with no grants, and the checked grant set
    // names no server and no Space.
    const config = { ...baseConfig(), collections: [] }
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    const identity = await deriveIdentity({ seed: walletSeed })
    loginWithWalletMock.mockResolvedValue({
      seed: walletSeed,
      identity,
      grants: [],
      expires: futureIso(FAR_FUTURE_MS),
      firstRun: true
    })
    startPwsSyncMock.mockClear()

    const outcome = await store.getState().login()

    expect(outcome).toEqual({ firstRun: true })
    expect(store.getState().status).toBe('connected')
    expect(store.getState().error).toBeNull()
    expect(store.getState().controllerDid).toBe(identity.controllerDid)
    expect(startPwsSyncMock).not.toHaveBeenCalled()
  })

  it('leaves local intact when the wallet login is cancelled', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    const localDid = store.getState().controllerDid

    loginWithWalletMock.mockRejectedValue(
      new LoginCancelledError('wallet login')
    )

    // A cancel resolves with `null` (not a failure) and leaves no scary error.
    const outcome = await store.getState().login()

    expect(outcome).toBeNull()
    expect(store.getState().status).toBe('local')
    expect(store.getState().phase).toBeNull()
    expect(store.getState().controllerDid).toBe(localDid)
    expect(store.getState().error).toBeNull()
    // The anonymous replica was never torn down.
    expect(hasStore()).toBe(true)
  })

  it('rejects and records the error when the wallet login fails', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    const localDid = store.getState().controllerDid

    loginWithWalletMock.mockRejectedValue(
      new Error('grants verification failed')
    )

    await expect(store.getState().login()).rejects.toThrow(
      /grants verification failed/
    )

    expect(store.getState().status).toBe('local')
    expect(store.getState().phase).toBeNull()
    expect(store.getState().controllerDid).toBe(localDid)
    expect(store.getState().error).toMatch(/Login failed/i)
    // The anonymous replica was never torn down.
    expect(hasStore()).toBe(true)
  })
})

describe('logout()', () => {
  it('keeps the connected replica by default and lands local', async () => {
    const seedStore = newSeedStore()
    await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)
    await store.getState().boot()
    expect(store.getState().status).toBe('connected')

    const removeSpy = vi.spyOn(requireStore(), 'remove')
    await store.getState().logout()

    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toMatch(/^did:key:/)
    expect(store.getState().expires).toBeNull()
    // The session record was cleared.
    expect(await seedStore.loadSeed()).toBeNull()
    // Keep path: the connected replica was closed, not removed.
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('removes the connected replica when wipe is true', async () => {
    const seedStore = newSeedStore()
    await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)
    await store.getState().boot()
    expect(store.getState().status).toBe('connected')

    const removeSpy = vi.spyOn(requireStore(), 'remove')
    await store.getState().logout({ wipe: true })

    expect(store.getState().status).toBe('local')
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(await seedStore.loadSeed()).toBeNull()
  })

  it('clears the session record and lands local with an error when the anonymous replica cannot re-open', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = baseConfig()
    const seedStore = newSeedStore()
    const { seed } = await persistSession({ seedStore })
    const connectedDb = await connectedDbFor(config, seed)
    // The hot restore opens the connected replica alone, so the first open
    // of any other database is the logout's anonymous re-open.
    const gate = gatedStorage({ match: name => name !== connectedDb })
    const store = createAuthStore({
      config,
      registry,
      seedStore,
      storage: gate.storage
    })
    liveStores.push(store)
    await store.getState().boot()
    expect(store.getState().status).toBe('connected')

    const loggingOut = store.getState().logout()
    await gate.entered
    gate.fail(new Error('anon re-open boom'))
    await loggingOut

    // The record went before the re-open was attempted, so a reload cannot
    // hot-restore the session the user just logged out of.
    expect(await seedStore.loadSeed()).toBeNull()
    // No replica is attached, and the status says so rather than naming the
    // torn-down connected session.
    expect(hasStore()).toBe(false)
    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toBeNull()
    expect(store.getState().expires).toBeNull()
    expect(store.getState().error).toMatch(/anon re-open boom/)
  })
})

/**
 * Arms the wallet mock to succeed with a fresh identity + grants (distinct from
 * the anonymous one), returning the connected controller DID it will land on.
 */
async function mockWalletLogin(): Promise<{ controllerDid: string }> {
  const walletSeed = crypto.getRandomValues(new Uint8Array(32))
  const identity = await deriveIdentity({ seed: walletSeed })
  const grants = noteGrants()
  loginWithWalletMock.mockResolvedValue({
    seed: walletSeed,
    identity,
    grants,
    parsed: parseGrants(grants),
    expires: futureIso(FAR_FUTURE_MS),
    firstRun: false
  })
  // The wallet's provisioning would have installed the collections
  // server-side; the descriptor-read mock serves them from this registration.
  provisionIdentity(identity)
  return { controllerDid: identity.controllerDid }
}

describe('adoption', () => {
  it('merges anonymous docs into the connected replica and deletes the anon replica', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    const anonDid = store.getState().controllerDid!
    // Two docs, deliberately WITHOUT LWW fields, so adoption must stamp them.
    const first = { id: crypto.randomUUID(), title: 'first' }
    const second = { id: crypto.randomUUID(), title: 'second' }
    await requireStore().insertEntity('notes', first)
    await requireStore().insertEntity('notes', second)

    await mockWalletLogin()
    await store.getState().login()

    expect(store.getState().status).toBe('connected')
    // The connected replica now carries the adopted docs, each stamped with
    // non-empty LWW fields at adoption time.
    const adopted = await requireStore().listEntities<{
      id: string
      title: string
      updatedAt: string
      writerId: string
    }>('notes')
    expect(adopted.map(doc => doc.title).sort()).toEqual(['first', 'second'])
    for (const doc of adopted) {
      expect(typeof doc.updatedAt).toBe('string')
      expect(doc.updatedAt.length).toBeGreaterThan(0)
      expect(typeof doc.writerId).toBe('string')
      expect(doc.writerId.length).toBeGreaterThan(0)
    }
    // The anon seed is gone and its database was deleted (a reopen is empty).
    expect(await anon.loadSeed()).toBeNull()
    const reopened = await reopenReplica({
      config,
      seed: anonSeed!,
      controllerDid: anonDid
    })
    expect(await reopened.listEntities('notes')).toHaveLength(0)
  })

  it('a transient descriptor-read failure fails the login and leaves local intact', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anonDid = store.getState().controllerDid!
    const note = { id: crypto.randomUUID(), title: 'survives' }
    await requireStore().insertEntity('notes', note)

    // The description GET answers 502, which must never be read as "no
    // descriptor": the connected replica would open under the placeholder
    // cipher and the adoption merge would fail on a correctly provisioned
    // collection.
    const badGateway = new PwsServerError('Bad Gateway', { status: 502 })
    readRemoteDescriptorsMock.mockResolvedValueOnce({
      descriptors: {},
      failures: [
        {
          collection: { key: 'notes', id: 'notes' },
          err: new Error(
            'Failed to read the encryption descriptor of collection "notes".',
            { cause: badGateway }
          )
        }
      ]
    })
    await mockWalletLogin()
    await expect(store.getState().login()).rejects.toThrow(
      /encryption descriptor of collection "notes"/
    )

    // Back on the anonymous replica, with nothing adopted and nothing lost:
    // the read fails ahead of the swap, so the replica was never detached.
    expect(store.getState().status).toBe('local')
    expect(hasStore()).toBe(true)
    expect(store.getState().controllerDid).toBe(anonDid)
    expect(store.getState().error).toMatch(/encryption descriptor/)
    expect(
      await requireStore().listEntities<{ id: string; title: string }>('notes')
    ).toEqual([expect.objectContaining({ title: 'survives' })])

    // A retry once the server answers lands connected and adopts the doc.
    await mockWalletLogin()
    await store.getState().login()
    expect(store.getState().status).toBe('connected')
    expect(
      (
        await requireStore().listEntities<{ id: string; title: string }>(
          'notes'
        )
      ).map(doc => doc.title)
    ).toEqual(['survives'])
  })

  it('leaves the anon replica intact under adopt "leave"', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    const anonDid = store.getState().controllerDid!
    const note = { id: crypto.randomUUID(), title: 'kept-local' }
    await requireStore().insertEntity('notes', note)

    await mockWalletLogin()
    await store.getState().login({ adopt: 'leave' })

    expect(store.getState().status).toBe('connected')
    // The connected replica never saw the local doc.
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
    // The anon seed survives, and its database still holds the original doc.
    expect(await anon.loadSeed()).toEqual(anonSeed)
    const reopened = await reopenReplica({
      config,
      seed: anonSeed!,
      controllerDid: anonDid
    })
    const kept = await reopened.listEntities<{ id: string; title: string }>(
      'notes'
    )
    expect(kept).toHaveLength(1)
    expect(kept[0]!.title).toBe('kept-local')
  })

  it('leaves the anon seed intact when the local replica is empty', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    expect(anonSeed).not.toBeNull()

    await mockWalletLogin()
    await store.getState().login()

    expect(store.getState().status).toBe('connected')
    // No wipe: nothing to adopt means the anon seed is left untouched.
    expect(await anon.loadSeed()).toEqual(anonSeed)
  })

  it('lets an adopted doc win an id collision by newer updatedAt', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()

    const walletSeed = await provisionedSeed()
    const grants = noteGrants()
    // First connect (anon replica empty): opens the connected replica.
    await store.getState().connectWithGrants({ seed: walletSeed, grants })
    const uuid = crypto.randomUUID()
    await requireStore().insertEntity('notes', {
      id: uuid,
      title: 'connected-older',
      updatedAt: '2026-01-01T00:00:00.000Z',
      writerId: 'device-a'
    })

    // Back to local (the connected replica is kept on the device), then write a
    // NEWER version of the same uuid into the anon replica.
    await store.getState().logout()
    expect(store.getState().status).toBe('local')
    await requireStore().insertEntity('notes', {
      id: uuid,
      title: 'anon-newer',
      updatedAt: '2026-02-02T00:00:00.000Z',
      writerId: 'device-a'
    })

    // Reconnect under the same seed (same per-controller database): adoption
    // LWW-merges the newer anon doc over the older connected one.
    await store.getState().connectWithGrants({ seed: walletSeed, grants })
    const merged = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(merged).toHaveLength(1)
    expect(merged[0]!.title).toBe('anon-newer')
  })

  it('keeps the existing doc on an id collision when it wins updatedAt', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()

    const walletSeed = await provisionedSeed()
    const grants = noteGrants()
    await store.getState().connectWithGrants({ seed: walletSeed, grants })
    const uuid = crypto.randomUUID()
    await requireStore().insertEntity('notes', {
      id: uuid,
      title: 'connected-newer',
      updatedAt: '2026-02-02T00:00:00.000Z',
      writerId: 'device-a'
    })

    await store.getState().logout()
    await requireStore().insertEntity('notes', {
      id: uuid,
      title: 'anon-older',
      updatedAt: '2026-01-01T00:00:00.000Z',
      writerId: 'device-a'
    })

    await store.getState().connectWithGrants({ seed: walletSeed, grants })
    const merged = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(merged).toHaveLength(1)
    expect(merged[0]!.title).toBe('connected-newer')
  })

  it('connectWithGrants adopts by default and clears the anon seed', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    await requireStore().insertEntity('notes', {
      id: crypto.randomUUID(),
      title: 'adopt-me'
    })

    const seed = await provisionedSeed()
    await store.getState().connectWithGrants({ seed, grants: noteGrants() })

    expect(store.getState().status).toBe('connected')
    const adopted = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(adopted).toHaveLength(1)
    expect(adopted[0]!.title).toBe('adopt-me')
    expect(await anon.loadSeed()).toBeNull()
  })

  it('connectWithGrants under adopt "leave" keeps the anon replica', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    await requireStore().insertEntity('notes', {
      id: crypto.randomUUID(),
      title: 'stay-local'
    })

    const seed = await provisionedSeed()
    await store
      .getState()
      .connectWithGrants({ seed, grants: noteGrants(), adopt: 'leave' })

    expect(store.getState().status).toBe('connected')
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
    expect(await anon.loadSeed()).toEqual(anonSeed)
  })

  it('stays connected and keeps the anon seed when the adopted replica cannot be deleted', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    const anonDid = store.getState().controllerDid!
    await requireStore().insertEntity('notes', {
      id: crypto.randomUUID(),
      title: 'adopt-me'
    })

    // The post-activation cleanup fails (an anonymous database still open in
    // another tab, an IndexedDB quota error). Best-effort: the login must still
    // report the live, connected session.
    const capture = captureLogger('pr')
    const previous = setLogger(capture.logger)
    vi.spyOn(LocalStore, 'removeDatabase').mockRejectedValue(
      new Error('database is locked')
    )

    await mockWalletLogin()
    const outcome = await store.getState().login()

    expect(outcome).toEqual({ firstRun: false })
    expect(store.getState().status).toBe('connected')
    expect(store.getState().error).toBeNull()
    // The data still made it into the connected replica.
    const adopted = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(adopted.map(doc => doc.title)).toEqual(['adopt-me'])
    expect(
      capture.events.some(
        event =>
          event.level === 'warn' &&
          event.msg.includes(
            'The adopted anonymous replica was not fully removed'
          )
      )
    ).toBe(true)
    setLogger(previous)
    // The seed is cleared LAST, and not at all after a failed removal, so the
    // database it names stays reachable: the next local replica re-opens
    // under the same identity instead of orphaning the old one.
    expect(await anon.loadSeed()).toEqual(anonSeed)
    await store.getState().logout()
    expect(store.getState().controllerDid).toBe(anonDid)
  })

  /**
   * Boots a store with one pre-login note, parks the wallet popup, and lets
   * `login` reach the await, so the test can run a lifecycle verb underneath
   * the open popup. `release()` lets the wallet answer.
   */
  async function parkLogin(
    config: PwsAppConfig,
    seedStore: SeedStore = newSeedStore()
  ): Promise<{
    store: PwsAuthStore
    anonDid: string
    identity: IdentityAgents
    pending: Promise<{ firstRun: boolean } | null>
    release: () => void
  }> {
    const store = makeStore(config, seedStore)
    await store.getState().boot()
    const anonDid = store.getState().controllerDid!
    await requireStore().insertEntity('notes', {
      id: crypto.randomUUID(),
      title: 'pre-login'
    })
    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    const identity = await deriveIdentity({ seed: walletSeed })
    provisionIdentity(identity)
    const grants = noteGrants()
    let release!: () => void
    const popup = new Promise<void>(resolve => (release = resolve))
    loginWithWalletMock.mockImplementation(async () => {
      await popup
      return {
        seed: walletSeed,
        identity,
        grants,
        parsed: parseGrants(grants),
        expires: futureIso(FAR_FUTURE_MS),
        firstRun: false
      }
    })
    const pending = store.getState().login()
    // Let `login` reach the awaited popup.
    await new Promise(resolve => setTimeout(resolve, 0))
    return { store, anonDid, identity, pending, release }
  }

  /**
   * The IndexedDB databases that belong to `controllerDid`'s replica. RxDB's
   * Dexie storage names each collection's database after the replica's, so a
   * substring match is what proves no replica was opened under that DID.
   */
  async function replicaDbNames(
    config: PwsAppConfig,
    controllerDid: string
  ): Promise<string[]> {
    const dbName = dbNameForController({
      dbName: config.dbName!,
      controllerDid
    })
    const names = (await indexedDB.databases()).map(db => db.name ?? '')
    return names.filter(name => name.includes(dbName))
  }

  it('collects the pre-login data even when a StrictMode destroy/boot pair lands mid-login', async () => {
    const config = baseConfig()
    const { store, identity, pending, release } = await parkLogin(config)

    // The provider's StrictMode shape underneath the open popup: destroy
    // (cleanup) then boot (re-mount), which re-opens the same anonymous
    // replica. The adoption collect must decide off the PRE-LOGIN snapshot,
    // not the live status the pair left behind.
    const destroying = store.getState().destroy()
    const rebooting = store.getState().boot()
    await Promise.all([destroying, rebooting])
    expect(store.getState().status).toBe('local')

    release()
    const outcome = await pending

    expect(outcome).toEqual({ firstRun: false })
    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(identity.controllerDid)
    // The pre-login local data reached the connected replica.
    const adopted = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(adopted.map(doc => doc.title)).toEqual(['pre-login'])
  })

  it('abandons the login when a destroy with no boot behind it lands mid-login', async () => {
    const config = baseConfig()
    const seedStore = newSeedStore()
    const { store, anonDid, identity, pending, release } = await parkLogin(
      config,
      seedStore
    )
    const capture = captureLogger('pr')
    const previous = setLogger(capture.logger)

    // A real unmount: destroy, and nothing re-mounts. The provider is gone.
    await store.getState().destroy()
    expect(store.getState().status).toBe('boot')

    release()
    let outcome: { firstRun: boolean } | null
    try {
      outcome = await pending
    } finally {
      setLogger(previous)
    }

    // Nothing was brought up: no pointer claimed, no connected replica, and
    // the session stays torn down rather than reporting `connected` into the
    // void.
    expect(outcome).toBeNull()
    expect(store.getState().status).toBe('boot')
    expect(store.getState().controllerDid).toBeNull()
    expect(store.getState().phase).toBeNull()
    expect(hasStore()).toBe(false)
    expect(
      capture.events.some(
        event => event.level === 'warn' && event.msg.includes('Login abandoned')
      )
    ).toBe(true)
    expect(await replicaDbNames(config, identity.controllerDid)).toEqual([])
    // The anonymous replica is untouched: a provider mounted later boots
    // cleanly over it, with the pre-login data still there.
    const next = makeStore(config, seedStore)
    await next.getState().boot()
    expect(next.getState().status).toBe('local')
    expect(next.getState().controllerDid).toBe(anonDid)
    const kept = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(kept.map(doc => doc.title)).toEqual(['pre-login'])
  })

  it('abandons the login when a clearLocalData lands mid-login', async () => {
    const config = baseConfig()
    const { store, anonDid, identity, pending, release } =
      await parkLogin(config)

    // The user clears everything while the popup is open: a new anonymous
    // seed and replica replace the one the pre-login snapshot named.
    await store.getState().clearLocalData()
    expect(store.getState().status).toBe('local')
    const freshDid = store.getState().controllerDid!
    expect(freshDid).not.toBe(anonDid)

    release()
    const outcome = await pending

    // The fresh anonymous session stands: nothing connected, nothing adopted,
    // no database opened under the old name with the new keys.
    expect(outcome).toBeNull()
    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toBe(freshDid)
    expect(store.getState().phase).toBeNull()
    const kept = await requireStore().listEntities<{ id: string }>('notes')
    expect(kept).toEqual([])
    expect(await replicaDbNames(config, anonDid)).toEqual([])
    expect(await replicaDbNames(config, identity.controllerDid)).toEqual([])
    await store.getState().destroy()
  })

  it('abandons the login when a connectWithGrants lands mid-login', async () => {
    const config = baseConfig()
    const { store, identity, pending, release } = await parkLogin(config)

    // A dev harness connects under another seed while the popup is open (the
    // destroy clears `phase`, so the connect is not blocked). That session
    // must stand.
    await store.getState().destroy()
    const otherSeed = crypto.getRandomValues(new Uint8Array(32))
    const other = await deriveIdentity({ seed: otherSeed })
    provisionIdentity(other)
    await store
      .getState()
      .connectWithGrants({ seed: otherSeed, grants: noteGrants() })
    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(other.controllerDid)

    release()
    const outcome = await pending

    expect(outcome).toBeNull()
    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(other.controllerDid)
    expect(store.getState().phase).toBeNull()
    expect(hasStore()).toBe(true)
    expect(await replicaDbNames(config, identity.controllerDid)).toEqual([])
    await store.getState().destroy()
  })
})

describe('sync bootstrap failure', () => {
  it('surfaces the failure on the session while staying connected', async () => {
    const seedStore = newSeedStore()
    await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    startPwsSyncMock.mockRejectedValueOnce(new Error('bootstrap boom'))

    await store.getState().boot()

    // The session is live and local-first usable; the failure lands a
    // macrotask later, after the caller's own `error: null` write.
    expect(store.getState().status).toBe('connected')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(store.getState().status).toBe('connected')
    expect(store.getState().error).toMatch(/Sync failed to start/)
    expect(store.getState().error).toMatch(/bootstrap boom/)
  })
})

describe('hasLocalData()', () => {
  it('is false on a fresh empty local, true after a write, false once connected', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    expect(store.getState().status).toBe('local')
    expect(await store.getState().hasLocalData()).toBe(false)

    await requireStore().insertEntity('notes', { id: crypto.randomUUID() })
    expect(await store.getState().hasLocalData()).toBe(true)

    const seed = await provisionedSeed()
    await store
      .getState()
      .connectWithGrants({ seed, grants: noteGrants(), adopt: 'leave' })
    expect(store.getState().status).toBe('connected')
    expect(await store.getState().hasLocalData()).toBe(false)
  })
})

describe('clearLocalData()', () => {
  it('mints a fresh anonymous seed/DID and empties the stores', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const firstDid = store.getState().controllerDid
    // Write a row so we can prove the replica is emptied.
    await requireStore().insertEntity('notes', { id: crypto.randomUUID() })
    expect(await requireStore().listEntities('notes')).toHaveLength(1)

    await store.getState().clearLocalData()

    expect(store.getState().status).toBe('local')
    // A brand-new anonymous DID (the old seed was discarded before re-open).
    expect(store.getState().controllerDid).not.toBe(firstDid)
    expect(store.getState().controllerDid).toMatch(/^did:key:/)
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
  })

  it('clears the persisted session when run while connected', async () => {
    const seedStore = newSeedStore()
    await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)
    await store.getState().boot()
    expect(store.getState().status).toBe('connected')

    await store.getState().clearLocalData()

    expect(store.getState().status).toBe('local')
    // The session record was cleared, so a later boot cannot reconnect.
    expect(await seedStore.loadSeed()).toBeNull()
  })
})
