/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The searchable-collection metadata fixture shared by the document-cipher and
 * local-store suites: the persisted blinded-index schema, and the stored
 * `/meta` `custom` value a collection carrying it holds (the opaque metadata
 * envelope, built through the very codec the direct Collection-handle path
 * writes it with). One copy, so a change to the codec's `encodeMeta` contract
 * lands in both suites at once.
 */
import { createEdvEncryption } from '@interop/was-client/edv'
import type {
  CollectionEncryption,
  ResourceMetadataCustom
} from '@interop/was-client'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'

/**
 * The persisted blinded-index schema a searchable collection's metadata holds.
 */
export const INDEX_SCHEMA = {
  revision: 1,
  indexes: [{ attribute: 'content.title', addedIn: 1 }]
}

/**
 * The stored `/meta` `custom` value a collection carrying {@link INDEX_SCHEMA}
 * holds.
 *
 * @param options {object}
 * @param options.encryption {CollectionEncryption}
 * @param options.collectionId {string}   the collection the envelope is
 *   AEAD-bound to
 * @param options.keys {object}   the reader's key material
 * @param options.keys.keyAgreementKey {IKeyAgreementKey}
 * @param options.keys.keyResolver {IKeyResolver}
 * @returns {Promise<unknown>}
 */
export async function encodeIndexSchemaMeta({
  encryption,
  collectionId,
  keys
}: {
  encryption: CollectionEncryption
  collectionId: string
  keys: { keyAgreementKey: IKeyAgreementKey; keyResolver: IKeyResolver }
}): Promise<unknown> {
  const provider = createEdvEncryption({ resolveKeys: async () => keys })
  const codec = await provider.codecFor({
    spaceUrl: 'https://was.example/space/space-1/',
    collectionId,
    scheme: 'edv',
    encryption
  })
  if (!codec) {
    throw new Error('Expected an EDV codec for the descriptor.')
  }
  codec.indexing?.applySchema(INDEX_SCHEMA)
  const { custom } = await codec.encodeMeta({
    custom: { indexSchema: INDEX_SCHEMA } as unknown as ResourceMetadataCustom,
    slot: { kind: 'collection' }
  })
  return custom
}
