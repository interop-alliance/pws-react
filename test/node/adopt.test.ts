/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the adoption merge (`mergeAdopted`), driving two real
 * (fake-indexeddb) LocalStore instances directly: payloads are collected out of
 * a source replica with `listEntities` and merged into a separate connected
 * replica, exercising each branch of the per-uuid LWW policy (insert / update /
 * skip) and the stamping of payloads that arrive without their LWW fields.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { mintRecordEncryption } from '../../src/index.js'
import { LocalStore } from '../../src/storage/localStore.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { mergeAdopted } from '../../src/storage/adopt.js'
import type { WasCollectionConfig } from '../../src/config.js'

const COLLECTIONS: WasCollectionConfig[] = [{ key: 'notes', id: 'notes' }]
const COLLECTION = 'notes'
const MERGE_CLIENT_ID = 'merge-client'

interface Note {
  id: string
  title: string
  updatedAt?: string
  writerId?: string
}

let dbCounter = 0
const openStores: LocalStore[] = []

async function openStore(seedByte: number): Promise<LocalStore> {
  const { keyAgreementKey, keyResolver } = await deriveIdentity({
    seed: new Uint8Array(32).fill(seedByte)
  })
  const store = await LocalStore.init({
    keyAgreementKey,
    keyResolver,
    collections: COLLECTIONS,
    dbName: `was-react-adopt-${++dbCounter}`,
    // Epoch-from-birth: each replica's private collection needs an
    // epoch-bearing descriptor sealed to its own identity KAK.
    descriptors: {
      [COLLECTION]: await mintRecordEncryption({ keyAgreementKey })
    }
  })
  openStores.push(store)
  return store
}

/**
 * Collects every decrypted payload out of `store`, shaped as the adoption
 * mechanism collects it from the anonymous replica.
 */
async function collect(store: LocalStore): Promise<Record<string, Note[]>> {
  return { [COLLECTION]: await store.listEntities<Note>(COLLECTION) }
}

afterEach(async () => {
  while (openStores.length > 0) {
    await openStores.pop()!.remove()
  }
})

