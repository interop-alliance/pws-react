/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Tests the epoch-aware read path on the local store: a private collection
 * opened single-key (no cached descriptor) that meets an envelope written under a
 * key epoch it has not seen (a rotation on another device) recovers by re-
 * reading the descriptor exactly once and rebuilding the cipher. Uses the app's
 * real identity key-agreement key as the roster recipient, so the rebuilt
 * cipher genuinely unwraps the epoch.
 *
 * The refresh is rationed ONCE PER COLLECTION PER SESSION, so two further
 * properties are asserted here: rows decrypting concurrently share that one
 * re-read (they all recover), and an envelope no descriptor will ever route
 * cannot drive a second one.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KeyUnwrapError,
  ownerRecipient,
  UnverifiedDescriptorError
} from '@interop/was-client/edv'
import { captureLogger } from '@interop/logger'
import { isIntegrityError } from '@interop/was-client/sync'
import type { CollectionEncryption } from '@interop/was-client'
import { LocalStore } from '../../src/storage/localStore.js'
import type { Json } from '@interop/was-sync'
import { createDocCipher } from '../../src/storage/docCipher.js'
import {
  corruptRecipientEntry,
  FOREIGN_SEED,
  mintRoster
} from '../fixtures/roster.js'
import { fakeDescriptorSource } from '../fixtures/descriptorSource.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import type { WasCollectionConfig } from '../../src/config.js'
import { setLogger } from '../../src/log.js'

const COLLECTIONS: WasCollectionConfig[] = [{ key: 'notes', id: 'notes' }]
const COLLECTION_KEY = 'notes'
const COLLECTION_ID = 'notes'
const SEED = new Uint8Array(32).map((_, index) => (index * 9 + 2) & 0xff)

let dbCounter = 0
const openStores: LocalStore[] = []

async function openStore(
  descriptors?: Record<string, CollectionEncryption>
): Promise<LocalStore> {
  const { keyAgreementKey, keyResolver } = await deriveIdentity({ seed: SEED })
  const store = await LocalStore.init({
    keyAgreementKey,
    keyResolver,
    collections: COLLECTIONS,
    dbName: `epoch-test-${dbCounter++}`,
    ...(descriptors && { descriptors })
  })
  openStores.push(store)
  return store
}

/**
 * A descriptor source over one scripted answer.
 */
function descriptorSource(
  encryption?: CollectionEncryption,
  { plain = false }: { plain?: boolean } = {}
) {
  return fakeDescriptorSource({
    plain,
    collectionEncryption: async () => encryption
  })
}

/**
 * Mints a one-epoch descriptor whose sole recipient is the given identity's key
 * (the app's own by default).
 */
async function mintDescriptor(
  seed: Uint8Array = SEED
): Promise<CollectionEncryption> {
  const { keyAgreementKey } = await deriveIdentity({ seed })
  return mintRoster({ recipients: [ownerRecipient({ keyAgreementKey })] })
}

/**
 * Opens a store with no descriptor and drops into it one envelope sealed under
 * `encryption` by the identity derived from `seed` (what another client wrote
 * under an epoch this store has not seen).
 */
async function openStoreWithForeignRow({
  encryption,
  seed = SEED
}: {
  encryption: CollectionEncryption
  seed?: Uint8Array
}): Promise<LocalStore> {
  const { keyAgreementKey, keyResolver } = await deriveIdentity({ seed })
  const cipher = await createDocCipher({
    keyAgreementKey,
    keyResolver,
    collectionId: COLLECTION_ID,
    encryption
  })
  const { id, envelope } = await cipher.encrypt({
    data: { id: 'note-1', title: 'from another client' }
  })
  const store = await openStore()
  await store.rxCollection(COLLECTION_KEY).insert({
    id,
    updatedAt: new Date().toISOString(),
    data: envelope as unknown as Json
  })
  return store
}

