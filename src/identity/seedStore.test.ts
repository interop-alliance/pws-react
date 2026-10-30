/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the descriptor cache over a seed store: the controller stamp
 * that scopes the cached blob to one identity, and the bulk read/write pair
 * that does a whole bring-up phase in one blob operation.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { CollectionEncryption } from '@interop/pws-client'
import { createDescriptorCache, type SeedStore } from './seedStore.js'

const controller = 'did:key:zAlice'

function descriptor(epoch: string): CollectionEncryption {
  return {
    currentEpoch: epoch,
    epochs: [{ id: epoch }]
  } as unknown as CollectionEncryption
}

/**
 * An in-memory {@link SeedStore}: only the descriptor record is exercised here.
 */
function fakeSeedStore(): SeedStore {
  const records: Record<string, unknown> = {}
  return {
    dbName: 'fake',
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
      return records.descriptors ?? null
    },
    async clearSeedStore() {
      for (const key of Object.keys(records)) {
        delete records[key]
      }
    }
  }
}

describe('createDescriptorCache bulk operations', () => {
  it('reads an empty set before anything is written', async () => {
    const cache = createDescriptorCache({ store: fakeSeedStore(), controller })

    expect(await cache.readAllDescriptors()).toEqual({})
  })

  it('writes a whole set and reads it back in one blob read', async () => {
    const cache = createDescriptorCache({ store: fakeSeedStore(), controller })
    const descriptors = { notes: descriptor('e0'), tasks: descriptor('e1') }

    await cache.writeDescriptors({ descriptors })

    expect(await cache.readAllDescriptors()).toEqual(descriptors)
  })

  it('merges rather than clobbering entries written per collection', async () => {
    const cache = createDescriptorCache({ store: fakeSeedStore(), controller })

    await cache.writeDescriptor({
      collectionId: 'notes',
      descriptor: descriptor('e0')
    })
    await cache.writeDescriptors({
      descriptors: { tasks: descriptor('e1') }
    })
    await cache.writeDescriptor({
      collectionId: 'posts',
      descriptor: descriptor('e2')
    })

    expect(await cache.readAllDescriptors()).toEqual({
      notes: descriptor('e0'),
      tasks: descriptor('e1'),
      posts: descriptor('e2')
    })
  })

  it('serializes concurrent bulk and per-collection writes', async () => {
    const cache = createDescriptorCache({ store: fakeSeedStore(), controller })

    await Promise.all([
      cache.writeDescriptors({ descriptors: { notes: descriptor('e0') } }),
      cache.writeDescriptor({
        collectionId: 'tasks',
        descriptor: descriptor('e1')
      }),
      cache.writeDescriptors({ descriptors: { posts: descriptor('e2') } })
    ])

    expect(Object.keys(await cache.readAllDescriptors()).sort()).toEqual([
      'notes',
      'posts',
      'tasks'
    ])
  })

  it('reads empty under a different controller, and overwrites its stamp', async () => {
    const store = fakeSeedStore()
    const alice = createDescriptorCache({ store, controller })
    await alice.writeDescriptors({
      descriptors: { notes: descriptor('e0') }
    })

    const bob = createDescriptorCache({ store, controller: 'did:key:zBob' })
    expect(await bob.readAllDescriptors()).toEqual({})

    // Bob's first write claims the blob; Alice's entries are gone with it.
    await bob.writeDescriptors({ descriptors: { tasks: descriptor('e1') } })
    expect(await bob.readAllDescriptors()).toEqual({ tasks: descriptor('e1') })
    expect(await alice.readAllDescriptors()).toEqual({})
  })
})
