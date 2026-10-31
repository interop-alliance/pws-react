/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * A shared collection holding envelopes the client opens but does not admit: a
 * writer on an earlier envelope format, or a newer scheme version. The reader
 * must keep that apart from the expected not-a-recipient skip, or a wallet on
 * another format reads as an empty collection.
 *
 * Such an envelope cannot be sealed through the public cipher, and its header
 * cannot be rewritten after the fact (the AEAD covers it), so the real cipher's
 * `decrypt` is wrapped to raise pws-client's real error class for chosen ids.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EncryptionError } from '@interop/pws-client'
import {
  ownerRecipient,
  x25519RecipientFromDidKey
} from '@interop/pws-client/edv'
import { captureLogger } from '@interop/logger'
import { fakeRemoteStore } from '../fixtures/remoteStore.js'
import { mintRoster } from '../fixtures/roster.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { createDocCipher } from '../../src/storage/docCipher.js'
import { SharedCollectionReader } from '../../src/storage/sharedCollectionReader.js'
import { setLogger } from '../../src/log.js'

const { incompatibleIds } = vi.hoisted(() => ({
  incompatibleIds: new Set<string>()
}))

vi.mock('@interop/pws-client/edv', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@interop/pws-client/edv')>()
  return {
    ...actual,
    async createRefreshingEdvDocCipher(
      options: Parameters<typeof actual.createRefreshingEdvDocCipher>[0]
    ) {
      const cipher = await actual.createRefreshingEdvDocCipher(options)
      return {
        ...cipher,
        async decrypt(input: Parameters<typeof cipher.decrypt>[0]) {
          if (incompatibleIds.has(input.id)) {
            throw new EncryptionError(
              'Cannot decrypt this resource: its envelope carries no `pws` ' +
                'binding in the JWE protected header.'
            )
          }
          return await cipher.decrypt(input)
        }
      }
    }
  }
})

const APP_SEED = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff)
const OWNER_SEED = new Uint8Array(32).map((_, index) => (index * 5 + 11) & 0xff)
const COLLECTION_ID = 'private-credentials'

/**
 * Opens a reader over a collection of two sealed credentials, marking the first
 * incompatible, or both with `allIncompatible`.
 *
 * @param [options] {object}
 * @param [options.allIncompatible] {boolean}
 * @param [options.slowPath] {boolean}   a backend with no `changes` feed
 * @returns {Promise<object>}
 */
async function readerFixture({
  allIncompatible = false,
  slowPath = false
}: { allIncompatible?: boolean; slowPath?: boolean } = {}): Promise<{
  reader: SharedCollectionReader
  staleId: string
  soundId: string
  soundData: { id: string; title: string }
}> {
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
  const soundData = { id: 'credential-2', title: 'a current credential' }
  const staleSealed = await ownerCipher.encrypt({
    data: { id: 'credential-1', title: 'an old credential' }
  })
  const soundSealed = await ownerCipher.encrypt({ data: soundData })
  incompatibleIds.add(staleSealed.id)
  if (allIncompatible) {
    incompatibleIds.add(soundSealed.id)
  }
  const remoteStore = fakeRemoteStore({
    collectionId: COLLECTION_ID,
    encryption,
    resources: {
      [staleSealed.id]: staleSealed.envelope,
      [soundSealed.id]: soundSealed.envelope
    },
    changesNotImplemented: slowPath
  })
  const reader = await SharedCollectionReader.open({
    remoteStore,
    keyAgreementKey: app.keyAgreementKey,
    keyResolver: app.keyResolver,
    collectionId: COLLECTION_ID
  })
  return { reader, staleId: staleSealed.id, soundId: soundSealed.id, soundData }
}

afterEach(() => {
  incompatibleIds.clear()
})

describe('SharedCollectionReader over incompatible envelopes', () => {
  it('rejects a single read rather than answering "not there"', async () => {
    const { reader, staleId } = await readerFixture()
    await expect(reader.get(staleId)).rejects.toThrow(EncryptionError)
  })

  it('skips one at error level and lists the rest', async () => {
    const { reader, soundId, soundData } = await readerFixture()
    const capture = captureLogger('pr')
    const previous = setLogger(capture.logger)
    try {
      expect(await reader.list()).toEqual([{ id: soundId, data: soundData }])
    } finally {
      setLogger(previous)
    }
    const skips = capture.events.filter(event =>
      event.msg.includes('Skipping a resource')
    )
    expect(skips.map(event => event.level)).toEqual(['error'])
    expect(skips[0]?.msg).not.toMatch(/legacy/)
  })

  it('rejects a listing that decoded nothing', async () => {
    const { reader } = await readerFixture({ allIncompatible: true })
    await expect(reader.list()).rejects.toThrow(EncryptionError)
  })

  it('rejects the same way on the resource-listing fallback', async () => {
    const { reader } = await readerFixture({
      allIncompatible: true,
      slowPath: true
    })
    await expect(reader.list()).rejects.toThrow(EncryptionError)
  })
})
