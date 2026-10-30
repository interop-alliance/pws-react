/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Round-trip tests for the local encrypted store: the app's real identity
 * X25519 key drives the pws-client EDV codec end to end through RxDB (Dexie
 * storage on fake-indexeddb). Asserts create / list / in-place update (envelope id stable,
 * sequence advances) / delete, and that the at-rest row is ciphertext only. A
 * second block covers PUBLIC (plaintext) collections: payloads stored as-is
 * under their own logical id, alongside a private collection in the same store.
 * A third covers the row-level key-epoch stamp: a write persists the epoch it
 * sealed under, and a re-encrypt replaces a stale one (so the push keeps the
 * server's stamp in step).
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../../src/log.js'
import {
  mintHmacKey,
  ownerRecipient,
  wrapEpochSecret
} from '@interop/pws-client/edv'
import type { CollectionEncryption } from '@interop/pws-client'
import { isIntegrityError } from '@interop/pws-client/sync'
import type { Json } from '@interop/pws-sync'
import type { IKeyAgreementKey } from '@interop/data-integrity-core'
import { LocalStore } from '../../src/storage/localStore.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import type { PwsCollectionConfig } from '../../src/config.js'
import { encodeIndexSchemaMeta } from '../fixtures/indexSchemaMeta.js'
import { FOREIGN_SEED, mintRoster, rotateRoster } from '../fixtures/roster.js'

// A neutral test collection registry (not any app's real collections).
const COLLECTIONS: PwsCollectionConfig[] = [{ key: 'notes', id: 'notes' }]
const COLLECTION = 'notes'

// A mixed registry: the private collection above plus a public (plaintext) one.
const MIXED: PwsCollectionConfig[] = [
  { key: 'notes', id: 'notes' },
  { key: 'posts', id: 'microblog-posts', visibility: 'public' }
]
const PUBLIC_COLLECTION = 'posts'

// A fixed 32-byte master seed drives the deterministic identity derivation.
const SEED = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff)

interface NoteDoc {
  id: string
  title: string
  done: boolean
  category: string
  createdAt: string
  updatedAt: string
  writerId: string
}

let dbCounter = 0
const openStores: LocalStore[] = []

/**
 * The app's identity KAK + resolver, derived once from the fixed test seed:
 * the key material every private collection's cipher is built on.
 */
async function identityKeys() {
  const { keyAgreementKey, keyResolver } = await deriveIdentity({ seed: SEED })
  return { keyAgreementKey, keyResolver }
}

async function openStore(
  dbName: string,
  collections: PwsCollectionConfig[] = COLLECTIONS,
  descriptors?: Record<string, CollectionEncryption>
): Promise<LocalStore> {
  // Epoch-from-birth: a private collection only gets a real cipher from an
  // epoch-bearing descriptor, so unless a test supplies its own set, use one
  // shared minted descriptor per private collection (as the offline cache
  // would hold after any synced session). Shared -- not re-minted per open --
  // so a reopened store still holds the epoch its rows were sealed under.
  const withDefaults =
    descriptors ??
    Object.fromEntries(
      await Promise.all(
        collections
          .filter(config => config.visibility !== 'public')
          .map(async config => [config.id, await defaultDescriptor(config.id)])
      )
    )
  const store = await LocalStore.init({
    ...(await identityKeys()),
    collections,
    dbName,
    descriptors: withDefaults
  })
  openStores.push(store)
  return store
}

// The memoized per-collection default descriptors `openStore` falls back to.
const defaultDescriptors = new Map<string, Promise<CollectionEncryption>>()

function defaultDescriptor(
  collectionId: string
): Promise<CollectionEncryption> {
  let pending = defaultDescriptors.get(collectionId)
  if (!pending) {
    pending = mintDescriptor()
    defaultDescriptors.set(collectionId, pending)
  }
  return pending
}

/**
 * A one-epoch encryption descriptor whose sole recipient is the app's identity
 * KAK, minted over the shared roster fixture (the same shape the offline
 * descriptor cache holds).
 */
async function mintDescriptor(): Promise<CollectionEncryption> {
  const { keyAgreementKey } = await identityKeys()
  return mintRoster({ recipients: [ownerRecipient({ keyAgreementKey })] })
}

/**
 * The single at-rest ROW of a collection (envelope plus its sync metadata).
 */
async function rawRow(
  store: LocalStore
): Promise<{ id: string; epoch?: string }> {
  const rows = await store.rxCollection(COLLECTION).find().exec()
  expect(rows).toHaveLength(1)
  return rows[0]!.toMutableJSON() as unknown as { id: string; epoch?: string }
}

function makeNote(title: string): NoteDoc {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    title,
    done: false,
    category: 'someday',
    createdAt: now,
    updatedAt: now,
    writerId: 'writer-a'
  }
}

/**
 * The single at-rest envelope in a collection, read raw (undecrypted).
 */
async function rawEnvelope(
  store: LocalStore
): Promise<{ id: string; sequence: number; jwe: unknown }> {
  const rows = await store.rxCollection(COLLECTION).find().exec()
  expect(rows).toHaveLength(1)
  return rows[0]!.toMutableJSON().data as unknown as {
    id: string
    sequence: number
    jwe: unknown
  }
}