describe('mergeAdopted', () => {
  it('inserts a uuid the connected replica lacks', async () => {
    const source = await openStore(1)
    const connected = await openStore(2)
    const note: Note = {
      id: crypto.randomUUID(),
      title: 'alpha',
      updatedAt: '2026-01-01T00:00:00.000Z',
      writerId: 'device-a'
    }
    await source.insertEntity(COLLECTION, note)

    await mergeAdopted({
      store: connected,
      entities: await collect(source),
      writerId: MERGE_CLIENT_ID
    })

    const listed = await connected.listEntities<Note>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(note)
  })

  it('stamps an adopted payload that arrives without its LWW fields', async () => {
    const source = await openStore(1)
    const connected = await openStore(2)
    await source.insertEntity(COLLECTION, {
      id: crypto.randomUUID(),
      title: 'unstamped'
    })

    await mergeAdopted({
      store: connected,
      entities: await collect(source),
      writerId: MERGE_CLIENT_ID
    })

    const listed = await connected.listEntities<Note>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('unstamped')
    expect(typeof listed[0]!.updatedAt).toBe('string')
    expect(listed[0]!.updatedAt!.length).toBeGreaterThan(0)
    // The stamp carries the session's one resolved writer id.
    expect(listed[0]!.writerId).toBe(MERGE_CLIENT_ID)
  })

  it('preserves the original LWW fields of a payload that already carries them', async () => {
    const source = await openStore(1)
    const connected = await openStore(2)
    const note: Note = {
      id: crypto.randomUUID(),
      title: 'dated',
      updatedAt: '2025-05-05T00:00:00.000Z',
      writerId: 'device-original'
    }
    await source.insertEntity(COLLECTION, note)

    await mergeAdopted({
      store: connected,
      entities: await collect(source),
      writerId: MERGE_CLIENT_ID
    })

    const listed = await connected.listEntities<Note>(COLLECTION)
    expect(listed[0]!.updatedAt).toBe('2025-05-05T00:00:00.000Z')
    expect(listed[0]!.writerId).toBe('device-original')
  })

  it('keeps updatedAt and fills only the missing writerId', async () => {
    const source = await openStore(1)
    const connected = await openStore(2)
    await source.insertEntity(COLLECTION, {
      id: crypto.randomUUID(),
      title: 'half-stamped',
      updatedAt: '2025-05-05T00:00:00.000Z'
    })

    await mergeAdopted({
      store: connected,
      entities: await collect(source),
      writerId: MERGE_CLIENT_ID
    })

    const listed = await connected.listEntities<Note>(COLLECTION)
    expect(listed).toHaveLength(1)
    // The edit's own instant survives; only the absent field is filled.
    expect(listed[0]!.updatedAt).toBe('2025-05-05T00:00:00.000Z')
    expect(listed[0]!.writerId).toBe(MERGE_CLIENT_ID)
  })

  it('keeps writerId and fills only the missing updatedAt', async () => {
    const source = await openStore(1)
    const connected = await openStore(2)
    await source.insertEntity(COLLECTION, {
      id: crypto.randomUUID(),
      title: 'half-stamped',
      writerId: 'device-original'
    })

    await mergeAdopted({
      store: connected,
      entities: await collect(source),
      writerId: MERGE_CLIENT_ID
    })

    const listed = await connected.listEntities<Note>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(typeof listed[0]!.updatedAt).toBe('string')
    expect(listed[0]!.updatedAt!.length).toBeGreaterThan(0)
    expect(listed[0]!.writerId).toBe('device-original')
  })

  it('updates the existing doc when the adopted payload wins LWW', async () => {
    const source = await openStore(1)
    const connected = await openStore(2)
    const uuid = crypto.randomUUID()
    await connected.insertEntity(COLLECTION, {
      id: uuid,
      title: 'old',
      updatedAt: '2026-01-01T00:00:00.000Z',
      writerId: 'device-a'
    })
    await source.insertEntity(COLLECTION, {
      id: uuid,
      title: 'new',
      updatedAt: '2026-02-02T00:00:00.000Z',
      writerId: 'device-a'
    })

    await mergeAdopted({
      store: connected,
      entities: await collect(source),
      writerId: MERGE_CLIENT_ID
    })

    const listed = await connected.listEntities<Note>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('new')
  })

  it('breaks an updatedAt tie by the greater writerId', async () => {
    const source = await openStore(1)
    const connected = await openStore(2)
    const uuid = crypto.randomUUID()
    const at = '2026-03-03T00:00:00.000Z'
    await connected.insertEntity(COLLECTION, {
      id: uuid,
      title: 'a-loses',
      updatedAt: at,
      writerId: 'device-a'
    })
    await source.insertEntity(COLLECTION, {
      id: uuid,
      title: 'z-wins',
      updatedAt: at,
      writerId: 'device-z'
    })

    await mergeAdopted({
      store: connected,
      entities: await collect(source),
      writerId: MERGE_CLIENT_ID
    })

    const listed = await connected.listEntities<Note>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('z-wins')
  })

  it('skips the adopted payload when the existing doc wins LWW', async () => {
    const source = await openStore(1)
    const connected = await openStore(2)
    const uuid = crypto.randomUUID()
    await connected.insertEntity(COLLECTION, {
      id: uuid,
      title: 'keep',
      updatedAt: '2026-02-02T00:00:00.000Z',
      writerId: 'device-a'
    })
    await source.insertEntity(COLLECTION, {
      id: uuid,
      title: 'stale',
      updatedAt: '2026-01-01T00:00:00.000Z',
      writerId: 'device-a'
    })

    await mergeAdopted({
      store: connected,
      entities: await collect(source),
      writerId: MERGE_CLIENT_ID
    })

    const listed = await connected.listEntities<Note>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('keep')
  })

  it('overrides an existing doc without LWW fields with a stamped adopted one', async () => {
    const source = await openStore(1)
    const connected = await openStore(2)
    const uuid = crypto.randomUUID()
    await connected.insertEntity(COLLECTION, { id: uuid, title: 'unstamped' })
    await source.insertEntity(COLLECTION, { id: uuid, title: 'adopted' })

    await mergeAdopted({
      store: connected,
      entities: await collect(source),
      writerId: MERGE_CLIENT_ID
    })

    const listed = await connected.listEntities<Note>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('adopted')
  })
})
