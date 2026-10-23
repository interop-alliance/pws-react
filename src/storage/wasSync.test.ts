/**
 * Unit tests for the metadata read pass shared by the login-time
 * `readRemoteDescriptors` and the sync bootstrap `startWasSync`: a read that
 * FAILS is never taken for "no descriptor", each granted collection's object
 * is read once, and the blinded-index install re-reads it only when the
 * declaration replaced its `custom`. The remote store is replaced with a stub
 * (`WasRemoteStore.fromGrants` is spied), and the local store and sync
 * controller are inert fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IZcap } from '@interop/data-integrity-core'
import type { ZcapClient } from '@interop/ezcap'
import type { CollectionEncryption } from '@interop/was-client'
import {
  KeyUnwrapError,
  UnverifiedDescriptorError
} from '@interop/was-client/edv'
import type { WasCollectionConfig } from '../config.js'
import type { ParsedGrants } from '../grants.js'
import type { LocalStore } from './localStore.js'
import type { SyncController } from './syncController.js'
import { WasRemoteStore, type CollectionMetaRead } from './wasRemoteStore.js'
import { fakeDescriptorSource } from '../../test/fixtures/descriptorSource.js'
import { readRemoteDescriptors, startWasSync } from './wasSync.js'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../log.js'

const collections: WasCollectionConfig[] = [
  { key: 'notes', id: 'notes' },
  { key: 'tasks', id: 'tasks' }
]

const parsed: ParsedGrants = {
  baseUrl: 'https://was.example',
  spaceId: 'space-1',
  byCollectionId: {
    notes: { id: 'urn:zcap:notes' } as unknown as IZcap,
    tasks: { id: 'urn:zcap:tasks' } as unknown as IZcap
  }
}

const zcapClient = {} as unknown as ZcapClient

const descriptor = {
  currentEpoch: 'e0',
  epochs: [{ id: 'e0', recipients: [] }]
} as unknown as CollectionEncryption

/**
 * The stored `custom` envelope of a collection under test, opaque to this
 * layer and installed verbatim.
 */
const stored = { jwe: { protected: 'opaque' } } as unknown as NonNullable<
  CollectionMetaRead['description']['custom']
>

/**
 * A remote store whose log-governed descriptor source answers per collection
 * id: a descriptor (the verified log head), `undefined` (no governing log), or
 * a rejection; its Metadata read serves a stored object carrying `custom` and
 * the same descriptor as its `encryption` projection. The source declares
 * `verifiesHistory: true` as the real one does, unless `plainSource` withholds
 * the flag. `wrote` scripts what the blinded-index declaration reports; every
 * other declaration verb is a resolved no-op that records its call.
 */
function stubRemoteStore(
  reads: Record<string, CollectionEncryption | undefined | Error>,
  { wrote = false, plainSource = false } = {}
) {
  const stub = {
    descriptorSource: fakeDescriptorSource({
      plain: plainSource,
      collectionEncryption: async ({ collectionId }) => {
        const answer = reads[collectionId]
        if (answer instanceof Error) {
          throw answer
        }
        return answer
      }
    }),
    readCollectionMeta: vi.fn(
      async (collectionId: string): Promise<CollectionMetaRead | undefined> => {
        const answer = reads[collectionId]
        if (answer instanceof Error) {
          throw answer
        }
        return {
          description: {
            id: collectionId,
            type: ['Collection'],
            ...(answer && { encryption: answer }),
            custom: stored
          },
          etag: '"v1"'
        }
      }
    ),
    declareBlindedIndexes: vi.fn(async (collectionId: string) => ({
      collectionId,
      ok: true,
      wrote
    })),
    declareCollectionIndexes: vi.fn(async (collectionId: string) => ({
      collectionId,
      ok: true,
      skipped: true
    }))
  }
  vi.spyOn(WasRemoteStore, 'fromGrants').mockReturnValue(
    stub as unknown as WasRemoteStore
  )
  return stub
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readRemoteDescriptors', () => {
  it('reports a failed collection read on failures, beside the readable ones', async () => {
    const failure = new Error('descriptor read failed')
    stubRemoteStore({ notes: descriptor, tasks: failure })

    expect(
      await readRemoteDescriptors({ parsed, zcapClient, collections })
    ).toEqual({
      descriptors: { notes: descriptor },
      failures: [{ collection: collections[1], err: failure }]
    })
  })

  it('keeps only the epoch-bearing descriptors when every read answers', async () => {
    stubRemoteStore({ notes: descriptor, tasks: undefined })

    expect(
      await readRemoteDescriptors({ parsed, zcapClient, collections })
    ).toEqual({ descriptors: { notes: descriptor }, failures: [] })
  })

  it('refuses a source that does not verify the governing log, per collection', async () => {
    // A stripped projection with a host-minted epoch is indistinguishable
    // from an honest point-state descriptor through a plain source, so the
    // source is refused before it is asked and nothing it would have served
    // is adopted.
    const remote = stubRemoteStore(
      { notes: descriptor, tasks: descriptor },
      { plainSource: true }
    )
    const outcome = await readRemoteDescriptors({
      parsed,
      zcapClient,
      collections
    })
    expect(outcome.descriptors).toEqual({})
    expect(outcome.failures.map(({ collection }) => collection)).toEqual(
      collections
    )
    for (const { err } of outcome.failures) {
      expect(err).toBeInstanceOf(UnverifiedDescriptorError)
    }
    expect(remote.descriptorSource.collectionEncryption).not.toHaveBeenCalled()
  })

  it('does not take a Metadata object read for the descriptor', async () => {
    // The login-time read wants nothing off the Metadata object: the
    // descriptor is the verified log head, not the served projection.
    const remote = stubRemoteStore({ notes: descriptor, tasks: undefined })
    await readRemoteDescriptors({ parsed, zcapClient, collections })
    expect(remote.readCollectionMeta).not.toHaveBeenCalled()
  })
})