afterEach(async () => {
  while (openStores.length > 0) {
    await openStores.pop()!.close()
  }
})

describe('LocalStore entity CRUD', () => {
  it('round-trips insert / list and stores only ciphertext', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Buy distinctive-oat-milk-token')

    await store.insertEntity(COLLECTION, note)

    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(note)

    const envelope = await rawEnvelope(store)
    expect(typeof envelope.jwe).toBe('object')
    expect(envelope.jwe).not.toBeNull()
    // No plaintext field value leaks into the stored row.
    expect(JSON.stringify(envelope)).not.toContain('distinctive-oat-milk-token')
    expect(JSON.stringify(envelope)).not.toContain('someday')
  })

  it('re-encrypts in place: same envelope id, advancing sequence', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('First title')
    await store.insertEntity(COLLECTION, note)

    const before = await rawEnvelope(store)

    const updated: NoteDoc = {
      ...note,
      title: 'Second title',
      done: true,
      updatedAt: new Date().toISOString()
    }
    await store.updateEntity(COLLECTION, updated)

    const after = await rawEnvelope(store)
    // Same physical envelope (stable random EDV id), advanced sequence.
    expect(after.id).toBe(before.id)
    expect(after.sequence).toBeGreaterThan(before.sequence)

    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('Second title')
    expect(listed[0]!.done).toBe(true)
  })

  it('tombstones on delete', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Ephemeral')
    await store.insertEntity(COLLECTION, note)
    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(1)

    await store.deleteEntity(COLLECTION, note.id)

    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(0)
    const rows = await store.rxCollection(COLLECTION).find().exec()
    expect(rows).toHaveLength(0)
  })

  it('leaves a row a pull already tombstoned alone on delete', async () => {
    // The row is tombstoned under `deleteEntity` (a remote delete pulled
    // between the lookup and the removal); a second tombstone revision would
    // replicate as a redundant delete.
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Ephemeral')
    await store.insertEntity(COLLECTION, note)
    const envelopeId = store.envelopeIdFor(COLLECTION, note.id)!
    const row = (await store
      .rxCollection(COLLECTION)
      .findOne(envelopeId)
      .exec())!
    await row.incrementalRemove()
    const revision = row.getLatest().revision

    await store.deleteEntity(COLLECTION, note.id)

    expect(row.getLatest().revision).toBe(revision)
    expect(store.envelopeIdFor(COLLECTION, note.id)).toBeUndefined()
  })

  it('upserts: inserts once then updates in place under a stable envelope', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Upserted')
    // Hydrate first so the index exists (a singleton store hydrates before it
    // ever writes).
    await store.listEntities<NoteDoc>(COLLECTION)

    await store.upsertEntity(COLLECTION, note)
    const first = await rawEnvelope(store)

    const edited: NoteDoc = { ...note, title: 'Upserted again' }
    await store.upsertEntity(COLLECTION, edited)
    const second = await rawEnvelope(store)

    // One row, same envelope id (update, not a second insert).
    expect(second.id).toBe(first.id)
    expect(second.sequence).toBeGreaterThan(first.sequence)
    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('Upserted again')
  })

  it('resurrects as a create when the envelope was deleted elsewhere', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Edited after remote delete')
    await store.insertEntity(COLLECTION, note)
    const original = await rawEnvelope(store)

    // Simulate a remote tombstone being pulled: the row is removed and the
    // uuid forgotten from the index (what forgetEnvelope + drop do).
    await store.deleteEntity(COLLECTION, note.id)
    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(0)

    // A concurrent local edit must not throw; it resurrects the entity.
    const edited: NoteDoc = {
      ...note,
      title: 'Resurrected',
      updatedAt: new Date().toISOString()
    }
    await store.updateEntity(COLLECTION, edited)

    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('Resurrected')
    // A fresh envelope was minted (the old one is gone).
    const resurrected = await rawEnvelope(store)
    expect(resurrected.id).not.toBe(original.id)
  })

  it('persists across a store reopen (survives reload)', async () => {
    const dbName = `was-react-test-${++dbCounter}`
    const store = await openStore(dbName)
    const note = makeNote('Durable note')
    await store.insertEntity(COLLECTION, note)
    await store.close()
    openStores.pop()

    const reopened = await openStore(dbName)
    const listed = await reopened.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(note)
  })

  it('remove() deletes the database: a re-init opens empty', async () => {
    const dbName = `was-react-test-${++dbCounter}`
    const store = await openStore(dbName)
    await store.insertEntity(COLLECTION, makeNote('Doomed note'))
    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(1)

    await store.remove()
    openStores.pop()

    // Re-init under the same name sees a fresh, empty database (remove deleted
    // the underlying store, unlike close which keeps the data).
    const reopened = await openStore(dbName)
    expect(await reopened.listEntities<NoteDoc>(COLLECTION)).toHaveLength(0)
  })
})

