/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app side of a shared, wallet-owned encrypted collection.
 *
 * Two things are proven here. First, the RECIPIENT IDENTITY: the wallet writes
 * an epoch-roster entry derived from the app's controller `did:key` alone,
 * while the app derives its own key from the key pair behind that DID. Both
 * sides must land on the same `id` / `publicKeyMultibase`, or the app would
 * hold a key that unwraps nothing. Second, the READ PATH: an epoch roster
 * minted with an owner plus that app recipient, a payload encrypted as the
 * owner, and the same envelope decrypted through the cipher a
 * {@link SharedCollectionReader} builds -- over both the paged `changes`-feed
 * fast path and the resource-by-resource fallback, and across an epoch rotation
 * the reader has to recover from.
 *
 * @vitest-environment node
 */
import { isIntegrityError } from '@interop/pws-client/sync'
import { describe, expect, it, vi } from 'vitest'
import {
  ownerRecipient,
  UnverifiedDescriptorError,
  x25519RecipientFromDidKey
} from '@interop/pws-client/edv'
import type { CollectionEncryption } from '@interop/pws-client'
import { fakeRemoteStore } from '../fixtures/remoteStore.js'
import {
  corruptRecipientEntry,
  mintRoster,
  rotateRoster
} from '../fixtures/roster.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { createDocCipher } from '../../src/storage/docCipher.js'
import {
  SharedCollectionReader,
  SharedCollectionUnavailableError
} from '../../src/storage/sharedCollectionReader.js'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../../src/log.js'

const APP_SEED = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff)
const OWNER_SEED = new Uint8Array(32).map((_, index) => (index * 5 + 11) & 0xff)
const EXTRA_SEED = new Uint8Array(32).map((_, index) => (index * 3 + 19) & 0xff)
const COLLECTION_ID = 'private-credentials'

describe('the app-side recipient identity', () => {
  it('derives byte-identically on both sides of a share', async () => {
    const identity = await deriveIdentity({ seed: APP_SEED })
    const appSide = identity.keyAgreementKey as unknown as {
      id: string
      type: string
      publicKeyMultibase: string
    }
    // The WALLET-side derivation of a grantee's recipient key: everything it
    // has is the grantee's Ed25519 `did:key`. This is the REAL derivation a
    // wallet applies to a grantee (`x25519RecipientFromDidKey`), not a test
    // mirror of it -- so a divergence between the two packages' derivations
    // fails this suite the day it lands.
    const walletSide = x25519RecipientFromDidKey({
      did: identity.controllerDid
    })

    expect(appSide.id).toBe(walletSide.id)
    expect(appSide.publicKeyMultibase).toBe(walletSide.publicKeyMultibase)
    // Including the key type, so a recipient-type change in either package
    // (a Multikey migration, say) fails here rather than shipping uncaught.
    expect(appSide.type).toBe(walletSide.type)
    // The shape the roster entry carries: `did:key:z6Mk...#z6LS...`.
    expect(appSide.id).toBe(
      `${identity.controllerDid}#${appSide.publicKeyMultibase}`
    )
    expect(appSide.type).toBe('X25519KeyAgreementKey2020')
  })

  it('is the SAME key the app reads its own collections with', async () => {
    // One rule for every roster entry: the X25519 twin of the controller
    // did:key, whether the collection is shared by a wallet or app-owned.
    const first = await deriveIdentity({ seed: APP_SEED })
    const second = await deriveIdentity({ seed: APP_SEED })
    const firstKey = first.keyAgreementKey as unknown as { id: string }
    const secondKey = second.keyAgreementKey as unknown as { id: string }
    expect(firstKey.id).toBe(secondKey.id)
    expect(firstKey.id.startsWith(`${first.controllerDid}#`)).toBe(true)
  })

  it('resolves only its own key id', async () => {
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: APP_SEED
    })
    const { id } = keyAgreementKey as unknown as { id: string }
    await expect(keyResolver({ id })).resolves.toMatchObject({ id })
    await expect(keyResolver({ id: 'did:key:zNope#zNope' })).rejects.toThrow()
  })
})