describe('startWasSync under a refused source', () => {
  it('installs nothing and caches nothing', async () => {
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    const remote = stubRemoteStore(
      { notes: descriptor, tasks: descriptor },
      { plainSource: true }
    )
    const localStore = {
      applyRemoteDescriptor: vi.fn(async () => {}),
      applyCollectionMeta: vi.fn(async () => {}),
      setDescriptorSource: vi.fn()
    }
    const syncController = { start: vi.fn(async () => {}) }
    const fetched = vi.fn()
    try {
      await startWasSync({
        parsed,
        zcapClient,
        collections,
        localStore: localStore as unknown as LocalStore,
        syncController: syncController as unknown as SyncController,
        onRemoteChange: () => {},
        onDescriptorsFetched: fetched
      })
    } finally {
      setLogger(previous)
    }
    expect(localStore.applyRemoteDescriptor).not.toHaveBeenCalled()
    expect(localStore.applyCollectionMeta).not.toHaveBeenCalled()
    expect(fetched).toHaveBeenCalledWith({})
    expect(
      capture.events.filter(
        event =>
          event.level === 'warn' &&
          event.err instanceof UnverifiedDescriptorError
      )
    ).toHaveLength(2)
    // The refused source is still the one installed for later refreshes: it
    // is refused there too, as itself.
    expect(localStore.setDescriptorSource).toHaveBeenCalledWith(
      remote.descriptorSource
    )
  })
})

describe('startWasSync descriptor read failure', () => {
  it('skips the failed collection entirely and bootstraps the rest', async () => {
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    const remote = stubRemoteStore({
      notes: descriptor,
      tasks: new Error('descriptor read failed')
    })
    const localStore = {
      applyRemoteDescriptor: vi.fn(async () => {}),
      applyCollectionMeta: vi.fn(async () => {}),
      setDescriptorSource: vi.fn()
    }
    const syncController = { start: vi.fn(async () => {}) }
    const fetched = vi.fn()

    await startWasSync({
      parsed,
      zcapClient,
      collections,
      localStore: localStore as unknown as LocalStore,
      syncController: syncController as unknown as SyncController,
      onRemoteChange: () => {},
      onDescriptorsFetched: fetched
    })

    // The readable collection went through the whole per-collection pass.
    expect(localStore.applyRemoteDescriptor).toHaveBeenCalledWith({
      collectionId: 'notes',
      encryption: descriptor
    })
    expect(
      remote.declareCollectionIndexes.mock.calls.map(([id]) => id)
    ).toEqual(['notes'])
    // The failed one received neither a cipher rebuild nor any PUT, and did
    // not enter the offline cache as "no descriptor".
    expect(fetched).toHaveBeenCalledWith({ notes: descriptor })
    expect(
      capture.events.some(
        event =>
          event.level === 'warn' &&
          event.data?.collectionId === 'tasks' &&
          event.err instanceof Error
      )
    ).toBe(true)
    setLogger(previous)
    // Replication still starts.
    expect(syncController.start).toHaveBeenCalledTimes(1)
  })
})

describe('startWasSync hook failure', () => {
  it('costs the collection whose cipher rebuild throws, and replicates the rest', async () => {
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    const remote = stubRemoteStore({ notes: descriptor, tasks: descriptor })
    // The served roster lists epochs and leaves this app out: the rebuild is
    // where that surfaces, as `KeyUnwrapError`.
    const rotatedOff = new KeyUnwrapError('no key for epoch e0')
    const localStore = {
      applyRemoteDescriptor: vi.fn(
        async ({ collectionId }: { collectionId: string }) => {
          if (collectionId === 'tasks') {
            throw rotatedOff
          }
        }
      ),
      applyCollectionMeta: vi.fn(async () => {}),
      setDescriptorSource: vi.fn()
    }
    const syncController = { start: vi.fn(async () => {}) }
    const fetched = vi.fn()

    await startWasSync({
      parsed,
      zcapClient,
      collections,
      localStore: localStore as unknown as LocalStore,
      syncController: syncController as unknown as SyncController,
      onRemoteChange: () => {},
      onDescriptorsFetched: fetched
    })

    // The other collection went through the whole per-collection pass, and
    // the failed one took no declaration write after its rebuild threw.
    expect(
      remote.declareCollectionIndexes.mock.calls.map(([id]) => id)
    ).toEqual(['notes'])
    // Everything after the pass still ran: the descriptor source, the offline
    // cache (without the roster this app cannot open), and replication.
    expect(localStore.setDescriptorSource).toHaveBeenCalledTimes(1)
    expect(fetched).toHaveBeenCalledWith({ notes: descriptor })
    expect(syncController.start).toHaveBeenCalledTimes(1)
    expect(
      capture.events.some(
        event =>
          event.level === 'warn' &&
          event.data?.collectionId === 'tasks' &&
          event.err === rotatedOff
      )
    ).toBe(true)
    setLogger(previous)
  })
})