describe('LocalStore key-epoch stamping', () => {
  it('persists the epoch the envelope was sealed under onto the row', async () => {
    const encryption = await mintDescriptor()
    const store = await openStore(
      `was-react-test-${++dbCounter}`,
      COLLECTIONS,
      {
        [COLLECTION]: encryption
      }
    )
    const note = makeNote('Sealed under an epoch')

    await store.insertEntity(COLLECTION, note)
    // The stamp rides the content push as the `Key-Epoch` header.
    expect((await rawRow(store)).epoch).toBe(encryption.currentEpoch)

    // A re-encrypt under the same multi-recipient cipher keeps it.
    await store.updateEntity(COLLECTION, { ...note, title: 'Still sealed' })
    expect((await rawRow(store)).epoch).toBe(encryption.currentEpoch)
    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(1)
  })

  it('replaces a stale epoch stamp on re-encrypt', async () => {
    const encryption = await mintDescriptor()
    const store = await openStore(
      `was-react-test-${++dbCounter}`,
      COLLECTIONS,
      { [COLLECTION]: encryption }
    )
    const note = makeNote('Stamped once')
    await store.insertEntity(COLLECTION, note)
    expect((await rawRow(store)).epoch).toBe(encryption.currentEpoch)

    // Fake a stale stamp, as a pulled row written under a rotated-away epoch
    // would carry.
    const rows = await store.rxCollection(COLLECTION).find().exec()
    await rows[0]!.incrementalModify(docData => {
      docData.epoch = 'epoch-stale'
      return docData
    })
    expect((await rawRow(store)).epoch).toBe('epoch-stale')

    await store.updateEntity(COLLECTION, { ...note, title: 'Re-encrypted' })

    // The stale stamp is REPLACED by the epoch the re-encrypt sealed under,
    // so the push keeps the server's stamp in step with the envelope.
    expect((await rawRow(store)).epoch).toBe(encryption.currentEpoch)
  })
})

/**
 * The one-epoch descriptor with a blinded-index HMAC key installed -- the
 * searchable-collection fixture. The blinding key is distributed exactly like
 * an epoch key, so the same wrap builds it.
 */
async function mintIndexableDescriptor(): Promise<CollectionEncryption> {
  const { keyAgreementKey } = await identityKeys()
  const encryption = await mintDescriptor()
  const hmac = await mintHmacKey()
  return {
    ...encryption,
    hmac: {
      id: hmac.id,
      type: hmac.type,
      recipients: [
        await wrapEpochSecret({
          epochSecret: hmac.secret,
          recipient: ownerRecipient({ keyAgreementKey })
        })
      ]
    }
  }
}

/**
 * The blinded index entries the single at-rest envelope carries.
 */
async function rawIndexed(store: LocalStore): Promise<unknown[]> {
  const envelope = (await rawEnvelope(store)) as unknown as {
    indexed?: unknown[]
  }
  return envelope.indexed ?? []
}

/**
 * Wraps the identity KAK so that, while the gate is closed, every
 * `deriveSecret` (the epoch unwrap a cipher build runs) waits for it to open.
 * `reached()` resolves once a build has arrived at the gate, which is how a
 * test holds a cipher rebuild mid-build while it queues other work behind it.
 */