describe('SharedCollectionReader', () => {
  it('decrypts an owner-written envelope through the epoch roster', async () => {
    const app = await deriveIdentity({ seed: APP_SEED })
    const owner = await deriveIdentity({ seed: OWNER_SEED })
    const recipient = x25519RecipientFromDidKey({ did: app.controllerDid })
    const encryption = await mintRoster({
      recipients: [
        ownerRecipient({ keyAgreementKey: owner.keyAgreementKey }),
        recipient
      ]
    })

    // The wallet writes the resource as the owner, under the current epoch.
    const ownerCipher = await createDocCipher({
      keyAgreementKey: owner.keyAgreementKey,
      keyResolver: owner.keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })
    const payload = { id: 'credential-1', title: 'a shared credential' }
    const { id, envelope } = await ownerCipher.encrypt({ data: payload })

    const remoteStore = fakeRemoteStore({
      collectionId: COLLECTION_ID,
      encryption,
      resources: { [id]: envelope }
    })
    const reader = await SharedCollectionReader.open({
      remoteStore,
      keyAgreementKey: app.keyAgreementKey,
      keyResolver: app.keyResolver,
      collectionId: COLLECTION_ID
    })

    expect(reader.collectionId).toBe(COLLECTION_ID)
    expect(await reader.get(id)).toEqual(payload)
    expect(await reader.list()).toEqual([{ id, data: payload }])
  })

  it('surfaces IntegrityError for an envelope served under another resource id', async () => {
    const app = await deriveIdentity({ seed: APP_SEED })
    const owner = await deriveIdentity({ seed: OWNER_SEED })
    const encryption = await mintRoster({
      recipients: [
        ownerRecipient({ keyAgreementKey: owner.keyAgreementKey }),
        x25519RecipientFromDidKey({ did: app.controllerDid })
      ]
    })
    const ownerCipher = await createDocCipher({
      keyAgreementKey: owner.keyAgreementKey,
      keyResolver: owner.keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })
    const { envelope } = await ownerCipher.encrypt({
      data: { id: 'credential-1', title: 'a shared credential' }
    })
    const readable = { id: 'credential-2', title: 'another shared credential' }
    const sound = await ownerCipher.encrypt({ data: readable })

    // The envelope is sealed for its own id; the server serves it elsewhere.
    const reader = await SharedCollectionReader.open({
      remoteStore: fakeRemoteStore({
        collectionId: COLLECTION_ID,
        encryption,
        resources: {
          'some-other-resource': envelope,
          [sound.id]: sound.envelope
        }
      }),
      keyAgreementKey: app.keyAgreementKey,
      keyResolver: app.keyResolver,
      collectionId: COLLECTION_ID
    })

    // Not folded into the warn-and-skip path the tolerated failures take.
    await expect(reader.get('some-other-resource')).rejects.toSatisfy(
      isIntegrityError
    )
    // The listing skips it instead: one mis-bound envelope must not make a
    // wallet-owned collection this app cannot repair unlistable.
    expect(await reader.list()).toEqual([{ id: sound.id, data: readable }])
  })

  it('refuses a collection with no key-epoch roster', async () => {
    const app = await deriveIdentity({ seed: APP_SEED })
    await expect(
      SharedCollectionReader.open({
        remoteStore: fakeRemoteStore({
          collectionId: COLLECTION_ID,
          resources: {}
        }),
        keyAgreementKey: app.keyAgreementKey,
        keyResolver: app.keyResolver,
        collectionId: COLLECTION_ID
      })
    ).rejects.toThrow(SharedCollectionUnavailableError)
  })

  it('refuses a source that does not verify the governing log', async () => {
    // A host that strips the governing history from the served projection
    // and serves an epoch it minted looks, through a plain source, exactly
    // like an honest point-state roster this app is in. The reader never
    // asks such a source: it is refused up front, as itself rather than as
    // "not a recipient", since the fix is to read through a verifying source.
    const app = await deriveIdentity({ seed: APP_SEED })
    const encryption = await mintRoster({
      recipients: [
        ownerRecipient({ keyAgreementKey: app.keyAgreementKey }),
        x25519RecipientFromDidKey({ did: app.controllerDid })
      ]
    })
    const remoteStore = fakeRemoteStore({
      collectionId: COLLECTION_ID,
      encryption,
      resources: {},
      plainSource: true
    })
    const open = SharedCollectionReader.open({
      remoteStore,
      keyAgreementKey: app.keyAgreementKey,
      keyResolver: app.keyResolver,
      collectionId: COLLECTION_ID
    })
    await expect(open).rejects.toThrow(UnverifiedDescriptorError)
    await expect(open).rejects.not.toThrow(SharedCollectionUnavailableError)
    expect(remoteStore.encryptionReads()).toBe(0)
  })

  it('rethrows a failed descriptor read rather than reading it as no share', async () => {
    // `acquireDescriptor` swallows a thrown fetch and falls back to the
    // reader's empty cache, which would build a roster-less cipher and report
    // "not a recipient" over a dropped connection. The outage surfaces as
    // itself: "unknown" is kept apart from "no share".
    const app = await deriveIdentity({ seed: APP_SEED })
    const outage = new Error('connection dropped')
    const open = SharedCollectionReader.open({
      remoteStore: fakeRemoteStore({
        collectionId: COLLECTION_ID,
        resources: {},
        descriptorReadError: outage
      }),
      keyAgreementKey: app.keyAgreementKey,
      keyResolver: app.keyResolver,
      collectionId: COLLECTION_ID
    })
    await expect(open).rejects.toBe(outage)
  })

  it('refuses a roster this app is not a recipient of', async () => {
    const app = await deriveIdentity({ seed: APP_SEED })
    const owner = await deriveIdentity({ seed: OWNER_SEED })
    const encryption = await mintRoster({
      recipients: [ownerRecipient({ keyAgreementKey: owner.keyAgreementKey })]
    })
    await expect(
      SharedCollectionReader.open({
        remoteStore: fakeRemoteStore({
          collectionId: COLLECTION_ID,
          encryption,
          resources: {}
        }),
        keyAgreementKey: app.keyAgreementKey,
        keyResolver: app.keyResolver,
        collectionId: COLLECTION_ID
      })
    ).rejects.toThrow(/not a recipient of any of its key epochs/)
  })

  it('surfaces IntegrityError for a roster entry that fails its key-wrap check at open', async () => {
    // The roster names this app in its current epoch, but the entry's
    // wrapped epoch key fails its AES-KW integrity check. The build resolves
    // the write epoch eagerly and raises `IntegrityError` for it, which is a
    // corrupt or tampered entry rather than a share this app lacks, so it
    // surfaces as itself rather than as "not a recipient".
    const app = await deriveIdentity({ seed: APP_SEED })
    const owner = await deriveIdentity({ seed: OWNER_SEED })
    const sound = await mintRoster({
      recipients: [
        ownerRecipient({ keyAgreementKey: owner.keyAgreementKey }),
        x25519RecipientFromDidKey({ did: app.controllerDid })
      ]
    })
    const encryption = corruptRecipientEntry({
      descriptor: sound,
      kid: app.keyAgreementKey.id
    })
    const open = SharedCollectionReader.open({
      remoteStore: fakeRemoteStore({
        collectionId: COLLECTION_ID,
        encryption,
        resources: {}
      }),
      keyAgreementKey: app.keyAgreementKey,
      keyResolver: app.keyResolver,
      collectionId: COLLECTION_ID
    })
    await expect(open).rejects.toSatisfy(isIntegrityError)
    await expect(open).rejects.not.toThrow(SharedCollectionUnavailableError)
  })

  it('surfaces IntegrityError for a lazily unwrapped epoch whose entry fails its key-wrap check', async () => {
    // Two epochs. The current one is sound, so the reader opens; the earlier
    // one names this app with an entry that fails its key-wrap check, which
    // the cipher only unwraps on the first decrypt of an envelope sealed
    // under it. That decrypt raises `IntegrityError`, routed as a mis-bound
    // envelope is: `get()` propagates it, a listing skips the resource with
    // an `error` log and returns the rest.
    const app = await deriveIdentity({ seed: APP_SEED })
    const owner = await deriveIdentity({ seed: OWNER_SEED })
    const extra = await deriveIdentity({ seed: EXTRA_SEED })
    const extraRecipient = x25519RecipientFromDidKey({
      did: extra.controllerDid
    })
    const first = await mintRoster({
      recipients: [
        ownerRecipient({ keyAgreementKey: owner.keyAgreementKey }),
        x25519RecipientFromDidKey({ did: app.controllerDid }),
        extraRecipient
      ]
    })
    const rotated = await rotateRoster({
      descriptor: first,
      removeKid: extraRecipient.id
    })
    const encryption = corruptRecipientEntry({
      descriptor: rotated,
      kid: app.keyAgreementKey.id,
      epochId: first.currentEpoch
    })
    const firstCipher = await createDocCipher({
      keyAgreementKey: owner.keyAgreementKey,
      keyResolver: owner.keyResolver,
      collectionId: COLLECTION_ID,
      encryption: first
    })
    const rotatedCipher = await createDocCipher({
      keyAgreementKey: owner.keyAgreementKey,
      keyResolver: owner.keyResolver,
      collectionId: COLLECTION_ID,
      encryption: rotated
    })
    const damaged = await firstCipher.encrypt({
      data: { id: 'credential-1', title: 'under the damaged epoch' }
    })
    const readable = { id: 'credential-2', title: 'under the sound epoch' }
    const sound = await rotatedCipher.encrypt({ data: readable })

    const capture = captureLogger('pr')
    const previous = setLogger(capture.logger)
    try {
      const reader = await SharedCollectionReader.open({
        remoteStore: fakeRemoteStore({
          collectionId: COLLECTION_ID,
          encryption,
          resources: {
            [damaged.id]: damaged.envelope,
            [sound.id]: sound.envelope
          }
        }),
        keyAgreementKey: app.keyAgreementKey,
        keyResolver: app.keyResolver,
        collectionId: COLLECTION_ID
      })

      await expect(reader.get(damaged.id)).rejects.toSatisfy(isIntegrityError)
      expect(await reader.list()).toEqual([{ id: sound.id, data: readable }])
      const skips = capture.events.filter(
        event =>
          event.level === 'error' &&
          event.msg.includes('Skipping a resource of a shared collection')
      )
      expect(skips).toHaveLength(1)
    } finally {
      setLogger(previous)
    }
  })

  it('skips a body that is not an EDV envelope', async () => {
    const app = await deriveIdentity({ seed: APP_SEED })
    const owner = await deriveIdentity({ seed: OWNER_SEED })
    const recipient = x25519RecipientFromDidKey({ did: app.controllerDid })
    const encryption = await mintRoster({
      recipients: [
        ownerRecipient({ keyAgreementKey: owner.keyAgreementKey }),
        recipient
      ]
    })
    const reader = await SharedCollectionReader.open({
      remoteStore: fakeRemoteStore({
        collectionId: COLLECTION_ID,
        encryption,
        resources: { plain: { hello: 'world' } }
      }),
      keyAgreementKey: app.keyAgreementKey,
      keyResolver: app.keyResolver,
      collectionId: COLLECTION_ID
    })
    expect(await reader.list()).toEqual([])
    expect(await reader.get('plain')).toBeUndefined()
  })
})

