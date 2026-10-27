/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The key-epoch roster fixture shared by the shared-collection and
 * standing-credential suites: an in-memory descriptor store for was-client's
 * recipient operations, a one-epoch mint over it, and the rotation that
 * produces a genuine second epoch. One copy, so a change to the recipient
 * operations' signatures lands in both suites at once.
 */
import {
  initRecipients,
  removeRecipient,
  trustRosterDidKeys
} from '@interop/was-client/edv'
import type { EncryptionDescriptorStore } from '@interop/was-client/edv'
import type { CollectionEncryption } from '@interop/was-client'

/**
 * A fixed 32-byte seed for a second identity, so a roster can carry a
 * recipient that is not the app under test.
 */
export const FOREIGN_SEED = new Uint8Array(32).map(
  (_, index) => (index * 5 + 1) & 0xff
)

/**
 * An in-memory `EncryptionDescriptorStore`, the seam the recipient operations
 * mutate a descriptor through: a read with its validator, a compare-and-swap
 * replace, and the create-if-absent branch a store that starts empty takes.
 *
 * @param [descriptor] {CollectionEncryption}   the descriptor the store starts
 *   with; absent, the first `initRecipients` creates it
 * @returns {EncryptionDescriptorStore}
 */
function memoryDescriptorStore(
  descriptor?: CollectionEncryption
): EncryptionDescriptorStore {
  let current = descriptor
  return {
    async read() {
      return current === undefined
        ? null
        : { descriptor: current, etag: 'etag-0' }
    },
    async replace(next) {
      current = next
    },
    async create(next) {
      current = next
    }
  }
}

/**
 * Mints a one-epoch roster, with the wallet owner as recipient zero and any
 * app recipients alongside it.
 *
 * @param options {object}
 * @param options.recipients {object[]}
 * @returns {Promise<CollectionEncryption>}
 */
export async function mintRoster({
  recipients
}: {
  recipients: Parameters<typeof initRecipients>[0]['recipients']
}): Promise<CollectionEncryption> {
  return initRecipients({ store: memoryDescriptorStore(), recipients })
}

/**
 * Rotates a roster by removing one recipient, producing a descriptor with a
 * SECOND epoch wrapped to everyone who remains. The wallet does exactly this
 * when a share is withdrawn; here it is the cheapest way to obtain a genuine
 * two-epoch descriptor whose current epoch a stale reader has never seen. The
 * pull axis (zcap revocation in the wallet) is a no-op here.
 *
 * @param options {object}
 * @param options.descriptor {CollectionEncryption}
 * @param options.removeKid {string}
 * @returns {Promise<CollectionEncryption>}
 */
export async function rotateRoster({
  descriptor,
  removeKid
}: {
  descriptor: CollectionEncryption
  removeKid: string
}): Promise<CollectionEncryption> {
  return removeRecipient({
    store: memoryDescriptorStore(descriptor),
    recipientId: removeKid,
    async pull() {},
    resolveRecipientKey: trustRosterDidKeys
  })
}

/**
 * Copies a roster with one recipient entry's wrapped epoch key damaged: the
 * `encrypted_key` keeps its length and stays valid base64url, so it decodes
 * and then fails the AES-KW integrity check. That is what a corrupt or
 * tampered entry addressed to a reader looks like, and was-client raises
 * `IntegrityError` for it rather than `KeyUnwrapError` (which a malformed
 * entry, or no entry at all, keeps raising).
 *
 * @param options {object}
 * @param options.descriptor {CollectionEncryption}
 * @param options.kid {string}   the recipient's key id (`header.kid`)
 * @param [options.epochId] {string}   the epoch to damage the entry in; the
 *   descriptor's current epoch by default
 * @returns {CollectionEncryption}
 */
export function corruptRecipientEntry({
  descriptor,
  kid,
  epochId = descriptor.currentEpoch
}: {
  descriptor: CollectionEncryption
  kid: string
  epochId?: string
}): CollectionEncryption {
  const copy = structuredClone(descriptor)
  const epoch = copy.epochs?.find(candidate => candidate.id === epochId)
  const entry = epoch?.recipients.find(
    recipient => recipient.header.kid === kid
  )
  if (!entry) {
    throw new Error(`No entry for kid "${kid}" in epoch "${epochId}".`)
  }
  const wrapped = entry.encrypted_key
  const index = Math.floor(wrapped.length / 2)
  const flipped = wrapped[index] === 'A' ? 'B' : 'A'
  entry.encrypted_key =
    wrapped.slice(0, index) + flipped + wrapped.slice(index + 1)
  return copy
}