/**
 * A promise with its resolver held apart, so a test can settle it by hand.
 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

afterEach(async () => {
  while (openStores.length > 0) {
    await openStores.pop()!.remove()
  }
})

describe('LocalStore epoch-descriptor refresh', () => {
  it('recovers from an unknown epoch with a single descriptor re-fetch', async () => {
    // Build an epoch envelope with the descriptor cipher (what another device wrote).
    const encryption = await mintDescriptor()
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const descriptorCipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })
    const payload = { id: 'note-1', title: 'from another device' }
    const { id, envelope } = await descriptorCipher.encrypt({ data: payload })

    // Open a store WITHOUT the descriptor (single-key) and drop the epoch envelope
    // straight into its RxDB collection, as replication would.
    const store = await openStore()
    await store.rxCollection(COLLECTION_KEY).insert({
      id,
      updatedAt: new Date().toISOString(),
      data: envelope as unknown as Json
    })

    // A source that hands back the descriptor; the single-key cipher hits an
    // UnknownEpochError, refreshes once, rebuilds, and decrypts.
    const source = descriptorSource(encryption)
    store.setDescriptorSource(source)

    const listed = await store.listEntities<{ id: string; title: string }>(
      COLLECTION_KEY
    )
    expect(listed).toEqual([payload])
    expect(source.collectionEncryption).toHaveBeenCalledTimes(1)
    expect(source.collectionEncryption).toHaveBeenCalledWith({
      collectionId: COLLECTION_ID
    })
  })

  it('shares one refresh across rows decrypting concurrently', async () => {
    // Two rows written by another device under the same unseen epoch:
    // `listEntities` decrypts them with `Promise.all`, so both meet the unknown
    // epoch before either refresh completes. Both must recover, off ONE read.
    const encryption = await mintDescriptor()
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const descriptorCipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })
    const payloads = [
      { id: 'note-a', title: 'first' },
      { id: 'note-b', title: 'second' }
    ]
    const store = await openStore()
    for (const payload of payloads) {
      const { id, envelope } = await descriptorCipher.encrypt({ data: payload })
      await store.rxCollection(COLLECTION_KEY).insert({
        id,
        updatedAt: new Date().toISOString(),
        data: envelope as unknown as Json
      })
    }
    const source = descriptorSource(encryption)
    store.setDescriptorSource(source)

    const listed = await store.listEntities<{ id: string; title: string }>(
      COLLECTION_KEY
    )
    expect(listed).toHaveLength(2)
    expect(
      [...listed].sort((left, right) => left.id.localeCompare(right.id))
    ).toEqual(payloads)
    expect(source.collectionEncryption).toHaveBeenCalledTimes(1)
  })

  it('spends the refresh once per collection per session', async () => {
    // An envelope sealed under a roster this app is not in: the refresh cannot
    // help, so the decrypt still fails -- and must not buy a second re-read,
    // now or on any later read of the same collection.
    const foreign = await mintDescriptor(FOREIGN_SEED)
    const identity = await deriveIdentity({ seed: FOREIGN_SEED })
    const foreignCipher = await createDocCipher({
      keyAgreementKey: identity.keyAgreementKey,
      keyResolver: identity.keyResolver,
      collectionId: COLLECTION_ID,
      encryption: foreign
    })
    const { id, envelope } = await foreignCipher.encrypt({
      data: { id: 'note-3', title: 'not for this app' }
    })

    const store = await openStore()
    await store.rxCollection(COLLECTION_KEY).insert({
      id,
      updatedAt: new Date().toISOString(),
      data: envelope as unknown as Json
    })
    // The refresh answers with the app's OWN roster, which does not carry the
    // foreign epoch either.
    const source = descriptorSource(await mintDescriptor())
    store.setDescriptorSource(source)

    await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow()
    expect(source.collectionEncryption).toHaveBeenCalledTimes(1)
    await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow()
    expect(source.collectionEncryption).toHaveBeenCalledTimes(1)
  })

  it('refuses a source that does not verify the governing log', async () => {
    // The same unknown epoch as above, but the installed source is a plain
    // one (a Metadata read a host could have stripped the history from). The
    // refresh is refused before the source is asked, as itself, and the
    // cipher is not rebuilt from anything.
    const encryption = await mintDescriptor()
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const descriptorCipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })
    const { id, envelope } = await descriptorCipher.encrypt({
      data: { id: 'note-1', title: 'from another device' }
    })
    const store = await openStore()
    await store.rxCollection(COLLECTION_KEY).insert({
      id,
      updatedAt: new Date().toISOString(),
      data: envelope as unknown as Json
    })
    const source = descriptorSource(encryption, { plain: true })
    store.setDescriptorSource(source)

    await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow(
      UnverifiedDescriptorError
    )
    // The refusal is for the session: a later read surfaces it again,
    // without the refresh being re-armed.
    await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow(
      UnverifiedDescriptorError
    )
    expect(source.collectionEncryption).not.toHaveBeenCalled()
  })

  it('keeps a refusal across a source re-install until a governed one arrives', async () => {
    // A reconnect installs the source again over the same store. A refusal
    // recorded under the first source must not come back relabeled as the
    // envelope's unknown epoch: re-arming the guard while dropping the
    // refusal (or the reverse) is what would do that. The re-install does
    // re-arm all three together, so once a governed source is installed the
    // next unknown-epoch decrypt asks it rather than reusing the old answer.
    const encryption = await mintDescriptor()
    const store = await openStoreWithForeignRow({ encryption })
    const first = descriptorSource(encryption, { plain: true })
    store.setDescriptorSource(first)
    await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow(
      UnverifiedDescriptorError
    )

    const second = descriptorSource(encryption, { plain: true })
    store.setDescriptorSource(second)
    await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow(
      UnverifiedDescriptorError
    )
    expect(first.collectionEncryption).not.toHaveBeenCalled()
    expect(second.collectionEncryption).not.toHaveBeenCalled()

    const governed = descriptorSource(encryption)
    store.setDescriptorSource(governed)
    const listed = await store.listEntities<{ id: string; title: string }>(
      COLLECTION_KEY
    )
    expect(listed).toEqual([{ id: 'note-1', title: 'from another client' }])
    expect(governed.collectionEncryption).toHaveBeenCalledTimes(1)
  })

  it('records a roster that excludes this app and surfaces it as KeyUnwrapError', async () => {
    // The source answers a roster that lists the envelope's epoch but wraps
    // no key to this app, so the rebuild throws `KeyUnwrapError` from inside
    // the refresh. The source has spoken: the refresh is spent, the error is
    // recorded like a refusal, and every decrypt of that epoch surfaces it as
    // itself (not as the envelope's unknown epoch) without re-asking.
    const foreign = await mintDescriptor(FOREIGN_SEED)
    const store = await openStoreWithForeignRow({
      encryption: foreign,
      seed: FOREIGN_SEED
    })
    const source = descriptorSource(foreign)
    store.setDescriptorSource(source)

    await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow(
      KeyUnwrapError
    )
    await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow(
      KeyUnwrapError
    )
    expect(source.collectionEncryption).toHaveBeenCalledTimes(1)
  })

  it('records a roster entry that fails its key-wrap check and surfaces it as IntegrityError', async () => {
    // The source answers a roster that names this app in the envelope's
    // epoch, but the wrapped epoch key in that entry fails its AES-KW
    // integrity check (a corrupt or tampered entry), so the rebuild throws
    // `IntegrityError` from inside the refresh. The source has spoken, and a
    // re-read of the same log serves the same entry: the refresh is spent,
    // the error is recorded like a refusal, and every later decrypt surfaces
    // it as itself without re-reading and rebuilding against the same
    // damaged entry.
    const encryption = await mintDescriptor()
    const { keyAgreementKey } = await deriveIdentity({ seed: SEED })
    const store = await openStoreWithForeignRow({ encryption })
    const source = descriptorSource(
      corruptRecipientEntry({
        descriptor: encryption,
        kid: keyAgreementKey.id
      })
    )
    store.setDescriptorSource(source)

    await expect(store.listEntities(COLLECTION_KEY)).rejects.toSatisfy(
      isIntegrityError
    )
    await expect(store.listEntities(COLLECTION_KEY)).rejects.toSatisfy(
      isIntegrityError
    )
    expect(source.collectionEncryption).toHaveBeenCalledTimes(1)
  })

  it('logs a refresh that fails on the wire and re-asks next time', async () => {
    // A dropped connection is not an answer: the failure is logged, the
    // refresh is left un-spent, and the next unknown-epoch decrypt re-asks.
    const encryption = await mintDescriptor()
    const store = await openStoreWithForeignRow({ encryption })
    const source = fakeDescriptorSource({
      collectionEncryption: async () => {
        throw new Error('connection dropped')
      }
    })
    store.setDescriptorSource(source)

    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    try {
      await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow()
      await expect(store.listEntities(COLLECTION_KEY)).rejects.toThrow()
    } finally {
      setLogger(previous)
    }
    expect(source.collectionEncryption).toHaveBeenCalledTimes(2)
    const warned = capture.events.filter(event => event.level === 'warn')
    expect(warned).toHaveLength(2)
    expect(warned[0]?.data?.collectionId).toBe(COLLECTION_ID)
  })

  it('discards the bookkeeping of a refresh that outlives its source', async () => {
    // A refresh is in flight against the first source when a reconnect
    // installs a second one. The first source then answers a roster this app
    // is not in. That outcome belongs to the retired source: recording it
    // would make the next decrypt throw the stale error over a cipher the
    // new source can rebuild.
    const encryption = await mintDescriptor()
    const foreign = await mintDescriptor(FOREIGN_SEED)
    const store = await openStoreWithForeignRow({ encryption })

    const asked = deferred<void>()
    const answer = deferred<CollectionEncryption>()
    const stale = fakeDescriptorSource({
      collectionEncryption: () => {
        asked.resolve()
        return answer.promise
      }
    })
    store.setDescriptorSource(stale)
    const torn = store.listEntities(COLLECTION_KEY)
    await asked.promise

    const fresh = descriptorSource(encryption)
    store.setDescriptorSource(fresh)
    answer.resolve(foreign)
    // The read torn by the swap fails against the stale cipher.
    await expect(torn).rejects.toThrow()

    // The next read asks the new source and recovers.
    const listed = await store.listEntities<{ id: string; title: string }>(
      COLLECTION_KEY
    )
    expect(listed).toEqual([{ id: 'note-1', title: 'from another client' }])
    expect(fresh.collectionEncryption).toHaveBeenCalledTimes(1)
  })

  it('opens epoch-aware from a cached descriptor (no refresh needed)', async () => {
    const encryption = await mintDescriptor()
    const store = await openStore({ [COLLECTION_ID]: encryption })
    const source = descriptorSource(encryption)
    store.setDescriptorSource(source)

    await store.insertEntity(COLLECTION_KEY, { id: 'note-2', title: 'local' })
    const listed = await store.listEntities<{ id: string; title: string }>(
      COLLECTION_KEY
    )
    expect(listed).toEqual([{ id: 'note-2', title: 'local' }])
    // The write already went under the current epoch, so no refresh fired.
    expect(source.collectionEncryption).not.toHaveBeenCalled()
  })

  it('applyRemoteDescriptor rebuilds only when the epoch changes', async () => {
    const encryption = await mintDescriptor()
    const store = await openStore({ [COLLECTION_ID]: encryption })
    // Same descriptor: no rebuild.
    expect(
      await store.applyRemoteDescriptor({
        collectionId: COLLECTION_ID,
        encryption
      })
    ).toBe(false)
    // Unknown collection id: ignored.
    expect(
      await store.applyRemoteDescriptor({ collectionId: 'nope', encryption })
    ).toBe(false)
  })
})