function gatedKey(keyAgreementKey: IKeyAgreementKey) {
  let closed = false
  let open = () => {}
  let opened = Promise.resolve()
  let arrived = () => {}
  let arrival = new Promise<void>(resolve => {
    arrived = resolve
  })
  const key = new Proxy(keyAgreementKey, {
    get(target, property, receiver) {
      if (property === 'deriveSecret') {
        return async (
          options: Parameters<IKeyAgreementKey['deriveSecret']>[0]
        ) => {
          if (closed) {
            arrived()
            await opened
          }
          return target.deriveSecret(options)
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return {
    key,
    close() {
      closed = true
      opened = new Promise<void>(resolve => {
        open = resolve
      })
      arrival = new Promise<void>(resolve => {
        arrived = resolve
      })
    },
    open() {
      closed = false
      open()
    },
    reached() {
      return arrival
    }
  }
}

/**
 * Opens a store on a gated KAK over one indexable descriptor.
 */
async function openGatedStore(
  keyAgreementKey: IKeyAgreementKey,
  encryption: CollectionEncryption
): Promise<LocalStore> {
  const { keyResolver } = await identityKeys()
  const store = await LocalStore.init({
    keyAgreementKey,
    keyResolver,
    collections: COLLECTIONS,
    dbName: `was-react-test-${++dbCounter}`,
    descriptors: { [COLLECTION]: encryption }
  })
  openStores.push(store)
  return store
}

/**
 * A one-epoch roster over this identity and a bystander, and the two-epoch
 * roster that rotating the bystander off grows it into.
 */
async function rotatedRosters(): Promise<{
  earlier: CollectionEncryption
  later: CollectionEncryption
}> {
  const { keyAgreementKey } = await identityKeys()
  const bystander = await deriveIdentity({ seed: FOREIGN_SEED })
  const bystanderRecipient = ownerRecipient({
    keyAgreementKey: bystander.keyAgreementKey
  })
  const earlier = await mintRoster({
    recipients: [ownerRecipient({ keyAgreementKey }), bystanderRecipient]
  })
  const later = await rotateRoster({
    descriptor: earlier,
    removeKid: bystanderRecipient.id
  })
  return { earlier, later }
}

/**
 * Two payloads of one singleton: an older loser and a newer winner.
 */
function duplicateSingletons(): { older: NoteDoc; newer: NoteDoc } {
  return {
    older: makeSingleton({
      title: 'older',
      updatedAt: '2026-01-01T00:00:00.000Z',
      writerId: 'writer-a'
    }),
    newer: makeSingleton({
      title: 'newer',
      updatedAt: '2026-02-02T00:00:00.000Z',
      writerId: 'writer-b'
    })
  }
}

/**
 * Seals two duplicates of one singleton under a rotated (two-epoch) roster,
 * then reopens the database on the one-epoch roster it grew from, so the
 * first decrypt of a hydrate waits on a descriptor refresh. `betweenInserts`
 * runs against the sealing store after the loser is in and before the winner
 * is, for a test that needs to stage a row edit.
 */
async function sealDuplicatesThenReopen({
  betweenInserts
}: {
  betweenInserts?: (staged: {
    sealing: LocalStore
    older: NoteDoc
    loserId: string
  }) => Promise<void>
} = {}): Promise<{
  store: LocalStore
  later: CollectionEncryption
  older: NoteDoc
  newer: NoteDoc
  loserId: string
  winnerId: string
}> {
  const { earlier, later } = await rotatedRosters()
  const dbName = `was-react-test-${++dbCounter}`
  const sealing = await openStore(dbName, COLLECTIONS, {
    [COLLECTION]: later
  })
  const { older, newer } = duplicateSingletons()
  await sealing.insertEntity(COLLECTION, older)
  const loserId = sealing.envelopeIdFor(COLLECTION, older.id)!
  await betweenInserts?.({ sealing, older, loserId })
  await sealing.insertEntity(COLLECTION, newer)
  const winnerId = sealing.envelopeIdFor(COLLECTION, newer.id)!
  expect(winnerId).not.toBe(loserId)
  await openStores.pop()!.close()
  const store = await openStore(dbName, COLLECTIONS, {
    [COLLECTION]: earlier
  })
  return { store, later, older, newer, loserId, winnerId }
}

describe('LocalStore.applyRemoteDescriptor', () => {
  it('does not swap an earlier head of the log back in over a later one', async () => {
    // Two reads of one governing log can settle in either order. Once the
    // cipher is on the rotated (two-epoch) roster, the one-epoch roster it
    // grew from is an earlier head and must be ignored, not installed.
    const { earlier, later } = await rotatedRosters()
    const store = await openStore(
      `was-react-test-${++dbCounter}`,
      COLLECTIONS,
      { [COLLECTION]: earlier }
    )

    expect(
      await store.applyRemoteDescriptor({
        collectionId: COLLECTION,
        encryption: later
      })
    ).toBe(true)
    expect(
      await store.applyRemoteDescriptor({
        collectionId: COLLECTION,
        encryption: earlier
      })
    ).toBe(false)

    await store.insertEntity(
      COLLECTION,
      makeNote('Sealed under the later epoch')
    )
    expect((await rawRow(store)).epoch).toBe(later.currentEpoch)
  })
})

describe('LocalStore.applyCollectionMeta', () => {
  it('ignores an unknown id and a public collection', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    expect(
      await store.applyCollectionMeta({ collectionId: 'no-such-collection' })
    ).toBe(false)
    expect(
      await store.applyCollectionMeta({ collectionId: 'microblog-posts' })
    ).toBe(false)
  })

  it('installs the schema so later writes carry blinded index entries', async () => {
    const encryption = await mintIndexableDescriptor()
    const store = await openStore(
      `was-react-test-${++dbCounter}`,
      COLLECTIONS,
      {
        [COLLECTION]: encryption
      }
    )
    const custom = await encodeIndexSchemaMeta({
      encryption,
      collectionId: COLLECTION,
      keys: await identityKeys()
    })

    expect(
      await store.applyCollectionMeta({ collectionId: COLLECTION, custom })
    ).toBe(true)

    await store.insertEntity(COLLECTION, makeNote('Indexed note'))
    expect(await rawIndexed(store)).toHaveLength(1)
  })

  it('re-installs the schema when the cipher is rebuilt', async () => {
    const encryption = await mintIndexableDescriptor()
    const store = await openStore(
      `was-react-test-${++dbCounter}`,
      COLLECTIONS,
      {
        [COLLECTION]: encryption
      }
    )
    await store.applyCollectionMeta({
      collectionId: COLLECTION,
      custom: await encodeIndexSchemaMeta({
        encryption,
        collectionId: COLLECTION,
        keys: await identityKeys()
      })
    })

    // A rotation elsewhere rebuilds the cipher; the schema is not a casualty.
    await store.rebuildCipher({ key: COLLECTION, encryption })

    await store.insertEntity(COLLECTION, makeNote('Still indexed'))
    expect(await rawIndexed(store)).toHaveLength(1)
  })

  it('serializes a schema install with a concurrent cipher rebuild', async () => {
    // A rebuild is held mid-build (its epoch unwrap is gated) with no schema
    // remembered when the install arrives. Without the chain the install
    // lands on the cipher the rebuild then replaces, and the replacement,
    // built before the schema was remembered, stamps nothing.
    const encryption = await mintIndexableDescriptor()
    const gate = gatedKey((await identityKeys()).keyAgreementKey)
    const store = await openGatedStore(gate.key, encryption)
    const custom = await encodeIndexSchemaMeta({
      encryption,
      collectionId: COLLECTION,
      keys: await identityKeys()
    })

    gate.close()
    const rebuilding = store.rebuildCipher({ key: COLLECTION, encryption })
    await gate.reached()
    const applying = store.applyCollectionMeta({
      collectionId: COLLECTION,
      custom
    })
    gate.open()
    await rebuilding
    expect(await applying).toBe(true)

    await store.insertEntity(COLLECTION, makeNote('Indexed either way'))
    expect(await rawIndexed(store)).toHaveLength(1)
  })

  it('keeps an unvalidated metadata value away from a rebuild queued ahead of it', async () => {
    // Two rebuilds are queued (the first held mid-build) when an install with
    // an undecodable value arrives. The value is remembered only inside the
    // chain, so the second rebuild builds without it and succeeds; the install
    // itself is what fails.
    const encryption = await mintIndexableDescriptor()
    const gate = gatedKey((await identityKeys()).keyAgreementKey)
    const store = await openGatedStore(gate.key, encryption)
    const foreign = await encodeIndexSchemaMeta({
      encryption,
      collectionId: 'other-collection',
      keys: await identityKeys()
    })

    gate.close()
    const first = store.rebuildCipher({ key: COLLECTION, encryption })
    await gate.reached()
    const second = store.rebuildCipher({ key: COLLECTION, encryption })
    const applying = store.applyCollectionMeta({
      collectionId: COLLECTION,
      custom: foreign
    })
    gate.open()
    await first
    await second
    await expect(applying).rejects.toThrow()

    await store.insertEntity(COLLECTION, makeNote('Still writable'))
    expect(await store.listEntities(COLLECTION)).toHaveLength(1)
  })

  it('remembers metadata applied while the placeholder cipher is held', async () => {
    // No cached descriptor: the collection opens fail-closed behind the
    // placeholder cipher, which has no schema to install.
    const store = await openStore(
      `was-react-test-${++dbCounter}`,
      COLLECTIONS,
      {}
    )
    const encryption = await mintIndexableDescriptor()
    expect(
      await store.applyCollectionMeta({
        collectionId: COLLECTION,
        custom: await encodeIndexSchemaMeta({
          encryption,
          collectionId: COLLECTION,
          keys: await identityKeys()
        })
      })
    ).toBe(true)

    // The first live descriptor read swaps in the real cipher, which picks the
    // remembered schema up.
    expect(
      await store.applyRemoteDescriptor({
        collectionId: COLLECTION,
        encryption
      })
    ).toBe(true)

    await store.insertEntity(COLLECTION, makeNote('Indexed after provisioning'))
    expect(await rawIndexed(store)).toHaveLength(1)
  })

  it('does not remember a metadata value the cipher cannot decode', async () => {
    const encryption = await mintIndexableDescriptor()
    const store = await openStore(
      `was-react-test-${++dbCounter}`,
      COLLECTIONS,
      {
        [COLLECTION]: encryption
      }
    )
    // A metadata envelope AEAD-bound to another collection is refused by the
    // cipher, and the failed value must not stay remembered: a poisoned memo
    // would make the next rebuild throw on a collection that reads fine.
    const foreign = await encodeIndexSchemaMeta({
      encryption,
      collectionId: 'other-collection',
      keys: await identityKeys()
    })
    await expect(
      store.applyCollectionMeta({ collectionId: COLLECTION, custom: foreign })
    ).rejects.toThrow()

    await store.rebuildCipher({ key: COLLECTION, encryption })
    await store.insertEntity(COLLECTION, makeNote('Unindexed but writable'))
    expect(await rawIndexed(store)).toHaveLength(0)
  })
})

/**
 * A singleton payload: one fixed logical id for the whole collection.
 */
function makeSingleton(
  over: Partial<NoteDoc> & Pick<NoteDoc, 'updatedAt' | 'writerId'>
): NoteDoc {
  return {
    id: '_singleton',
    title: 'current',
    done: false,
    category: 'selection',
    createdAt: over.updatedAt,
    ...over
  }
}

describe('LocalStore singleton hydration', () => {
  it('returns null and an empty collection when nothing is stored', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    expect(await store.hydrateSingleton<NoteDoc>(COLLECTION)).toBeNull()
  })

  it('reconciles duplicate singletons to the LWW winner and tombstones the rest', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    // Two clients each created the singleton before syncing: distinct envelope
    // rows that both decrypt to `_singleton`.
    const older = makeSingleton({
      title: 'older',
      updatedAt: '2026-01-01T00:00:00.000Z',
      writerId: 'writer-a'
    })
    const newer = makeSingleton({
      title: 'newer',
      updatedAt: '2026-02-02T00:00:00.000Z',
      writerId: 'writer-b'
    })
    await store.insertEntity(COLLECTION, older)
    await store.insertEntity(COLLECTION, newer)
    // Two physical rows, one logical id.
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(2)

    const winner = await store.hydrateSingleton<NoteDoc>(COLLECTION)
    expect(winner).toEqual(newer)
    // The loser row is tombstoned, so exactly one live row remains.
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(1)

    // A subsequent write routes as an in-place update on the surviving row (no
    // third envelope is minted).
    const moved: NoteDoc = { ...newer, title: 'moved' }
    await store.upsertEntity(COLLECTION, moved)
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(1)
    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('moved')
  })

  it('maps the logical id to the surviving envelope after reconciliation', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const older = makeSingleton({
      title: 'old',
      updatedAt: '2026-01-01T00:00:00.000Z',
      writerId: 'writer-a'
    })
    const newer = makeSingleton({
      title: 'new',
      updatedAt: '2026-02-02T00:00:00.000Z',
      writerId: 'writer-b'
    })
    await store.insertEntity(COLLECTION, older)
    await store.insertEntity(COLLECTION, newer)

    await store.hydrateSingleton<NoteDoc>(COLLECTION)
    // The index points at the one live row, so a tombstone for any OTHER
    // (reconciled-away) envelope can be told apart from a real deletion.
    const rows = await store.rxCollection(COLLECTION).find().exec()
    expect(rows).toHaveLength(1)
    expect(store.envelopeIdFor(COLLECTION, newer.id)).toBe(rows[0]!.id)
  })

  it('breaks an updatedAt tie by the greater writerId', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const at = '2026-03-03T00:00:00.000Z'
    await store.insertEntity(
      COLLECTION,
      makeSingleton({ title: 'a', updatedAt: at, writerId: 'writer-a' })
    )
    await store.insertEntity(
      COLLECTION,
      makeSingleton({ title: 'z', updatedAt: at, writerId: 'writer-z' })
    )

    const winner = await store.hydrateSingleton<NoteDoc>(COLLECTION)
    expect(winner!.writerId).toBe('writer-z')
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(1)
  })

  it('leaves a loser that a pull changed mid-hydrate to the next hydrate', async () => {
    // The decrypt window of a hydrate can include a descriptor refresh, and
    // a pull can land on a duplicate row meanwhile. Here the rows are sealed
    // under a rotated (two-epoch) roster, the store reopens on the one-epoch
    // roster it grew from, and the governed source the refresh asks writes a
    // newer envelope onto the loser row before answering. Removing the loser
    // through the stale RxDocument would conflict and reject the hydrate.
    let edited: NoteDoc | undefined
    let pulled: Json | undefined
    const { store, later, newer, loserId } = await sealDuplicatesThenReopen({
      betweenInserts: async ({ sealing, older, loserId }) => {
        const loserRow = async () =>
          (await sealing.rxCollection(COLLECTION).findOne(loserId).exec())!
        const stale = (await loserRow()).toMutableJSON().data
        // The edit a pull will land: the loser re-sealed with a stamp that
        // outranks the winner, captured and then set back to the stale
        // envelope.
        edited = {
          ...older,
          title: 'edited elsewhere',
          updatedAt: '2026-03-03T00:00:00.000Z'
        }
        await sealing.updateEntity(COLLECTION, edited)
        pulled = (await loserRow()).toMutableJSON().data
        await (await loserRow()).incrementalPatch({ data: stale })
      }
    })
    let refreshes = 0
    store.setDescriptorSource({
      verifiesHistory: true,
      collectionEncryption: async () => {
        refreshes += 1
        const loserRow = await store
          .rxCollection(COLLECTION)
          .findOne(loserId)
          .exec()
        await loserRow!.incrementalPatch({ data: pulled })
        return later
      }
    })

    await expect(store.hydrateSingleton<NoteDoc>(COLLECTION)).resolves.toEqual(
      newer
    )
    expect(refreshes).toBe(1)
    // The changed loser stands beside the winner rather than being tombstoned
    // on the strength of its stale envelope.
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(2)

    // The next hydrate weighs the pulled edit, which now wins.
    expect(await store.hydrateSingleton<NoteDoc>(COLLECTION)).toEqual(edited)
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(1)
  })

  it('skips a loser another client tombstoned under the decrypt, without a warning', async () => {
    // The pull lands a tombstone on the loser while the hydrate decrypts: the
    // end state the reconcile asks for already holds, so no conditional
    // write is spent on it and nothing is left to the next hydrate.
    const { store, later, newer, loserId } = await sealDuplicatesThenReopen()
    store.setDescriptorSource({
      verifiesHistory: true,
      collectionEncryption: async () => {
        const loserRow = await store
          .rxCollection(COLLECTION)
          .findOne(loserId)
          .exec()
        await loserRow!.incrementalRemove()
        return later
      }
    })

    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    try {
      expect(await store.hydrateSingleton<NoteDoc>(COLLECTION)).toEqual(newer)
    } finally {
      setLogger(previous)
    }
    expect(capture.events.filter(event => event.level === 'warn')).toEqual([])
    const live = await store.rxCollection(COLLECTION).find().exec()
    expect(live.map(row => row.id)).toEqual([
      store.envelopeIdFor(COLLECTION, newer.id)
    ])
  })

  it('tombstones no loser when the winner changed under the decrypt', async () => {
    // Same window as above, with the pull landing on the winner instead: the
    // row is tombstoned (deleted on another client) while the hydrate
    // decrypts, so the loser has not been weighed against anything that
    // still stands and is left alone.
    const { store, later, older, newer, loserId, winnerId } =
      await sealDuplicatesThenReopen()
    store.setDescriptorSource({
      verifiesHistory: true,
      collectionEncryption: async () => {
        const winnerRow = await store
          .rxCollection(COLLECTION)
          .findOne(winnerId)
          .exec()
        await winnerRow!.incrementalRemove()
        return later
      }
    })

    // The payload decrypted before the tombstone is still what this hydrate
    // answers; the change stream carries the deletion over it.
    expect(await store.hydrateSingleton<NoteDoc>(COLLECTION)).toEqual(newer)
    const live = await store.rxCollection(COLLECTION).find().exec()
    expect(live.map(row => row.id)).toEqual([loserId])
    // The next hydrate settles on what still stands.
    expect(await store.hydrateSingleton<NoteDoc>(COLLECTION)).toEqual(older)
    expect(store.envelopeIdFor(COLLECTION, older.id)).toBe(loserId)
  })
})

