/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the session descriptor policy: minting the anonymous
 * replica's descriptors at local birth, the cache-only read before any remote
 * exists, and completing a cached set with live reads at login. The live read
 * (`readRemoteDescriptors`) is mocked; the seed stores are in-memory fakes.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IZcap } from '@interop/data-integrity-core'
import type { CollectionEncryption } from '@interop/was-client'
import { deriveIdentity, type IdentityAgents } from '../identity/agents.js'
import { createDescriptorCache, type SeedStore } from '../identity/seedStore.js'
import type { ParsedGrants } from '../grants.js'
import type { WasCollectionConfig } from '../config.js'
import { createDescriptorManager } from './descriptorManager.js'
import { readRemoteDescriptors, type DescriptorReadOutcome } from './wasSync.js'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../log.js'

vi.mock('./wasSync.js', () => ({
  readRemoteDescriptors: vi.fn(async (): Promise<DescriptorReadOutcome> => ({
    descriptors: {},
    failures: []
  }))
}))

const readRemoteDescriptorsMock = vi.mocked(readRemoteDescriptors)

const collections: WasCollectionConfig[] = [
  { key: 'notes', id: 'notes' },
  { key: 'posts', id: 'posts', visibility: 'public' }
]

const parsed: ParsedGrants = {
  baseUrl: 'https://was.example',
  spaceId: 'space-1',
  byCollectionId: {
    notes: { id: 'urn:zcap:notes' } as unknown as IZcap,
    posts: { id: 'urn:zcap:posts' } as unknown as IZcap
  }
}

/**
 * An in-memory {@link SeedStore}: the three records the real one persists, plus
 * a `failRead` switch so a descriptor read can be made to throw.
 */
function fakeSeedStore(): SeedStore & { failRead: boolean } {
  const records: Record<string, unknown> = {}
  return {
    dbName: 'fake',
    failRead: false,
    async saveSeed(seed: Uint8Array) {
      records.seed = seed
    },
    async loadSeed() {
      return (records.seed as Uint8Array | undefined) ?? null
    },
    async saveRecord(record: unknown) {
      records.record = record
    },
    async loadRecord() {
      return records.record ?? null
    },
    async saveDescriptors(descriptors: unknown) {
      records.descriptors = descriptors
    },
    async loadDescriptors() {
      if (this.failRead) {
        throw new Error('IndexedDB read failed.')
      }
      return records.descriptors ?? null
    },
    async clearSeedStore() {
      for (const key of Object.keys(records)) {
        delete records[key]
      }
    }
  }
}

let identity: IdentityAgents

beforeEach(async () => {
  readRemoteDescriptorsMock.mockClear()
  identity = await deriveIdentity({
    seed: crypto.getRandomValues(new Uint8Array(32))
  })
})

describe('loadOrMintAnonDescriptors', () => {
  it('mints one descriptor per private collection and skips public ones', async () => {
    const anonStore = fakeSeedStore()
    const manager = createDescriptorManager({
      collections,
      sessionStore: fakeSeedStore(),
      anonStore
    })

    const descriptors = await manager.loadOrMintAnonDescriptors(identity)

    expect(Object.keys(descriptors)).toEqual(['notes'])
    expect(descriptors.notes?.epochs?.length).toBe(1)
  })

  it('reloads the persisted descriptors on the second call', async () => {
    const anonStore = fakeSeedStore()
    const saveDescriptors = vi.spyOn(anonStore, 'saveDescriptors')
    const manager = createDescriptorManager({
      collections,
      sessionStore: fakeSeedStore(),
      anonStore
    })

    const first = await manager.loadOrMintAnonDescriptors(identity)
    const second = await manager.loadOrMintAnonDescriptors(identity)

    expect(second).toEqual(first)
    // Minted once, at the collection's local birth; the reload writes nothing.
    expect(saveDescriptors).toHaveBeenCalledTimes(1)
  })

  it('mints afresh for a different anonymous controller', async () => {
    const anonStore = fakeSeedStore()
    const manager = createDescriptorManager({
      collections,
      sessionStore: fakeSeedStore(),
      anonStore
    })
    const other = await deriveIdentity({
      seed: crypto.getRandomValues(new Uint8Array(32))
    })

    const first = await manager.loadOrMintAnonDescriptors(identity)
    const second = await manager.loadOrMintAnonDescriptors(other)

    expect(second.notes).not.toEqual(first.notes)
  })
})