describe('startWasSync blinded-index schema install', () => {
  const blinded = {
    ...descriptor,
    hmac: { id: 'urn:hmac', type: 'Sha256HmacKey2019' }
  } as unknown as CollectionEncryption

  /**
   * Runs the bootstrap over inert fakes and hands back what it touched.
   */
  async function bootstrap(
    knownDescriptors?: Record<string, CollectionEncryption>
  ) {
    const localStore = {
      applyRemoteDescriptor: vi.fn(async () => {}),
      applyCollectionMeta: vi.fn(async () => {}),
      setDescriptorSource: vi.fn()
    }
    const syncController = { start: vi.fn(async () => {}) }
    await startWasSync({
      parsed,
      zcapClient,
      collections,
      localStore: localStore as unknown as LocalStore,
      syncController: syncController as unknown as SyncController,
      onRemoteChange: () => {},
      ...(knownDescriptors && { knownDescriptors })
    })
    return { localStore, syncController }
  }

  it('installs the pre-read custom when the declaration wrote nothing', async () => {
    const remote = stubRemoteStore({ notes: blinded, tasks: undefined })
    const { localStore } = await bootstrap()

    // One read per granted collection, the pass's own, and no second one: the
    // object read before the declaration is still current.
    expect(
      remote.readCollectionMeta.mock.calls.map(([id]) => id).sort()
    ).toEqual(['notes', 'tasks'])
    expect(localStore.applyCollectionMeta).toHaveBeenCalledTimes(1)
    expect(localStore.applyCollectionMeta).toHaveBeenCalledWith({
      collectionId: 'notes',
      custom: stored
    })
    // The declaration was handed that same object.
    expect(remote.declareCollectionIndexes).toHaveBeenCalledWith('tasks', {
      current: expect.objectContaining({ etag: '"v1"' })
    })
  })

  it('re-reads the object when the declaration wrote', async () => {
    const remote = stubRemoteStore(
      { notes: blinded, tasks: undefined },
      { wrote: true }
    )
    const { localStore } = await bootstrap()

    // The declaration replaced `custom`, so the pre-read copy is stale and the
    // install reads again -- for that collection only.
    expect(
      remote.readCollectionMeta.mock.calls.map(([id]) => id).sort()
    ).toEqual(['notes', 'notes', 'tasks'])
    expect(localStore.applyCollectionMeta).toHaveBeenCalledTimes(1)
  })

  it('reads for the install when a known descriptor skipped the pass read', async () => {
    const remote = stubRemoteStore({ notes: blinded, tasks: undefined })
    const { localStore } = await bootstrap({ notes: blinded })

    // `notes` was not read by the pass (its descriptor was known), so the
    // install is the one read it gets; the declarations ran without an object.
    expect(
      remote.readCollectionMeta.mock.calls.map(([id]) => id).sort()
    ).toEqual(['notes', 'tasks'])
    expect(localStore.applyCollectionMeta).toHaveBeenCalledWith({
      collectionId: 'notes',
      custom: stored
    })
  })

  it('warns and skips the install when the re-read fails', async () => {
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    const remote = stubRemoteStore(
      { notes: blinded, tasks: undefined },
      { wrote: true }
    )
    // The pass's read answers; the install's re-read of `notes` (its second
    // read, the pass runs the collections concurrently) does not.
    const answer = remote.readCollectionMeta.getMockImplementation()!
    let notesReads = 0
    remote.readCollectionMeta.mockImplementation(async collectionId => {
      if (collectionId === 'notes' && ++notesReads === 2) {
        throw new Error('meta read failed')
      }
      return answer(collectionId)
    })
    const { localStore, syncController } = await bootstrap()

    expect(localStore.applyCollectionMeta).not.toHaveBeenCalled()
    expect(
      capture.events.some(
        event =>
          event.level === 'warn' &&
          event.msg.includes('Blinded-index schema install failed') &&
          event.data?.collectionId === 'notes' &&
          event.err instanceof Error
      )
    ).toBe(true)
    setLogger(previous)
    // The rest of the pass and replication are untouched.
    expect(
      remote.declareCollectionIndexes.mock.calls.map(([id]) => id).sort()
    ).toEqual(['notes', 'tasks'])
    expect(syncController.start).toHaveBeenCalledTimes(1)
  })
})