describe('LocalStore public (plaintext) collections', () => {
  it('stores the payload as-is under its own logical id', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('World-readable post')

    await store.insertEntity(PUBLIC_COLLECTION, post)

    const rows = await store.rxCollection(PUBLIC_COLLECTION).find().exec()
    expect(rows).toHaveLength(1)
    const row = rows[0]!.toMutableJSON()
    // One id plane: the row (PWS resource) id IS the payload uuid.
    expect(row.id).toBe(post.id)
    // The stored body is the payload verbatim -- no envelope, no ciphertext.
    expect(row.data).toEqual(post)

    const listed = await store.listEntities<NoteDoc>(PUBLIC_COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(post)
  })

  it('updates in place under the same row id', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('First revision')
    await store.insertEntity(PUBLIC_COLLECTION, post)

    const edited: NoteDoc = {
      ...post,
      title: 'Second revision',
      updatedAt: new Date().toISOString()
    }
    await store.updateEntity(PUBLIC_COLLECTION, edited)

    const rows = await store.rxCollection(PUBLIC_COLLECTION).find().exec()
    expect(rows).toHaveLength(1)
    const row = rows[0]!.toMutableJSON()
    // The resource URL stays stable across edits (same row id).
    expect(row.id).toBe(post.id)
    expect(row.data).toEqual(edited)
  })

  it('tombstones on delete and upserts without a prior hydrate', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('Short-lived')
    await store.upsertEntity(PUBLIC_COLLECTION, post)
    expect(await store.listEntities<NoteDoc>(PUBLIC_COLLECTION)).toHaveLength(1)

    await store.deleteEntity(PUBLIC_COLLECTION, post.id)
    expect(await store.listEntities<NoteDoc>(PUBLIC_COLLECTION)).toHaveLength(0)
  })

  it('keeps the private collection encrypted in the same store', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const secret = makeNote('secret-note-body')
    await store.insertEntity(COLLECTION, secret)

    const rows = await store.rxCollection(COLLECTION).find().exec()
    expect(rows).toHaveLength(1)
    const row = rows[0]!.toMutableJSON()
    // The private collection still stores an EDV envelope under a random id.
    expect(row.id).not.toBe(secret.id)
    expect(JSON.stringify(row.data)).not.toContain('secret-note-body')

    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(secret)
  })

  it('skips a row whose payload id does not match its row id, and hydrates the rest', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('Well-formed post')
    await store.insertEntity(PUBLIC_COLLECTION, post)
    // Written by something else holding a grant on the collection: one body
    // naming a different id than its resource id, one naming none.
    const now = new Date().toISOString()
    await store.rxCollection(PUBLIC_COLLECTION).bulkInsert([
      {
        id: 'resource-a',
        updatedAt: now,
        data: { id: 'some-other-id', title: 'mismatched' }
      },
      { id: 'resource-b', updatedAt: now, data: { title: 'no id' } }
    ])

    expect(await store.listEntities<NoteDoc>(PUBLIC_COLLECTION)).toEqual([post])
    // The raw decrypt path still fails hard on both: the leniency is the
    // caller's, not the cipher's.
    await expect(
      store.decryptEnvelope({
        key: PUBLIC_COLLECTION,
        id: 'resource-a',
        envelope: { id: 'some-other-id' }
      })
    ).rejects.toSatisfy(isIntegrityError)
    await expect(
      store.decryptEnvelope({
        key: PUBLIC_COLLECTION,
        id: 'resource-b',
        envelope: { title: 'no id' }
      })
    ).rejects.toSatisfy(isIntegrityError)
  })

  it('skips an EDV envelope stored in a public collection, and hydrates the rest', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('Well-formed post')
    await store.insertEntity(PUBLIC_COLLECTION, post)
    // A ciphertext row in a plaintext collection: a visibility
    // misconfiguration, or any grant holder writing `{ id, jwe }` there. Its
    // body is unchanged on every retry, so it must cost one row, not every
    // hydrate of the collection.
    const stray = { id: 'stray-envelope', jwe: {} }
    await store.rxCollection(PUBLIC_COLLECTION).insert({
      id: stray.id,
      updatedAt: new Date().toISOString(),
      data: stray
    })

    expect(await store.listEntities<NoteDoc>(PUBLIC_COLLECTION)).toEqual([post])
    // The raw decrypt path still refuses it, as the same integrity failure a
    // mis-bound id is.
    await expect(
      store.decryptEnvelope({
        key: PUBLIC_COLLECTION,
        id: stray.id,
        envelope: stray
      })
    ).rejects.toSatisfy(isIntegrityError)
  })

  it('rejects a registry mapping one PWS id to both visibilities', async () => {
    await expect(
      LocalStore.init({
        ...(await identityKeys()),
        collections: [
          { key: 'a', id: 'shared' },
          { key: 'b', id: 'shared', visibility: 'public' }
        ],
        dbName: `was-react-test-${++dbCounter}`
      })
    ).rejects.toThrow(/encrypted and public/)
  })
})