describe('SharedCollectionReader.list', () => {
  it('pages the changes feed and excludes tombstones', async () => {
    const { app, owner, encryption, encrypt } = await sharedFixture()
    const first = await encrypt({ id: 'credential-1', title: 'one' })
    const second = await encrypt({ id: 'credential-2', title: 'two' })
    const third = await encrypt({ id: 'credential-3', title: 'three' })
    expect(owner.controllerDid).not.toBe(app.controllerDid)

    const remoteStore = fakeRemoteStore({
      collectionId: COLLECTION_ID,
      encryption,
      resources: {},
      // Three live documents plus a tombstone, walked two per page so the
      // checkpoint resume is exercised.
      changes: [
        { id: first.id, data: first.envelope },
        { id: second.id, data: second.envelope },
        { id: third.id, data: third.envelope },
        { id: second.id, deleted: true }
      ]
    })
    const reader = await SharedCollectionReader.open({
      remoteStore,
      keyAgreementKey: app.keyAgreementKey,
      keyResolver: app.keyResolver,
      collectionId: COLLECTION_ID,
      // Two per page over a four-entry feed, so the checkpoint resume runs.
      pageSize: 2
    })

    const listed = await reader.list()
    expect(listed).toEqual([
      { id: first.id, data: { id: 'credential-1', title: 'one' } },
      { id: third.id, data: { id: 'credential-3', title: 'three' } }
    ])
    // The fast path never fetches a resource one at a time.
    expect(remoteStore.resourceGets()).toBe(0)
  })

  it('skips every entry but a JSON Resource and resumes past them', async () => {
    const { app, encryption, encrypt } = await sharedFixture()
    const first = await encrypt({ id: 'credential-1', title: 'one' })
    const second = await encrypt({ id: 'credential-2', title: 'two' })
    const collectionUrl = `https://was.example/space/space-1/${COLLECTION_ID}/`

    const capture = captureLogger('pr')
    const previous = setLogger(capture.logger)
    try {
      const remoteStore = fakeRemoteStore({
        collectionId: COLLECTION_ID,
        encryption,
        resources: {},
        changes: [
          // The first page holds no Resource at all, so the walk must still
          // resume from its checkpoint.
          { id: `${collectionUrl}meta`, kind: 'collection-metadata' },
          { id: `${collectionUrl}meta/log`, kind: 'log' },
          { id: `${collectionUrl}future`, kind: 'future-kind' },
          { id: 'photo-1', contentType: 'image/png' },
          { id: first.id, data: first.envelope },
          { id: second.id, data: second.envelope },
          // A JSON Resource rewritten to a binary type leaves the live set.
          { id: second.id, contentType: 'application/octet-stream' },
          { id: 'photo-1', contentType: 'image/png', deleted: true }
        ]
      })
      const reader = await SharedCollectionReader.open({
        remoteStore,
        keyAgreementKey: app.keyAgreementKey,
        keyResolver: app.keyResolver,
        collectionId: COLLECTION_ID,
        pageSize: 2
      })

      expect(await reader.list()).toEqual([
        { id: first.id, data: { id: 'credential-1', title: 'one' } }
      ])
      expect(remoteStore.checkpointsRequested()).toEqual([
        undefined,
        '2',
        '4',
        '6',
        '8'
      ])
      // A skipped entry is not read as a body that failed to decrypt.
      expect(capture.events.filter(event => event.level === 'warn')).toEqual([])
    } finally {
      setLogger(previous)
    }
  })

  it('falls back to listing plus per-resource reads without changes-query', async () => {
    const { app, encryption, encrypt } = await sharedFixture()
    const first = await encrypt({ id: 'credential-1', title: 'one' })
    const second = await encrypt({ id: 'credential-2', title: 'two' })

    const capture = captureLogger('pr')
    const previous = setLogger(capture.logger)
    try {
      const remoteStore = fakeRemoteStore({
        collectionId: COLLECTION_ID,
        encryption,
        resources: {
          [first.id]: first.envelope,
          [second.id]: second.envelope
        },
        changesNotImplemented: true
      })
      const reader = await SharedCollectionReader.open({
        remoteStore,
        keyAgreementKey: app.keyAgreementKey,
        keyResolver: app.keyResolver,
        collectionId: COLLECTION_ID
      })

      expect(await reader.list()).toEqual([
        { id: first.id, data: { id: 'credential-1', title: 'one' } },
        { id: second.id, data: { id: 'credential-2', title: 'two' } }
      ])
      expect(remoteStore.resourceGets()).toBe(2)
      // Warned once about the slow path, and only once across repeat calls.
      await reader.list()
      const slowWarnings = capture.events.filter(event =>
        event.msg.includes('slow way')
      )
      expect(slowWarnings).toHaveLength(1)
    } finally {
      setLogger(previous)
    }
  })
})

