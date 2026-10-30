/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * SyncController lifecycle unit tests (jsdom, for `window`): the terminal-stop
 * latch (a `stop()` that raced an in-flight bootstrap keeps a later `start()` a
 * no-op), the skip-uncovered-collections behavior (a collection the grant set
 * does not cover is flagged and skipped rather than replicated capability-less),
 * the failed bring-up (a throw during `start()` unwinds, flags every
 * collection as errored, rethrows, and leaves the controller re-startable), and
 * the writer-id pass-through (the session's label reaches the core by default
 * and is withheld under `sync.declareWriterId: false`).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncController, isAuthError } from '@interop/pws-sync/rxdb'
import { SyncController } from '../../src/storage/syncController.js'
import {
  createSyncStatusStore,
  deriveSyncRollup,
  type SyncStatusStore
} from '../../src/storage/syncStatusStore.js'
import { PwsSyncAuthError } from '@interop/pws-client/sync'
import type { PwsRemoteStore } from '../../src/storage/pwsRemoteStore.js'
import type { LocalStore } from '../../src/storage/localStore.js'

// The core's factory is wrapped, not replaced: every suite here runs against
// the real core, and the writer-id suite reads the options the binding built.
vi.mock('@interop/pws-sync/rxdb', async importOriginal => {
  const actual = await importOriginal<typeof import('@interop/pws-sync/rxdb')>()
  return { ...actual, createSyncController: vi.fn(actual.createSyncController) }
})

const COLLECTIONS = [{ key: 'notes', id: 'notes' }]

/**
 * A remote store whose `collectionCapability` and `pws` access are spied so a
 * test can assert whether `start()` reached the per-collection build at all.
 */
function fakeRemoteStore(capabilityFor: (id: string) => object | undefined): {
  remoteStore: PwsRemoteStore
  collectionCapability: ReturnType<typeof vi.fn>
} {
  const collectionCapability = vi.fn(capabilityFor)
  const remoteStore = {
    // The sync port binds its `changes` feed handle at construction, so the
    // fake client has to answer `spaceAt().collection()`; nothing here is
    // called.
    pws: {
      spaceAt: () => ({ collection: () => ({}) })
    },
    spaceUrl: 'http://localhost:3999/space/space-1/',
    collectionCapability
  } as unknown as PwsRemoteStore
  return { remoteStore, collectionCapability }
}

let syncStatus: SyncStatusStore

beforeEach(() => {
  syncStatus = createSyncStatusStore()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SyncController stop-then-start latch', () => {
  it('never starts after stop() (stop is terminal)', async () => {
    const controller = new SyncController({
      collections: COLLECTIONS,
      syncStatus
    })
    // A logout stops the controller before the bootstrap ever calls start().
    await controller.stop()

    const { remoteStore, collectionCapability } = fakeRemoteStore(() => ({}))
    const rxCollection = vi.fn()
    await controller.start({
      remoteStore,
      localStore: { rxCollection } as unknown as LocalStore
    })

    // The latch short-circuits before any per-collection wiring runs.
    expect(collectionCapability).not.toHaveBeenCalled()
    expect(rxCollection).not.toHaveBeenCalled()
    expect(syncStatus.getState().statuses).toEqual({})
  })

  it('never builds a core when stop() lands during the driver import', async () => {
    const coreFactory = vi.mocked(createSyncController)
    coreFactory.mockClear()
    const controller = new SyncController({
      collections: COLLECTIONS,
      syncStatus
    })
    const { remoteStore } = fakeRemoteStore(() => ({}))
    // `start()` suspends on the lazy driver import before it holds a core;
    // a teardown that lands in that window must still win.
    const starting = controller.start({
      remoteStore,
      localStore: { rxCollection: vi.fn() } as unknown as LocalStore
    })
    await controller.stop()
    await starting

    expect(coreFactory).not.toHaveBeenCalled()
    expect(syncStatus.getState().statuses).toEqual({})
  })
})