describe('loadCachedDescriptors', () => {
  it('returns undefined when nothing is cached', async () => {
    const manager = createDescriptorManager({
      collections,
      sessionStore: fakeSeedStore(),
      anonStore: fakeSeedStore()
    })

    expect(
      await manager.loadCachedDescriptors({
        controllerDid: identity.controllerDid
      })
    ).toBeUndefined()
  })

  it('returns the cached set filtered to the registered collections', async () => {
    const sessionStore = fakeSeedStore()
    const manager = createDescriptorManager({
      collections,
      sessionStore,
      anonStore: fakeSeedStore()
    })
    const descriptor = { currentEpoch: 'e0', epochs: [{ id: 'e0' }] }
    await sessionStore.saveDescriptors({
      controller: identity.controllerDid,
      descriptors: {
        notes: descriptor,
        // Not in this app's registry: never handed to a replica open.
        'other-app': { currentEpoch: 'e1', epochs: [{ id: 'e1' }] }
      }
    })

    expect(
      await manager.loadCachedDescriptors({
        controllerDid: identity.controllerDid
      })
    ).toEqual({ notes: descriptor })
  })

  it('warns and returns undefined when the store read throws', async () => {
    const sessionStore = fakeSeedStore()
    sessionStore.failRead = true
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    const manager = createDescriptorManager({
      collections,
      sessionStore,
      anonStore: fakeSeedStore()
    })

    expect(
      await manager.loadCachedDescriptors({
        controllerDid: identity.controllerDid
      })
    ).toBeUndefined()
    expect(capture.events.some(event => event.level === 'warn')).toBe(true)
    setLogger(previous)
  })
})

describe('completeDescriptors', () => {
  const cached: Record<string, CollectionEncryption> = {
    notes: {
      currentEpoch: 'e0',
      epochs: [{ id: 'e0' }]
    } as unknown as CollectionEncryption
  }

  it('does no live read when the cache covers every granted collection', async () => {
    const manager = createDescriptorManager({
      collections,
      sessionStore: fakeSeedStore(),
      anonStore: fakeSeedStore()
    })

    const result = await manager.completeDescriptors({
      cached,
      identity,
      parsed,
      onReadFailure: 'reject'
    })

    expect(result).toEqual({ descriptors: cached, fresh: {} })
    expect(readRemoteDescriptorsMock).not.toHaveBeenCalled()
  })

  it('live-reads, caches, and returns a missing granted private collection', async () => {
    const sessionStore = fakeSeedStore()
    const manager = createDescriptorManager({
      collections,
      sessionStore,
      anonStore: fakeSeedStore()
    })
    readRemoteDescriptorsMock.mockResolvedValueOnce({
      descriptors: cached,
      failures: []
    })

    const result = await manager.completeDescriptors({
      identity,
      parsed,
      onReadFailure: 'reject'
    })

    expect(result).toEqual({ descriptors: cached, fresh: cached })
    // Only the missing private collection is read; the public one carries no
    // descriptor at all.
    expect(readRemoteDescriptorsMock).toHaveBeenCalledTimes(1)
    expect(
      readRemoteDescriptorsMock.mock.calls[0]?.[0].collections.map(
        entry => entry.id
      )
    ).toEqual(['notes'])
    // Cached under the connecting controller, for the next offline open.
    expect(
      await createDescriptorCache({
        store: sessionStore,
        controller: identity.controllerDid
      }).readAllDescriptors()
    ).toEqual(cached)
  })

  const tasks = { key: 'tasks', id: 'tasks' }
  const parsedWithTasks = {
    ...parsed,
    byCollectionId: {
      ...parsed.byCollectionId,
      tasks: { id: 'urn:zcap:tasks' } as unknown as IZcap
    }
  }

  it('rejects a login when the live read fails, rather than answering "no descriptor"', async () => {
    const manager = createDescriptorManager({
      collections: [...collections, tasks],
      sessionStore: fakeSeedStore(),
      anonStore: fakeSeedStore()
    })
    const failure = new Error('502 Bad Gateway')
    readRemoteDescriptorsMock.mockResolvedValueOnce({
      descriptors: {},
      failures: [{ collection: tasks, err: failure }]
    })

    await expect(
      manager.completeDescriptors({
        cached,
        identity,
        parsed: parsedWithTasks,
        onReadFailure: 'reject'
      })
    ).rejects.toBe(failure)
  })

  it('warns and leaves the collection fail-closed on a restore when the live read fails', async () => {
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    try {
      const manager = createDescriptorManager({
        collections: [...collections, tasks],
        sessionStore: fakeSeedStore(),
        anonStore: fakeSeedStore()
      })
      const failure = new Error('502 Bad Gateway')
      readRemoteDescriptorsMock.mockResolvedValueOnce({
        descriptors: {},
        failures: [{ collection: tasks, err: failure }]
      })

      const result = await manager.completeDescriptors({
        cached,
        identity,
        parsed: parsedWithTasks,
        onReadFailure: 'skip'
      })

      // The cached set opens as-is; `tasks` is simply not in it.
      expect(result).toEqual({ descriptors: cached, fresh: {} })
      expect(
        capture.events.some(
          event =>
            event.level === 'warn' &&
            event.data?.collectionId === 'tasks' &&
            event.err === failure
        )
      ).toBe(true)
    } finally {
      setLogger(previous)
    }
  })

  it('returns the cached set when the live read answers no descriptor', async () => {
    const manager = createDescriptorManager({
      collections: [...collections, tasks],
      sessionStore: fakeSeedStore(),
      anonStore: fakeSeedStore()
    })
    readRemoteDescriptorsMock.mockResolvedValueOnce({
      descriptors: {},
      failures: []
    })

    const result = await manager.completeDescriptors({
      cached,
      identity,
      parsed: parsedWithTasks,
      onReadFailure: 'reject'
    })

    expect(result).toEqual({ descriptors: cached, fresh: {} })
  })
})
