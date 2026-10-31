/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Clearing data must leave nothing behind. These tests pin the two grades the
 * library ships and the orphan they exist to prevent:
 *
 * - `clearLocalData()` deletes EVERY database this app wrote on the browser --
 *   the connected replica, the anonymous one, and both seed stores -- plus the
 *   persisted writer id. Run while connected it used to remove only the replica
 *   that happened to be open, then discard the anonymous seed and mint a new
 *   identity, stranding the previous anonymous replica under a database name
 *   derived from a DID that no longer existed anywhere.
 * - `logout({ wipe: true })` deliberately stops at the connected replica: a
 *   local-first app keeps working logged out, so the anonymous replica and the
 *   writer id survive.
 *
 * The collections are declared PUBLIC (plaintext) so the tests need no
 * descriptor provisioning: what is being asserted here is which databases
 * exist, which is independent of how their rows are sealed.
 *
 * The environment is `node` (like the other replica suites) rather than jsdom,
 * where fake-indexeddb hands back cross-realm typed arrays and every seed read
 * misses. `localStorage` is stubbed in, since the writer id lives there.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { IZcap } from '@interop/data-integrity-core'
import {
  createAuthStore,
  type PwsAuthStore
} from '../../src/session/authStore.js'
import {
  executeLocalWipe,
  snapshotWipeTargets
} from '../../src/session/localWipe.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { dbNameForController } from '../../src/storage/localStore.js'
import {
  requireStore,
  requireWriterId
} from '../../src/storage/storageManager.js'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../../src/config.js'
import { rootCapabilityId } from '@interop/pws-client/paths'
import type { StoreRegistry, PwsAppConfig } from '../../src/config.js'

const SPACE_URL = 'http://localhost:3999/space/space-1/'

// Inert replication: the wipe logic runs without any network machinery, and a
// public collection needs no descriptor read.
vi.mock('../../src/storage/pwsSync.js', () => ({
  startPwsSync: vi.fn(async () => ({})),
  readRemoteDescriptors: vi.fn(async () => ({ descriptors: {}, failures: [] }))
}))

const registry: StoreRegistry = {}

const liveStores: PwsAuthStore[] = []

// A minimal `localStorage` (node has none): the writer id is the one piece of
// wipe state that does not live in IndexedDB.
const stored = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => {
    stored.set(key, String(value))
  },
  removeItem: (key: string) => {
    stored.delete(key)
  },
  clear: () => stored.clear(),
  key: (index: number) => [...stored.keys()][index] ?? null,
  get length() {
    return stored.size
  }
} as Storage

function storedKeys(prefix: string): string[] {
  return [...stored.keys()].filter(key => key.startsWith(prefix))
}

function baseConfig(): PwsAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    appUrl: 'http://localhost:5173/test-app',
    collections: [{ key: 'notes', id: 'notes', visibility: 'public' }],
    // A unique base name per test so the databases never collide across tests
    // sharing the one process-wide fake-indexeddb.
    dbName: `pws-react-${Math.random().toString(36).slice(2)}`
  }
}

/**
 * A store whose seed stores are the REAL ones (`<dbName>-session` /
 * `<dbName>-anon` on the shared fake IndexedDB), rather than an injected
 * store: their databases are part of what the wipe has to reach.
 */
