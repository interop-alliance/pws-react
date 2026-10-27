/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The per-collection EDV document cipher: the local encrypt/decrypt seam. It
 * wraps the same `@interop/was-client` EDV codec the remote WAS handles use,
 * pointed at the local replica: `encrypt` turns a JSON document into its stored
 * EDV envelope (`{ id, sequence, jwe }`) minting a stable random resource id
 * (`idDerivation: 'random'`), and `encryptUpdate` re-encrypts a mutable head
 * document under its EXISTING id, advancing the envelope `sequence` from the
 * prior envelope. `decrypt` reverses it. The sync layer moves the envelope
 * verbatim; it never touches these keys.
 *
 * On a collection whose encryption descriptor declares a blinded-index key, the
 * cipher can also carry the collection's persisted index schema (supplied at
 * build time as `meta`, or installed afterwards through `applyMeta`), so the
 * envelopes it writes carry the same blinded `indexed` entries a direct write
 * through a collection handle emits -- which is what makes a pushed document
 * findable by an equality query.
 *
 * A PUBLIC (plaintext) collection uses {@link createPlaintextDocCodec} instead:
 * the same {@link DocCipher} seam with pass-through implementations, so the
 * storage layer above needs no encrypted-vs-plaintext fork.
 */
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import type { CollectionEncryption } from '@interop/was-client'
import { createEdvDocCipher, UnknownEpochError } from '@interop/was-client/edv'
import {
  IntegrityError,
  isEncryptedEnvelope,
  requireResourceId,
  type DocCipher as ClientDocCipher
} from '@interop/was-client/sync'
import type { Json } from '@interop/was-sync'

/**
 * A per-collection document cipher. `encrypt` is the create path (mints a random
 * envelope id); `encryptUpdate` is the in-place update path (re-encrypts under
 * an existing id, advancing `sequence` from the prior envelope); `decrypt`
 * reverses either, given the resource id the envelope is stored under -- the
 * caller's own row/resource id, not anything read out of the decrypted
 * payload, since the server controls that field -- and raises `IntegrityError`
 * when the envelope does not verify against it. An EDV (key-epoch) cipher
 * raises `IntegrityError` for one more reason: the roster's entry for this app
 * fails its key-wrap check, eagerly from {@link createDocCipher} for the write
 * epoch and on first decrypt for a lazily unwrapped read epoch (a malformed
 * entry, or no entry at all, is `KeyUnwrapError`). An EDV cipher also
 * surfaces the `epoch` id it encrypted under, which rides the content push as
 * the `Key-Epoch` header; the plaintext codec returns none.
 *
 * `applyMeta` is the blinded-index schema install hook an EDV cipher exposes:
 * given the collection's stored `/meta` value, it installs the persisted index
 * schema so subsequent writes emit blinded `indexed` entries. It is absent on
 * the pass-through plaintext codec and on the fail-closed placeholder, neither
 * of which has a schema to install -- hence optional here.
 *
 * `decrypt`'s return type is narrower than `@interop/was-client/sync`'s
 * `DocCipher['decrypt']` (`Json` rather than `Json | Blob`): no collection in
 * this repo writes a chunked (binary) document, so a `Blob` result never
 * occurs here. For the same reason the chunked-blob `context` / `spaceId`
 * wiring is left out of {@link createDocCipher}: nothing would call it.
 */
export interface DocCipher extends ClientDocCipher {
  encryptUpdate(options: {
    id: string
    data: Json
    current: Json
  }): Promise<{ id: string; envelope: Json; epoch?: string }>
  decrypt(options: Parameters<ClientDocCipher['decrypt']>[0]): Promise<Json>
  applyMeta?(options: { custom?: unknown }): Promise<unknown>
}

/**
 * Builds the pass-through codec for a PUBLIC (plaintext) collection: payloads
 * are stored as-is, and the stored resource id IS the payload's logical `id`
 * (uuid). With nothing to hide there is no reason for a second, opaque id
 * plane, and a public document then keeps a stable, shareable resource URL
 * across edits. `decrypt` verifies the one binding that IS real here (the row
 * id equals the payload's own `id`): a body read under a resource id that does
 * not match its own `id` field is a server serving one document's content
 * under another's URL, and `decrypt` raises `IntegrityError` rather than
 * silently returning the mismatched payload. A body carrying no string `id`
 * at all fails that binding the same way, and so does an EDV envelope (via
 * {@link isEncryptedEnvelope}): its `id` is a random envelope id, not a
 * logical uuid, so it is refused rather than mis-read. All three are one
 * failure, a stored row that is not a plaintext document bound to its resource
 * id, raised as one error so the storage layer above applies one rule to them
 * (a public collection takes writes from any grant holder, and such a row is
 * malformed data, not a broken seal). A caller that passes no resource id to
 * check against is refused outright by was-client's own `requireResourceId`,
 * the guard both of its built-in ciphers run first.
 *
 * @param options {object}
 * @param options.collectionId {string}   labels errors only
 * @returns {DocCipher}
 */
