/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Regression tests for the serialized boot/destroy lifecycle. A fast
 * unmount/remount of the session provider (React dev-mode double effects) fires
 * `boot` -> `destroy` -> `boot` while the first boot is still opening the
 * replica. Before serialization, the first boot's continuations (open, hydrate,
 * start sync) raced the destroy's teardown: an aborted boot could resurrect a
 * torn-down session, attach a closed/duplicate replica to the storage context,
 * or hydrate against a store that was being torn down.
 *
 * These tests drive that interleaving deterministically with an INJECTED
 * storage whose first RxDB open is deferrable: parking a boot inside
 * `LocalStore.init` (before it attaches the replica to the storage context)
 * lets a `destroy` -- and then a second `boot` -- run at a precisely controlled
 * point, exactly the window the provider's mount/cleanup/mount effect opens.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { dbCount, type RxStorage } from 'rxdb/plugins/core'
import type { IZcap } from '@interop/data-integrity-core'
import {
  createAuthStore,
  type WasAuthStore
} from '../../src/session/authStore.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import {
  persistAppSession,
  peekAppSession
} from '../../src/identity/appSession.js'
import {
  createSeedStore,
  type SeedStore
} from '../../src/identity/seedStore.js'
import {
  hasStorageContext,
  hasStore,
  requireStorageContext,
  requireStore,
  stampLww
} from '../../src/storage/storageManager.js'
import {
  dbNameForController,
  LocalStore
} from '../../src/storage/localStore.js'
import type { StoreRegistry, WasAppConfig } from '../../src/config.js'

const SPACE_URL = 'http://localhost:3999/space/space-1/'
import { rootCapabilityId } from '@interop/was-client/paths'

// Inert replication: the lifecycle logic runs without any network machinery.
vi.mock('../../src/storage/wasSync.js', () => ({
  startWasSync: vi.fn(async () => ({})),
  // The login-time descriptor read answers "no descriptor" (an unprovisioned
  // server); a read that FAILED would fail the activation instead.
  readRemoteDescriptors: vi.fn(async () => ({ descriptors: {}, failures: [] }))
}))

const registry: StoreRegistry = {}

function baseConfig(): WasAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    collections: [{ key: 'notes', id: 'notes' }],
    appUrl: 'http://localhost:5173/test-app',
    // A unique base name per config so the RxDB databases never collide across
    // tests sharing the one process-wide fake-indexeddb.
    dbName: `was-react-${Math.random().toString(36).slice(2)}`
  }
}

function newSeedStore(): SeedStore {
  return createSeedStore({
    dbName: `was-react-session-${Math.random().toString(36).slice(2)}`,
    idb: new IDBFactory()
  })
}

/**
 * Wraps the real Dexie storage so the FIRST `createStorageInstance` call (the
 * first boot's `LocalStore.init`, before it attaches the replica to the
 * storage context) parks on a release gate. `entered` resolves once the boot
 * is parked; `release()` lets it proceed. Every later open passes straight
 * through.
 */
function gatedStorage(): {
  storage: RxStorage<unknown, unknown>
  entered: Promise<void>
  release: () => void
} {
  const base = getRxStorageDexie()
  let hold = true
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => (markEntered = resolve))
  let release!: () => void
  const releaseP = new Promise<void>(resolve => (release = resolve))
  const storage = {
    ...base,
    createStorageInstance: async (
      params: Parameters<typeof base.createStorageInstance>[0]
    ) => {
      if (hold) {
        hold = false
        markEntered()
        await releaseP
      }
      return base.createStorageInstance(params)
    }
  } as unknown as RxStorage<unknown, unknown>
  return { storage, entered, release }
}

// Track created stores so their expiry-watch intervals never outlive a test.
const liveStores: WasAuthStore[] = []

function makeStore(
  config: WasAppConfig,
  seedStore: SeedStore,
  storage?: RxStorage<unknown, unknown>
): WasAuthStore {
  const store = createAuthStore({
    config,
    registry,
    seedStore,
    ...(storage && { storage })
  })
  liveStores.push(store)
  return store
}

afterEach(async () => {
  while (liveStores.length > 0) {
    await liveStores.pop()!.getState().destroy()
  }
  vi.restoreAllMocks()
})