function makeStore(config: PwsAppConfig): PwsAuthStore {
  const store = createAuthStore({ config, registry })
  liveStores.push(store)
  return store
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

async function databaseNames(): Promise<string[]> {
  const listed = await indexedDB.databases()
  return listed.map(entry => entry.name).filter(name => !!name) as string[]
}

/**
 * Every IndexedDB database belonging to this app: the seed stores are named
 * `<dbName>-...` directly, and each replica collection is its own Dexie
 * database named `rxdb-dexie-<dbName>-<hash>--<version>--<collection>`.
 */
async function appDatabaseNames(config: PwsAppConfig): Promise<string[]> {
  const names = await databaseNames()
  return names.filter(
    name =>
      name.startsWith(`${config.dbName}-`) ||
      name.startsWith(`rxdb-dexie-${config.dbName}-`)
  )
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(async () => {
  for (const store of liveStores.splice(0)) {
    await store.getState().destroy()
  }
  vi.clearAllMocks()
})

describe('clearLocalData() from connected', () => {
  it('leaves neither replica behind, orphaned or otherwise', async () => {
    const config = baseConfig()
    const store = makeStore(config)
    await store.getState().boot()
    const anonDid = store.getState().controllerDid!
    await requireStore().insertEntity('notes', { id: crypto.randomUUID() })

    // `adopt: 'leave'` is the orphan case: the anonymous replica survives the
    // login, so at clear time there are TWO replicas on disk and only one of
    // them is open.
    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    await store.getState().connectWithGrants({
      seed: walletSeed,
      grants: noteGrants(),
      adopt: 'leave'
    })
    expect(store.getState().status).toBe('connected')
    const connectedDid = store.getState().controllerDid!
    const anonDbName = dbNameForController({
      dbName: config.dbName!,
      controllerDid: anonDid
    })
    const connectedDbName = dbNameForController({
      dbName: config.dbName!,
      controllerDid: connectedDid
    })
    const before = await appDatabaseNames(config)
    expect(before.some(name => name.includes(anonDbName))).toBe(true)
    expect(before.some(name => name.includes(connectedDbName))).toBe(true)

    const report = await store.getState().clearLocalData()

    // Both snapshotted replicas are gone -- including the anonymous one, whose
    // name is derivable only from a seed the clear itself destroys.
    const after = await appDatabaseNames(config)
    expect(after.some(name => name.includes(anonDbName))).toBe(false)
    expect(after.some(name => name.includes(connectedDbName))).toBe(false)
    // The session store (app-key seed, session record, descriptor cache) is
    // gone too; `<dbName>-anon` is back because the fresh `local` replica has
    // already minted and persisted its new seed.
    expect(after).not.toContain(`${config.dbName}-session`)
    const freshDid = store.getState().controllerDid!
    expect(freshDid).not.toBe(anonDid)
    const freshDbName = dbNameForController({
      dbName: config.dbName!,
      controllerDid: freshDid
    })
    for (const name of after) {
      expect(
        name === `${config.dbName}-anon` || name.includes(freshDbName)
      ).toBe(true)
    }
    // Nothing survived that the executor could not account for.
    expect(report.failed).toEqual([])
    expect(report.removed.length).toBeGreaterThan(0)
    expect(store.getState().status).toBe('local')
  })

  it('clears the persisted writer id and keeps stamping', async () => {
    const config = baseConfig()
    const store = makeStore(config)
    await store.getState().boot()
    const originalWriterId = store.getState().writerId
    expect(localStorage.getItem(`${DEFAULT_STORAGE_KEY_PREFIX}writerId`)).toBe(
      originalWriterId
    )

    await store.getState().clearLocalData()

    // The browser is left as it was before first run: no key of ours remains.
    expect(storedKeys(DEFAULT_STORAGE_KEY_PREFIX)).toEqual([])
    // The session keeps running, so the write verbs must still be able to
    // stamp -- under a fresh, unpersisted id rather than the cleared one.
    expect(requireWriterId()).not.toBe(originalWriterId)
    // The displayed id follows the one being stamped.
    expect(store.getState().writerId).toBe(requireWriterId())
    await requireStore().insertEntity('notes', { id: crypto.randomUUID() })
  })
})

describe('clearLocalData() from local', () => {
  it('leaves no database and no localStorage key behind', async () => {
    const config = baseConfig()
    const store = makeStore(config)
    await store.getState().boot()
    const anonDid = store.getState().controllerDid!
    await requireStore().insertEntity('notes', { id: crypto.randomUUID() })
    const anonDbName = dbNameForController({
      dbName: config.dbName!,
      controllerDid: anonDid
    })

    const report = await store.getState().clearLocalData()

    const after = await appDatabaseNames(config)
    expect(after.some(name => name.includes(anonDbName))).toBe(false)
    expect(after).not.toContain(`${config.dbName}-session`)
    expect(report.failed).toEqual([])
    expect(storedKeys(DEFAULT_STORAGE_KEY_PREFIX)).toEqual([])
    expect(store.getState().status).toBe('local')
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
  })
})

describe('logout({ wipe: true })', () => {
  it('erases the connected replica only, keeping the local-first one', async () => {
    const config = baseConfig()
    const store = makeStore(config)
    await store.getState().boot()
    const anonDid = store.getState().controllerDid!
    const writerId = store.getState().writerId
    const anonDbName = dbNameForController({
      dbName: config.dbName!,
      controllerDid: anonDid
    })

    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    await store.getState().connectWithGrants({
      seed: walletSeed,
      grants: noteGrants(),
      adopt: 'leave'
    })
    const connectedDbName = dbNameForController({
      dbName: config.dbName!,
      controllerDid: store.getState().controllerDid!
    })

    await store.getState().logout({ wipe: true })

    const after = await appDatabaseNames(config)
    // Not merely emptied: RxDB's own removal clears each collection's table and
    // leaves its IndexedDB database standing, which is residue "erase data"
    // should not leave.
    expect(after.some(name => name.includes(connectedDbName))).toBe(false)
    expect(after).not.toContain(`${config.dbName}-session`)
    // The anonymous replica and its identity survive: a local-first app keeps
    // working logged out, and the user is expected to log back in here.
    expect(store.getState().controllerDid).toBe(anonDid)
    expect(after.some(name => name.includes(anonDbName))).toBe(true)
    expect(localStorage.getItem(`${DEFAULT_STORAGE_KEY_PREFIX}writerId`)).toBe(
      writerId
    )
  })
})

/**
 * Creates an empty IndexedDB database under `name`, so a wipe has something
 * real to delete (or to leave alone).
 */
async function createDatabase({
  idb,
  name
}: {
  idb: IDBFactory
  name: string
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = idb.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('session')
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB open failed.'))
  })
}

describe('executeLocalWipe', () => {
  it('sweeps only the names derived from its own dbName', async () => {
    const idb = new IDBFactory()
    // Two apps on one origin, one `dbName` extending the other. Each has its
    // seed stores, an orphaned replica, and a replica collection's Dexie shell.
    const namesFor = (dbName: string) => [
      `${dbName}-session`,
      `${dbName}-anon`,
      `${dbName}-0123abcd`,
      `rxdb-dexie-${dbName}-0123abcd--0--_rxdb_internal`,
      `rxdb-dexie-${dbName}-0123abcd--0--todos`
    ]
    // Near misses of the swept shapes, which must be left alone too.
    const nearMisses = [
      'notes',
      'notes-',
      'notes-0123abcde',
      'rxdb-dexie-notes-0123abcd'
    ]
    const untouched = [...namesFor('notes-archive'), ...nearMisses]
    for (const name of [...namesFor('notes'), ...untouched]) {
      await createDatabase({ idb, name })
    }
    const targets = snapshotWipeTargets({
      dbName: 'notes',
      sessionStoreDbName: 'notes-session',
      anonStoreDbName: 'notes-anon',
      grade: 'clear'
    })

    const report = await executeLocalWipe({ targets, idb })

    expect(report.failed).toEqual([])
    expect(report.unverified).toEqual([])
    const remaining = (await idb.databases()).map(entry => entry.name)
    expect(remaining.sort()).toEqual(untouched.sort())
  })

  it('reports what it could not confirm on an engine without databases()', async () => {
    const dbName = `pws-react-${Math.random().toString(36).slice(2)}`
    const idb = new IDBFactory()
    // Give the seed store something real to delete.
    await createDatabase({ idb, name: `${dbName}-anon` })
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const { controllerDid } = await deriveIdentity({ seed })
    const targets = snapshotWipeTargets({
      dbName,
      sessionStoreDbName: `${dbName}-session`,
      anonStoreDbName: `${dbName}-anon`,
      grade: 'clear',
      connectedControllerDid: controllerDid,
      storageKeyPrefix: DEFAULT_STORAGE_KEY_PREFIX
    })

    // An engine that does not implement `indexedDB.databases()`: the named
    // deletes still run (skipping them would leave real data behind), but
    // nothing sweeps and nothing confirms, so the caller is told so rather
    // than handed an outcome that reads clean.
    const blindIdb = Object.assign(Object.create(IDBFactory.prototype), {
      open: idb.open.bind(idb),
      deleteDatabase: idb.deleteDatabase.bind(idb),
      cmp: idb.cmp.bind(idb),
      databases: undefined
    }) as unknown as IDBFactory

    const report = await executeLocalWipe({ targets, idb: blindIdb })

    expect(report.unverified).toContain(`${dbName}-anon`)
    expect(report.failed).toEqual([])
    // The delete really ran, blind or not.
    const remaining = await idb.databases()
    expect(remaining.map(entry => entry.name)).not.toContain(`${dbName}-anon`)
  })
})