export function createPlaintextDocCodec({
  collectionId
}: {
  collectionId: string
}): DocCipher {
  const payloadId = (data: Json): string => {
    const id = (data as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `Plaintext write to collection "${collectionId}" carries no string "id".`
      )
    }
    return id
  }
  const assertPlaintext = (body: Json): Json => {
    if (isEncryptedEnvelope(body)) {
      throw new IntegrityError(
        `Collection "${collectionId}" is public (plaintext) but the stored ` +
          `row is an EDV envelope.`
      )
    }
    return body
  }

  return {
    async encrypt({ data }: { data: Json }) {
      return { id: payloadId(data), envelope: data }
    },

    async encryptUpdate({ id, data }: { id: string; data: Json }) {
      return { id, envelope: data }
    },

    async decrypt({ id, envelope }: { id: string; envelope: Json }) {
      // The same guard both of was-client's own ciphers run first: a decrypt
      // carrying no resource id would silently skip the binding check below.
      requireResourceId({ id, collectionId })
      const body = assertPlaintext(envelope)
      // Not `payloadId`: that helper words its error for a write. A stored
      // body with no usable `id` fails the same binding a mismatched one does.
      const bodyId = (body as { id?: unknown } | null)?.id
      if (bodyId !== id) {
        throw new IntegrityError(
          `Collection "${collectionId}" served a document under resource id ` +
            `"${id}" whose payload "id" is ${JSON.stringify(bodyId)}.`
        )
      }
      return body
    }
  }
}

/**
 * Builds a {@link DocCipher} for one collection from the caller's derived key
 * material (the app's identity X25519 key agreement key, the same one every
 * other collection uses). Keys are supplied directly (no
 * keystore lookup). `idDerivation: 'random'` mints a stable random id updated in
 * place via `sequence` -- the mutable head-document model every entity here uses
 * (constant bump / toggle / re-categorize edits).
 *
 * Delegates to `@interop/was-client`'s `createEdvDocCipher`, which requires an
 * epoch-bearing `encryption` descriptor (epoch-from-birth: every encrypted
 * collection carries a key-epoch roster from creation, and a rosterless
 * descriptor is refused fail-closed upstream). Writes stamp the descriptor's
 * current epoch and reads route by the envelope's recipient key id. For a
 * collection whose descriptor is not available yet, use
 * {@link createUnprovisionedDocCipher} instead. The returned cipher's shape
 * matches {@link DocCipher} exactly; only the nominal `Json` origin differs,
 * so it crosses the boundary with a cast.
 *
 * @param options {object}
 * @param options.keyAgreementKey {IKeyAgreementKey}
 * @param options.keyResolver {IKeyResolver}
 * @param options.collectionId {string}   labels errors; the codec is agnostic
 * @param options.encryption {CollectionEncryption}   the collection's
 *   encryption descriptor; must carry the key-epoch roster
 * @param [options.meta] {object}   the collection's stored `/meta` value as the
 *   replica holds it (its `custom` is the opaque encrypted metadata envelope,
 *   decrypted by the codec). When supplied and the descriptor declares a
 *   blinded-index key, the persisted index schema is installed, so writes emit
 *   blinded `indexed` entries. Without it, writes emit none -- exactly what an
 *   offline replica holding no collection metadata wrote before
 * @returns {Promise<DocCipher>}
 */
export async function createDocCipher({
  keyAgreementKey,
  keyResolver,
  collectionId,
  encryption,
  meta
}: {
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
  collectionId: string
  encryption: CollectionEncryption
  meta?: { custom?: unknown }
}): Promise<DocCipher> {
  const cipher = await createEdvDocCipher({
    keyAgreementKey,
    keyResolver,
    collectionId,
    idDerivation: 'random',
    encryption,
    ...(meta !== undefined && { meta })
  })
  return cipher as unknown as DocCipher
}

/**
 * The fail-closed placeholder cipher for a private collection whose
 * epoch-bearing encryption descriptor has not been read yet (an offline boot
 * before any sync has cached it). Writes refuse with a descriptive error
 * (there is no epoch to seal under); `decrypt` throws `UnknownEpochError`,
 * deliberately the same signal a stale epoch descriptor produces, so the
 * store's unknown-epoch recovery re-reads the collection's descriptor, swaps
 * in a real cipher, and retries -- a session that comes online recovers per
 * collection without a reboot.
 *
 * @param options {object}
 * @param options.collectionId {string}   labels errors only
 * @returns {DocCipher}
 */
export function createUnprovisionedDocCipher({
  collectionId
}: {
  collectionId: string
}): DocCipher {
  const refuseWrite = (): never => {
    throw new Error(
      `Collection "${collectionId}" has no key-epoch encryption descriptor ` +
        `yet; writes are refused until one is read from the server.`
    )
  }
  return {
    async encrypt() {
      return refuseWrite()
    },
    async encryptUpdate() {
      return refuseWrite()
    },
    // Ignores the caller's `id`: there is no descriptor to check a binding
    // against, and the point of this cipher is to fail the same way regardless
    // of what it is asked to open.
    async decrypt() {
      throw new UnknownEpochError({ collectionId, kids: [] })
    }
  }
}