describe('serialized boot/destroy lifecycle', () => {
  it('a destroy fired during an in-flight boot wins: the aborted boot never resurrects', async () => {
    const config = baseConfig()
    const { storage, entered, release } = gatedStorage()
    const store = makeStore(config, newSeedStore(), storage)

    // Mount: boot begins and parks inside `LocalStore.init`, before it
    // attaches the replica to the storage context.
    const booting = store.getState().boot()
    await entered

    // Cleanup: destroy fires while that boot is still in flight, then the boot
    // is allowed to finish. Serialized, destroy must win -- the aborted boot may
    // not re-open the replica or leave `boot` behind its back.
    const destroying = store.getState().destroy()
    release()
    await Promise.all([booting, destroying])

    expect(store.getState().status).toBe('boot')
    expect(hasStore()).toBe(false)
    expect(store.getState().error).toBeNull()

    // And the session re-boots cleanly on top of the teardown.
    await store.getState().boot()
    expect(store.getState().status).toBe('local')
    expect(hasStore()).toBe(true)
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
  })

  it('a mount/cleanup/mount double-boot lands on an open, usable holder', async () => {
    const config = baseConfig()
    const { storage, entered, release } = gatedStorage()
    const store = makeStore(config, newSeedStore(), storage)

    // The provider's StrictMode shape: boot (mount) -> destroy (cleanup) ->
    // boot (remount), with the first boot still parked inside `LocalStore.init`.
    const boot1 = store.getState().boot()
    await entered
    const destroying = store.getState().destroy()
    const boot2 = store.getState().boot()
    release()
    await Promise.all([boot1, destroying, boot2])

    // The status correctly left `boot`, and the holder is a single OPEN replica
    // (never a closed duplicate): a write + read round trip succeeds.
    expect(store.getState().status).toBe('local')
    expect(store.getState().error).toBeNull()
    expect(hasStore()).toBe(true)
    const id = crypto.randomUUID()
    await requireStore().insertEntity('notes', { id, title: 'after-remount' })
    const rows = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('after-remount')
  })

  it('persisted local data survives a double-boot and is still hydrated after', async () => {
    const config = baseConfig()
    const seedStore = newSeedStore()

    // Seed the anonymous replica with a document via a clean first session.
    const seeder = makeStore(config, seedStore)
    await seeder.getState().boot()
    const noteId = crypto.randomUUID()
    await requireStore().insertEntity('notes', { id: noteId, title: 'kept' })
    await seeder.getState().destroy()

    // A fresh store over the SAME persisted anon seed, driven through the
    // mount/cleanup/mount interleaving with the first boot parked mid-open.
    const { storage, entered, release } = gatedStorage()
    const store = makeStore(config, seedStore, storage)
    const boot1 = store.getState().boot()
    await entered
    const destroying = store.getState().destroy()
    const boot2 = store.getState().boot()
    release()
    await Promise.all([boot1, destroying, boot2])

    // The double-boot landed on an open holder that still reads the persisted
    // document (no empty-looking hydrate against a torn-down/duplicate store).
    expect(store.getState().status).toBe('local')
    expect(store.getState().error).toBeNull()
    expect(hasStore()).toBe(true)
    const rows = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(noteId)
    expect(rows[0]!.title).toBe('kept')
  })

  it('a logout fired during an in-flight hot-restore boot is serialized behind it', async () => {
    const config = baseConfig()
    const seedStore = newSeedStore()

    // Persist a valid connected-session record so `boot()` hot-restores.
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const identity = await deriveIdentity({ seed })
    await persistAppSession({
      session: {
        seed,
        controllerDid: identity.controllerDid,
        spaceUrl: SPACE_URL,
        grants: [
          {
            id: 'urn:zcap:notes',
            parentCapability: rootCapabilityId(SPACE_URL),
            invocationTarget: `${SPACE_URL}notes`
          }
        ] as unknown as IZcap[],
        // Well beyond the 1h near-expiry warning, so the watch never fires.
        expires: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
      },
      store: seedStore
    })

    const { storage, entered, release } = gatedStorage()
    const store = makeStore(config, seedStore, storage)

    // Mount: the boot begins its hot restore and parks inside
    // `LocalStore.init`, before the holder is installed.
    const booting = store.getState().boot()
    await entered

    // "Log out, erase data" clicked while that boot is still bringing the
    // session up -- the e2e shape: a wipe landing inside the StrictMode
    // remount churn after a reload. Unserialized, the logout's teardown and
    // fresh-local re-open interleave with the parked boot's bring-up, and the
    // boot resurrects the connected session the logout just tore down (or the
    // two opens deadlock).
    const loggingOut = store.getState().logout({ wipe: true })
    // Give an unserialized logout time to run to completion before the boot
    // resumes (serialized, it stays queued instead) -- the released boot must
    // then not resurrect the session the logout tore down. Cannot await
    // `loggingOut` here: serialized, it resolves only after the boot the gate
    // is still holding.
    await new Promise(resolve => setTimeout(resolve, 100))
    release()
    await Promise.all([booting, loggingOut])

    // The logout wins: a fresh, usable anonymous local replica, and the
    // persisted session record is gone.
    expect(store.getState().status).toBe('local')
    expect(store.getState().error).toBeNull()
    expect(hasStore()).toBe(true)
    expect((await peekAppSession({ store: seedStore })).record).toBeNull()
    const id = crypto.randomUUID()
    await requireStore().insertEntity('notes', { id, title: 'after-logout' })
    expect(await requireStore().listEntities('notes')).toHaveLength(1)
  })

  it('destroy releases the active storage context, so the facades stop resolving the retired session', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    expect(hasStorageContext()).toBe(true)
    expect(stampLww({ id: 'x' }).writerId).toBe(store.getState().writerId)

    await store.getState().destroy()

    // The pointer is released, not left naming a dead context: nothing an
    // entity-store verb could stamp or write into remains reachable.
    expect(hasStorageContext()).toBe(false)
    expect(hasStore()).toBe(false)
    expect(() => stampLww({ id: 'x' })).toThrow(/no storage context/i)
    expect(() => requireStore()).toThrow(/no storage context/i)

    // A re-boot of the same store reclaims it.
    await store.getState().boot()
    expect(hasStorageContext()).toBe(true)
    expect(stampLww({ id: 'x' }).writerId).toBe(store.getState().writerId)
  })

  it('a keyed provider remount never resolves the retired session once it is torn down', async () => {
    // The keyed `<WasSessionProvider key=...>` shape: the new store is minted
    // (render-phase `useState`) while the old replica is still attached, so its
    // creation-time claim is skipped; then the old provider's cleanup fires
    // `destroy` and the new one's effect fires `boot`, on two independent
    // lifecycle chains. (Without localStorage both stores resolve the same
    // fallback writer id, so the probe tells the sessions apart by context.)
    const oldStore = makeStore(baseConfig(), newSeedStore())
    await oldStore.getState().boot()
    const newStore = makeStore(baseConfig(), newSeedStore())
    const oldContext = oldStore.getState().storageContext
    const newContext = newStore.getState().storageContext
    // The old session is still live and still the one the facades name.
    expect(requireStorageContext()).toBe(oldContext)

    const destroying = oldStore.getState().destroy()
    const booting = newStore.getState().boot()
    // Every facade call attempted while the swap is in flight resolves the
    // OLD context only while its replica is still attached (the session is
    // still live), else the NEW one, else throws; none may stamp into a
    // replica that has been detached and is about to close.
    const resolvedRetired: boolean[] = []
    const probe = async (): Promise<void> => {
      for (let round = 0; round < 50; round++) {
        if (hasStorageContext()) {
          const context = requireStorageContext()
          if (context === oldContext) {
            resolvedRetired.push(!oldContext.hasStore())
          } else {
            expect(context).toBe(newContext)
          }
          stampLww({ id: 'x' })
        } else {
          expect(() => stampLww({ id: 'x' })).toThrow(/no storage context/i)
        }
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
    await Promise.all([probe(), destroying, booting])

    expect(resolvedRetired).not.toContain(true)
    expect(newStore.getState().status).toBe('local')
    expect(requireStorageContext()).toBe(newContext)
    expect(hasStore()).toBe(true)
    const id = crypto.randomUUID()
    await requireStore().insertEntity('notes', { id, title: 'remounted' })
    expect(await requireStore().listEntities('notes')).toHaveLength(1)
  })

  it('a session that loses the attach-time claim closes the replica it opened', async () => {
    // Two providers booting at once (or a keyed remount overlapping the old
    // provider's teardown): both pass the creation-time claim, since neither
    // has a replica attached yet, and both open a database. The second
    // `attachStore` throws; the loser must close what it opened rather than
    // leave an open RxDB database holding its IndexedDB connection.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const openBefore = dbCount()
    const loserConfig = baseConfig()
    const { storage, entered, release } = gatedStorage()
    const loser = makeStore(loserConfig, newSeedStore(), storage)
    const winner = makeStore(baseConfig(), newSeedStore())

    // The loser is parked inside `LocalStore.init`, past the creation-time
    // claim, while the winner boots to completion and attaches its replica.
    const losing = loser.getState().boot()
    await entered
    await winner.getState().boot()
    expect(winner.getState().status).toBe('local')
    release()
    await losing

    // The loser's boot failed outright (the local fallback loses the same
    // claim), so it never left `boot`; the winner's replica is the active one.
    expect(loser.getState().status).toBe('boot')
    expect(loser.getState().error).toMatch(/another storage context/i)
    expect(hasStore()).toBe(true)

    // Exactly one RxDB database is open: the winner's. A leaked loser replica
    // would count here too (`closeDuplicates` hides it from a re-open probe,
    // but not from the process-wide count the collection cap is charged to).
    expect(dbCount()).toBe(openBefore + 1)

    // And the loser's database is removable by name, as a later wipe needs.
    const seed = await createSeedStore({
      dbName: `${loserConfig.dbName}-anon`
    }).loadSeed()
    const identity = await deriveIdentity({ seed: seed! })
    await expect(
      LocalStore.removeDatabase({
        dbName: dbNameForController({
          dbName: loserConfig.dbName!,
          controllerDid: identity.controllerDid
        })
      })
    ).resolves.toBeUndefined()
  })
})
