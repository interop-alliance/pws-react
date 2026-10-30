/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Tests for the multi-recipient (key-epoch) behavior of `createDocCipher`, the
 * per-collection encrypt/decrypt seam. Uses the app's real identity
 * key-agreement key (`deriveIdentity`) as the recipient -- exactly the key the
 * wallet registers as the app's roster entry -- so the round-trip proves the
 * shared-key contract, not a synthetic key. A descriptor is minted with
 * pws-client's own `initRecipients` over the shared in-memory roster fixture.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  mintHmacKey,
  ownerRecipient,
  epochKeyIdFor,
  wrapEpochSecret
} from '@interop/pws-client/edv'
import type { CollectionEncryption } from '@interop/pws-client'
import type { IKeyAgreementKey } from '@interop/data-integrity-core'
import {
  isEncryptedEnvelope,
  isUnknownEpochError
} from '@interop/pws-client/sync'
import { deriveIdentity } from '../identity/agents.js'
import { createDocCipher, createUnprovisionedDocCipher } from './docCipher.js'
import type { Json } from '@interop/pws-sync'
import { encodeIndexSchemaMeta } from '../../test/fixtures/indexSchemaMeta.js'
import { mintRoster } from '../../test/fixtures/roster.js'

// A fixed 32-byte master seed drives the deterministic identity derivation.
const SEED = new Uint8Array(32).map((_, index) => (index * 5 + 1) & 0xff)
const COLLECTION_ID = 'app-notes'

/**
 * Mints a one-epoch encryption descriptor whose sole recipient is the given
 * key-agreement key, over the shared roster fixture.
 */
async function mintDescriptor(
  keyAgreementKey: Parameters<typeof ownerRecipient>[0]['keyAgreementKey']
) {
  return mintRoster({ recipients: [ownerRecipient({ keyAgreementKey })] })
}

const DOC: Json = { id: 'note-1', title: 'hello', body: { n: 42 } }

describe('createDocCipher (multi-recipient / key epochs)', () => {
  it('encrypts under the current epoch and round-trips through the epoch codec', async () => {
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const encryption = await mintDescriptor(keyAgreementKey)
    const cipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })

    const { id, envelope } = await cipher.encrypt({ data: DOC })
    expect(isEncryptedEnvelope(envelope)).toBe(true)
    // The envelope names the epoch key id as its recipient (not the bare vault
    // key), proving the write went under the current epoch.
    const kids = (
      envelope as { jwe: { recipients: Array<{ header: { kid: string } }> } }
    ).jwe.recipients.map(recipient => recipient.header.kid)
    expect(kids).toContain(epochKeyIdFor(encryption.currentEpoch as string))
    expect(kids).not.toContain(keyAgreementKey.id)
    // The app's own identity key unwraps the epoch and recovers the doc.
    expect(await cipher.decrypt({ id, envelope })).toEqual(DOC)
  })
})

/**
 * The same one-epoch descriptor with a blinded-index HMAC key installed -- the
 * searchable-collection fixture. The blinding key is distributed exactly like
 * an epoch key, so the same wrap builds it.
 *
 * @param keyAgreementKey {IKeyAgreementKey}   the sole recipient
 * @returns {Promise<CollectionEncryption>}
 */
async function mintIndexableDescriptor(
  keyAgreementKey: IKeyAgreementKey
): Promise<CollectionEncryption> {
  const encryption = await mintDescriptor(keyAgreementKey)
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
 * The blinded index entries of a stored envelope.
 *
 * @param envelope {Json}
 * @returns {unknown[]}
 */
function indexedOf(envelope: Json): unknown[] {
  return (envelope as { indexed?: unknown[] }).indexed ?? []
}

describe('createDocCipher (blinded index schema)', () => {
  it('emits blinded index entries on encrypt and encryptUpdate', async () => {
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const encryption = await mintIndexableDescriptor(keyAgreementKey)
    const custom = await encodeIndexSchemaMeta({
      encryption,
      collectionId: COLLECTION_ID,
      keys: { keyAgreementKey, keyResolver }
    })
    const cipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption,
      meta: { custom }
    })

    const first = await cipher.encrypt({ data: DOC })
    expect(indexedOf(first.envelope)).toHaveLength(1)
    // Blinded: neither the attribute nor its value travels in the clear.
    const serialized = JSON.stringify(indexedOf(first.envelope))
    expect(serialized).not.toContain('content.title')
    expect(serialized).not.toContain('hello')

    // The mutable-head update path indexes too.
    const updated = await cipher.encryptUpdate({
      id: first.id,
      data: { ...(DOC as object), title: 'goodbye' } as Json,
      current: first.envelope
    })
    expect(indexedOf(updated.envelope)).toHaveLength(1)
  })

  it('installs the schema after the build through applyMeta', async () => {
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const encryption = await mintIndexableDescriptor(keyAgreementKey)
    const custom = await encodeIndexSchemaMeta({
      encryption,
      collectionId: COLLECTION_ID,
      keys: { keyAgreementKey, keyResolver }
    })
    const cipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })

    // Built without metadata: exactly what an offline replica wrote before.
    const before = await cipher.encrypt({ data: DOC })
    expect(indexedOf(before.envelope)).toEqual([])

    await cipher.applyMeta!({ custom })

    const after = await cipher.encrypt({ data: DOC })
    expect(indexedOf(after.envelope)).toHaveLength(1)
  })

  it('is a no-op on a descriptor with no blinded-index key', async () => {
    // No `hmac` means no blinding key at all, so applyMeta may be called
    // unconditionally.
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const encryption = await mintDescriptor(keyAgreementKey)
    const cipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })
    await expect(
      cipher.applyMeta!({ custom: undefined })
    ).resolves.toBeDefined()
    const { id, envelope } = await cipher.encrypt({ data: DOC })
    expect(indexedOf(envelope)).toEqual([])
    expect(await cipher.decrypt({ id, envelope })).toEqual(DOC)
  })
})

describe('createUnprovisionedDocCipher', () => {
  it('refuses writes and reports decrypts as unknown-epoch', async () => {
    const cipher = createUnprovisionedDocCipher({
      collectionId: COLLECTION_ID
    })
    await expect(cipher.encrypt({ data: DOC })).rejects.toThrow(
      /no key-epoch encryption descriptor/
    )
    await expect(
      cipher.encryptUpdate({ id: 'row-1', data: DOC, current: DOC })
    ).rejects.toThrow(/no key-epoch encryption descriptor/)
    // The decrypt signal is the SAME one a stale descriptor produces, so the
    // store's unknown-epoch recovery re-reads the descriptor and retries. The
    // id is irrelevant: this cipher never has a descriptor to check it against.
    const decrypt = cipher.decrypt({ id: 'row-1', envelope: { any: 'thing' } })
    await expect(decrypt).rejects.toSatisfy(isUnknownEpochError)
  })
})
