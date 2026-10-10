/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The `WasRemoteStore` stand-in shared by the shared-collection and
 * standing-credential suites: scripted encryption descriptors plus an
 * in-memory resource map, served through the same `was.space().collection()`
 * handle chain `SharedCollectionReader` walks. One copy, so a change to the
 * changes-feed shape lands in both suites at once.
 */
import { Collection, NotImplementedError } from '@interop/was-client'
import type { CollectionEncryption } from '@interop/was-client'
import type { WasRemoteStore } from '../../src/storage/wasRemoteStore.js'

/**
 * One entry of the fake `changes` feed: a Resource (a live document with its
 * stored body, or a tombstone) by default, or another record `kind` named by
 * URL. A Resource is JSON unless `contentType` says otherwise, and its `data`
 * rides inline only while it is live JSON, as on the wire.
 */
export interface FakeChange {
  id: string
  kind?: string
  contentType?: string
  data?: unknown
  deleted?: boolean
}

/**
 * The probes a test reads back off the fake.
 */
export interface FakeRemoteStoreProbes {
  encryptionReads: () => number
  resourceGets: () => number
  checkpointsRequested: () => Array<string | undefined>
}

/**
 * Builds the stand-in. The handle's `documents()` walk is the real one,
 * borrowed off `Collection.prototype`, over this fake's `changes` feed.
 *
 * Supply `changes` to script a feed (paged at whatever `limit` the reader asks
 * for) or `changesNotImplemented` to make the backend answer as one without
 * the `changes-query` feature, forcing the `list()` + `get()` fallback. With
 * neither, the feed mirrors `resources`.
 *
 * `descriptors` scripts successive `readCollectionEncryption` answers (the
 * last one repeats), so an unknown-epoch refresh can be observed;
 * `encryptionReads` counts them. `encryption` is the one-descriptor shorthand.
 *
 * @param options {object}
 * @param options.collectionId {string}
 * @param [options.spaceId] {string}
 * @param [options.encryption] {CollectionEncryption}
 * @param [options.descriptors] {Array<CollectionEncryption | undefined>}
 * @param options.resources {object}
 * @param [options.changes] {FakeChange[]}
 * @param [options.changesNotImplemented] {boolean}
 * @returns {WasRemoteStore & FakeRemoteStoreProbes}
 */
export function fakeRemoteStore({
  collectionId,
  spaceId = 'space-1',
  encryption,
  descriptors,
  resources,
  changes,
  changesNotImplemented = false
}: {
  collectionId: string
  spaceId?: string
  encryption?: CollectionEncryption
  descriptors?: Array<CollectionEncryption | undefined>
  resources: Record<string, unknown>
  changes?: FakeChange[]
  changesNotImplemented?: boolean
}): WasRemoteStore & FakeRemoteStoreProbes {
  const feed: FakeChange[] =
    changes ?? Object.entries(resources).map(([id, data]) => ({ id, data }))
  const scripted = descriptors ?? [encryption]
  let encryptionReads = 0
  let resourceGets = 0
  const checkpointsRequested: Array<string | undefined> = []

  const collection = {
    id: collectionId,
    resourceChanges: Collection.prototype.resourceChanges,
    documents: Collection.prototype.documents,
    async list() {
      return {
        items: Object.keys(resources).map(id => ({ id, url: `./${id}` }))
      }
    },
    async get(resourceId: string) {
      resourceGets++
      return resources[resourceId] ?? null
    },
    async changes({
      checkpoint,
      limit
    }: {
      checkpoint?: string
      limit?: number
    }) {
      if (changesNotImplemented) {
        throw new NotImplementedError(
          'This backend does not support the "changes-query" feature.'
        )
      }
      checkpointsRequested.push(checkpoint)
      // The fake checkpoint is a feed POSITION, not a resource id: the feed can
      // carry the same id twice (a write and its later tombstone), so an
      // id-keyed resume would be ambiguous.
      const start = checkpoint ? Number(checkpoint) : 0
      const size = limit ?? feed.length
      const page = feed.slice(start, start + size)
      return {
        // Only the members the walk reads (`kind`, `deleted`, `contentType`,
        // `id`, `data`) are synthesized; the server's write stamp is not.
        documents: page.map(entry => {
          const kind = entry.kind ?? 'resource'
          const deleted = entry.deleted === true
          const contentType = entry.contentType ?? 'application/json'
          const liveJson =
            kind === 'resource' &&
            !deleted &&
            contentType === 'application/json'
          return {
            id: entry.id,
            kind,
            deleted,
            ...(kind === 'resource' && { contentType }),
            ...(liveJson && entry.data !== undefined && { data: entry.data })
          }
        }),
        checkpoint: page.length > 0 ? String(start + page.length) : null
      }
    }
  }

  return {
    spaceId,
    was: {
      space() {
        return {
          collection() {
            return collection
          }
        }
      }
    },
    collectionCapability() {
      return { id: 'urn:zcap:delegated:1' }
    },
    async readCollectionEncryption() {
      const descriptor =
        scripted[Math.min(encryptionReads, scripted.length - 1)]
      encryptionReads++
      return descriptor
    },
    encryptionReads: () => encryptionReads,
    resourceGets: () => resourceGets,
    checkpointsRequested: () => checkpointsRequested
  } as unknown as WasRemoteStore & FakeRemoteStoreProbes
}