describe('SharedCollectionReader unknown-epoch refresh', () => {
  it('re-reads the descriptor exactly once and decrypts the rotated envelope', async () => {
    const app = await deriveIdentity({ seed: APP_SEED })
    const owner = await deriveIdentity({ seed: OWNER_SEED })
    const extra = await deriveIdentity({ seed: EXTRA_SEED })
    const appRecipient = x25519RecipientFromDidKey({ did: app.controllerDid })
    const extraRecipient = x25519RecipientFromDidKey({
      did: extra.controllerDid
    })

    // The roster the reader opens against, and the rotated one it has not seen.
    const stale = await mintRoster({
      recipients: [
        ownerRecipient({ keyAgreementKey: owner.keyAgreementKey }),
        appRecipient,
        extraRecipient
      ]
    })
    const fresh = await rotateRoster({
      descriptor: stale,
      removeKid: extraRecipient.id
    })
    expect(fresh.currentEpoch).not.toBe(stale.currentEpoch)

    // The wallet writes under the NEW epoch, which the stale descriptor lacks.
    const ownerCipher = await createDocCipher({
      keyAgreementKey: owner.keyAgreementKey,
      keyResolver: owner.keyResolver,
      collectionId: COLLECTION_ID,
      encryption: fresh
    })
    const payload = { id: 'credential-1', title: 'written after the rotation' }
    const { id, envelope } = await ownerCipher.encrypt({ data: payload })

    // A second envelope this app can never decrypt (sealed under an owner-only
    // roster's epoch, as a pre-epoch legacy resource is): it must NOT trigger a
    // second refresh.
    const preShareRoster = await mintRoster({
      recipients: [ownerRecipient({ keyAgreementKey: owner.keyAgreementKey })]
    })
    const preShareCipher = await createDocCipher({
      keyAgreementKey: owner.keyAgreementKey,
      keyResolver: owner.keyResolver,
      collectionId: COLLECTION_ID,
      encryption: preShareRoster
    })
    const preShare = await preShareCipher.encrypt({
      data: { id: 'credential-0', title: 'written before the share' }
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const remoteStore = fakeRemoteStore({
        collectionId: COLLECTION_ID,
        // Open on the stale descriptor; every later read answers with the fresh one.
        descriptors: [stale, fresh],
        resources: {},
        changes: [
          { id: preShare.id, data: preShare.envelope },
          { id, data: envelope }
        ]
      })
      const reader = await SharedCollectionReader.open({
        remoteStore,
        keyAgreementKey: app.keyAgreementKey,
        keyResolver: app.keyResolver,
        collectionId: COLLECTION_ID
      })
      // One read so far: the open.
      expect(remoteStore.encryptionReads()).toBe(1)

      expect(await reader.list()).toEqual([{ id, data: payload }])
      // Exactly one refresh: the open's read plus the unknown-epoch re-read.
      // The undecryptable legacy envelope did not buy another.
      expect(remoteStore.encryptionReads()).toBe(2)

      // A later unknown epoch does not refresh again either.
      await reader.list()
      expect(remoteStore.encryptionReads()).toBe(2)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('SharedCollectionReader mid-session revoke', () => {
  it('warns and skips the undecryptable resources instead of failing list()', async () => {
    const { app, stale, readable, unreadable } = await revokeFixture()

    const capture = captureLogger('pr')
    const previous = setLogger(capture.logger)
    try {
      const remoteStore = fakeRemoteStore({
        collectionId: COLLECTION_ID,
        // Opened on the roster this app is in; the refresh the unknown epoch
        // drives answers with no roster at all (access removed mid-session).
        descriptors: [stale, undefined],
        resources: {},
        changes: [
          { id: readable.id, data: readable.envelope },
          { id: unreadable.id, data: unreadable.envelope }
        ]
      })
      const reader = await SharedCollectionReader.open({
        remoteStore,
        keyAgreementKey: app.keyAgreementKey,
        keyResolver: app.keyResolver,
        collectionId: COLLECTION_ID
      })

      // The refreshed descriptor no longer carries a roster (access removed
      // mid-session), so the retry under the swapped cipher fails too and the
      // reader degrades to the subset it could decrypt rather than rejecting.
      expect(await reader.list()).toEqual([
        { id: readable.id, data: { id: 'credential-1', title: 'before' } }
      ])
      expect(remoteStore.encryptionReads()).toBe(2)
      const skipWarnings = capture.events.filter(event =>
        event.msg.includes('is not a recipient of its envelope')
      )
      expect(skipWarnings).toHaveLength(1)

      // A subsequent undecryptable resource is skipped too (no second refresh,
      // no rejection).
      expect(await reader.get(unreadable.id)).toBeUndefined()
      expect(remoteStore.encryptionReads()).toBe(2)
    } finally {
      setLogger(previous)
    }
  })

  it('resolves get() to undefined when the rebuild itself fails', async () => {
    const { app, stale, unreadable } = await revokeFixture()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const reader = await SharedCollectionReader.open({
        remoteStore: fakeRemoteStore({
          collectionId: COLLECTION_ID,
          descriptors: [stale, undefined],
          resources: { [unreadable.id]: unreadable.envelope }
        }),
        keyAgreementKey: app.keyAgreementKey,
        keyResolver: app.keyResolver,
        collectionId: COLLECTION_ID
      })
      expect(await reader.get(unreadable.id)).toBeUndefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

/**
 * A share withdrawn mid-session: the roster the reader opened on (`stale`, which
 * one resource was written under) plus a resource written under a LATER epoch
 * the stale descriptor does not carry, so reading it raises an unknown epoch.
 * The refresh that unknown epoch drives then answers with no roster at all --
 * access removed -- so the cipher rebuild itself fails.
 */
async function revokeFixture(): Promise<{
  app: Awaited<ReturnType<typeof deriveIdentity>>
  stale: CollectionEncryption
  readable: { id: string; envelope: unknown }
  unreadable: { id: string; envelope: unknown }
}> {
  const app = await deriveIdentity({ seed: APP_SEED })
  const owner = await deriveIdentity({ seed: OWNER_SEED })
  const extra = await deriveIdentity({ seed: EXTRA_SEED })
  const appRecipient = x25519RecipientFromDidKey({ did: app.controllerDid })
  const extraRecipient = x25519RecipientFromDidKey({ did: extra.controllerDid })
  const stale = await mintRoster({
    recipients: [
      ownerRecipient({ keyAgreementKey: owner.keyAgreementKey }),
      appRecipient,
      extraRecipient
    ]
  })
  const rotated = await rotateRoster({
    descriptor: stale,
    removeKid: extraRecipient.id
  })
  expect(rotated.currentEpoch).not.toBe(stale.currentEpoch)

  const staleCipher = await createDocCipher({
    keyAgreementKey: owner.keyAgreementKey,
    keyResolver: owner.keyResolver,
    collectionId: COLLECTION_ID,
    encryption: stale
  })
  const rotatedCipher = await createDocCipher({
    keyAgreementKey: owner.keyAgreementKey,
    keyResolver: owner.keyResolver,
    collectionId: COLLECTION_ID,
    encryption: rotated
  })
  return {
    app,
    stale,
    readable: await staleCipher.encrypt({
      data: { id: 'credential-1', title: 'before' }
    }),
    unreadable: await rotatedCipher.encrypt({
      data: { id: 'credential-2', title: 'after the rotation' }
    })
  }
}

/**
 * The common two-recipient setup: an owner (the wallet) and this app, a roster
 * wrapping the current epoch to both, and an `encrypt` that writes a payload as
 * the owner does.
 */
async function sharedFixture(): Promise<{
  app: Awaited<ReturnType<typeof deriveIdentity>>
  owner: Awaited<ReturnType<typeof deriveIdentity>>
  encryption: CollectionEncryption
  encrypt: (payload: {
    id: string
    title: string
  }) => Promise<{ id: string; envelope: unknown }>
}> {
  const app = await deriveIdentity({ seed: APP_SEED })
  const owner = await deriveIdentity({ seed: OWNER_SEED })
  const recipient = x25519RecipientFromDidKey({ did: app.controllerDid })
  const encryption = await mintRoster({
    recipients: [
      ownerRecipient({ keyAgreementKey: owner.keyAgreementKey }),
      recipient
    ]
  })
  const ownerCipher = await createDocCipher({
    keyAgreementKey: owner.keyAgreementKey,
    keyResolver: owner.keyResolver,
    collectionId: COLLECTION_ID,
    encryption
  })
  return {
    app,
    owner,
    encryption,
    encrypt: payload => ownerCipher.encrypt({ data: payload })
  }
}