describe('isAuthError', () => {
  it('recognises a PwsSyncAuthError at the top level', () => {
    expect(isAuthError(new PwsSyncAuthError(403))).toBe(true)
  })

  it('recognises a PwsSyncAuthError wrapped in an RxError-like graph', () => {
    // RxDB wraps a thrown push/pull-handler error under `parameters.errors`.
    const rxError = {
      code: 'RC_PUSH',
      parameters: { errors: [new PwsSyncAuthError(401)] }
    }
    expect(isAuthError(rxError)).toBe(true)
  })

  it('recognises the plain-JSON form RxDB serializes handler errors to', () => {
    // RxDB's RC_PULL/RC_PUSH wrapping runs the thrown error through
    // `errorToPlainJson`, keeping only name/message/stack -- no instance, no
    // custom fields like `status`.
    const rxError = {
      code: 'RC_PULL',
      parameters: {
        errors: [
          {
            name: 'PwsSyncAuthError',
            message: 'PWS storage access denied (HTTP 403).',
            stack: 'PwsSyncAuthError: ...'
          }
        ]
      }
    }
    expect(isAuthError(rxError)).toBe(true)
  })

  it('recognises a PwsSyncAuthError nested under `cause`', () => {
    expect(isAuthError({ cause: { cause: new PwsSyncAuthError(401) } })).toBe(
      true
    )
  })

  it('returns false for a non-auth error graph', () => {
    expect(isAuthError(new Error('network down'))).toBe(false)
    expect(isAuthError({ status: 500, parameters: { errors: [] } })).toBe(false)
  })

  it('tolerates cycles in the error graph', () => {
    const cyclic: { self?: unknown; cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(isAuthError(cyclic)).toBe(false)
  })
})

describe('SyncController failed bring-up', () => {
  it('rethrows, flags every collection, and stays re-startable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new SyncController({
      collections: COLLECTIONS,
      syncStatus,
      sync: { pollMs: 0 }
    })
    const { remoteStore } = fakeRemoteStore(() => ({}))
    // The bring-up throws where the replication is wired up.
    const rxCollection = vi.fn(() => {
      throw new Error('database closed')
    })
    const localStore = { rxCollection } as unknown as LocalStore

    // The failure surfaces to the caller's bootstrap rather than resolving
    // silently through a terminal stop().
    await expect(controller.start({ remoteStore, localStore })).rejects.toThrow(
      'database closed'
    )
    expect(error).toHaveBeenCalled()

    // Every configured collection reads as 'error', so the rollup reports the
    // failure rather than "Local only".
    const { statuses } = syncStatus.getState()
    expect(statuses.notes).toBe('error')
    expect(deriveSyncRollup(Object.values(statuses)).state).toBe('error')

    // Not latched: a later start() runs its body again instead of no-opping.
    await expect(controller.start({ remoteStore, localStore })).rejects.toThrow(
      'database closed'
    )
    expect(rxCollection).toHaveBeenCalledTimes(2)
  })
})

describe('SyncController uncovered-collection skip', () => {
  it('skips (and flags) a collection with no delegated capability', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = new SyncController({
      collections: COLLECTIONS,
      syncStatus,
      // Disable the poll timer so the test leaves no interval behind.
      sync: { pollMs: 0 }
    })

    const { remoteStore } = fakeRemoteStore(() => undefined)
    const rxCollection = vi.fn()
    await controller.start({
      remoteStore,
      localStore: { rxCollection } as unknown as LocalStore
    })

    // The uncovered collection is flagged and never wired to a replication.
    expect(syncStatus.getState().statuses.notes).toBe('error')
    expect(rxCollection).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()

    await controller.stop()
  })
})

describe('SyncController writer-id pass-through', () => {
  const coreFactory = vi.mocked(createSyncController)

  /**
   * Starts a controller under the given sync config and returns the options
   * the binding handed the core.
   */
  async function coreOptionsFor(sync: {
    pollMs: number
    declareWriterId?: boolean
  }): Promise<{ writerId?: string }> {
    const controller = new SyncController({
      collections: COLLECTIONS,
      syncStatus,
      writerId: 'writer-1',
      sync
    })
    const { remoteStore } = fakeRemoteStore(() => undefined)
    await controller.start({
      remoteStore,
      localStore: { rxCollection: vi.fn() } as unknown as LocalStore
    })
    await controller.stop()
    return coreFactory.mock.calls.at(-1)![0]
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    coreFactory.mockClear()
  })

  it('declares the session writerId to the core by default', async () => {
    expect(await coreOptionsFor({ pollMs: 0 })).toMatchObject({
      writerId: 'writer-1'
    })
  })

  it('withholds the label under sync.declareWriterId: false', async () => {
    const options = await coreOptionsFor({ pollMs: 0, declareWriterId: false })
    expect(options).not.toHaveProperty('writerId')
  })
})