describe('LocalStore LWW conflict-handler decrypt closure', () => {
  it('decrypts each conflict side under its OWN row id, not a payload-embedded id', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const older = makeNote('Older edit')
    const newer: NoteDoc = {
      ...makeNote('Newer edit'),
      updatedAt: new Date(Date.now() + 60_000).toISOString()
    }
    await store.insertEntity(COLLECTION, older)
    await store.insertEntity(COLLECTION, newer)

    // The decoy this test relies on: for a private (random-id) collection the
    // row id is never the payload's own logical uuid.
    const olderEnvelopeId = store.envelopeIdFor(COLLECTION, older.id)!
    const newerEnvelopeId = store.envelopeIdFor(COLLECTION, newer.id)!
    expect(olderEnvelopeId).not.toBe(older.id)
    expect(newerEnvelopeId).not.toBe(newer.id)

    const olderRow = (await store
      .rxCollection(COLLECTION)
      .findOne(olderEnvelopeId)
      .exec())!.toMutableJSON()
    const newerRow = (await store
      .rxCollection(COLLECTION)
      .findOne(newerEnvelopeId)
      .exec())!.toMutableJSON()

    // The handler `LocalStore.init` actually wired at `addCollections` --
    // not a hand-rolled stand-in for it.
    const handler = store.rxCollection(COLLECTION).conflictHandler
    const resolved = await handler.resolve(
      {
        realMasterState: { ...olderRow, _deleted: false },
        newDocumentState: { ...newerRow, _deleted: false }
      },
      'test'
    )

    // The later payload won: proof both sides decrypted successfully, each
    // addressed under its OWN row id (never the other side's, and never the
    // decoy `id` field carried inside the decrypted payload).
    expect(resolved.id).toBe(newerEnvelopeId)
  })

  it('propagates IntegrityError out of the conflict handler when an envelope is addressed under the wrong row id', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    await store.insertEntity(COLLECTION, makeNote('Envelope A'))
    await store.insertEntity(COLLECTION, makeNote('Envelope B'))
    const rows = (await store.rxCollection(COLLECTION).find().exec()).map(row =>
      row.toMutableJSON()
    )
    expect(rows).toHaveLength(2)
    const [rowA, rowB] = rows

    const handler = store.rxCollection(COLLECTION).conflictHandler
    // Row B's envelope, addressed under row A's id: a tampered or misfiled
    // envelope, the exact case `IntegrityError` exists to catch. Resolution
    // must reject rather than silently score row A as undecryptable.
    await expect(
      handler.resolve(
        {
          realMasterState: { ...rowA!, data: rowB!.data, _deleted: false },
          newDocumentState: { ...rowB!, _deleted: false }
        },
        'test'
      )
    ).rejects.toSatisfy(isIntegrityError)
  })

  it('settles a public collection conflict on the LWW stamp when a side is mis-bound', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('Well-formed post')
    await store.insertEntity(PUBLIC_COLLECTION, post)
    const localRow = (await store
      .rxCollection(PUBLIC_COLLECTION)
      .findOne(post.id)
      .exec())!.toMutableJSON()

    // What another grant holder can write to a public collection: a body under
    // this resource id naming a different `id`. Its LWW stamp is plaintext and
    // readable, so the handler must compare on it rather than failing the
    // cycle -- the server's body never changes, so a hard failure would break
    // this collection's replication on every retry.
    const misbound = {
      ...localRow,
      data: {
        id: 'some-other-id',
        title: 'mismatched',
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        writerId: 'someone-else'
      }
    }

    const handler = store.rxCollection(PUBLIC_COLLECTION).conflictHandler
    const resolved = await handler.resolve(
      {
        realMasterState: { ...misbound, _deleted: false },
        newDocumentState: { ...localRow, _deleted: false }
      },
      'test'
    )

    // The well-formed local edit is the later one, so it wins and is re-pushed
    // over the malformed remote body.
    expect(resolved.data).toEqual(localRow.data)
  })

  it('settles a public collection conflict when the remote side is an EDV envelope', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('Well-formed post')
    await store.insertEntity(PUBLIC_COLLECTION, post)
    const localRow = (await store
      .rxCollection(PUBLIC_COLLECTION)
      .findOne(post.id)
      .exec())!.toMutableJSON()

    // `{ id, jwe }` under this resource id, written by another grant holder.
    // The body carries no stamp at all, so the stamped local edit wins; what
    // matters is that resolution settles rather than failing the cycle, since
    // the server's body is the same on every retry.
    const envelopeSide = { ...localRow, data: { id: post.id, jwe: {} } }

    const handler = store.rxCollection(PUBLIC_COLLECTION).conflictHandler
    const resolved = await handler.resolve(
      {
        realMasterState: { ...envelopeSide, _deleted: false },
        newDocumentState: { ...localRow, _deleted: false }
      },
      'test'
    )
    expect(resolved.data).toEqual(localRow.data)
  })
})
