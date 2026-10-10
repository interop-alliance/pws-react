/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * SharedCollectionReader: a READ-ONLY view over one wallet-owned encrypted
 * collection the wallet has shared with this app (the
 * `https://w3id.org/byoe#shared-wallet-collection` grant). It is the app-side
 * other half of the wallet's share flow, and it is read-only BY CONSTRUCTION --
 * there is no write verb on this class, the collection is never replicated
 * into RxDB, and the sync bootstrap never PUTs a description onto it.
 *
 * A share fuses two axes, and both are needed here:
 *
 * - **pull** -- the delegated `GET`/`HEAD` zcap on the collection, which is what
 *   the server checks at request time;
 * - **read** -- an entry in the collection's key-epoch roster, wrapped to this
 *   app's IDENTITY key-agreement key (the X25519 twin of its did:key
 *   controller, `IdentityAgents.keyAgreementKey`). That is the same key the
 *   app's own collections are encrypted with: one rule for every roster entry,
 *   whoever owns the collection.
 *
 * The stored resource body IS the EDV envelope the wallet's replication moved
 * verbatim, so reads must be RAW: the handle is opened with the
 * `encryption: 'plaintext'` override (the `WasClient`'s own encryption provider
 * is a deliberate no-op keystore) and the envelope is decrypted locally with a
 * cipher built from the collection's `encryption` descriptor.
 *
 * The honest ceiling, the same one the wallet's consent screen states:
 *
 * - access can be removed later, which stops FUTURE reads but cannot take back
 *   what has already been read;
 * - a share escrows this app into every existing epoch, so the collection's
 *   existing contents decrypt too; the one residue is pre-epoch legacy
 *   envelopes (single-recipient, written before the collection had any epoch
 *   roster), which are never re-encrypted and will not decrypt here. That is
 *   expected, not corruption -- they are skipped with a warning.
 */
import {
  isJsonResourceChange,
  isResourceChange,
  NotImplementedError
} from '@interop/was-client'
import type { Collection, CollectionEncryption } from '@interop/was-client'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import {
  createRefreshingEdvDocCipher,
  type EncryptionDescriptorCache,
  type EncryptionDescriptorSource
} from '@interop/was-client/edv'
import {
  isEncryptedEnvelope,
  isIntegrityError,
  type DocCipher
} from '@interop/was-client/sync'
import type { Json } from '@interop/was-sync'
import {
  remoteDescriptorSource,
  type WasRemoteStore
} from './wasRemoteStore.js'
import { log } from '../log.js'

/**
 * Default page size for the `changes`-feed walk. The server clamps its own
 * maximum, and a page shorter than what was asked for is the feed's end-of-walk
 * signal. Lower it on a collection of large envelopes to bound per-response
 * size.
 */
export const SHARED_CHANGES_PAGE_SIZE = 100

/**
 * The `changes`-feed resume position, read off the handle's own signature so
 * this module needs no direct dependency on the storage-core types package.
 */
type ChangesCheckpoint = NonNullable<
  Awaited<ReturnType<Collection['changes']>>['checkpoint']
>

/**
 * One decrypted resource of a shared collection: the WAS resource id (the
 * envelope id, opaque) and its decrypted payload.
 */
export interface SharedResource {
  id: string
  data: Json
}

/**
 * Thrown when a shared collection cannot be opened for reading: it carries no
 * multi-recipient key-epoch roster, or this app is not a recipient of any epoch
 * on it (the wallet never shared it, or a later un-share rotated the epoch off
 * this app's key).
 */
export class SharedCollectionUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SharedCollectionUnavailableError'
  }
}

export class SharedCollectionReader {
  readonly collectionId: string
  readonly #remoteStore: WasRemoteStore
  // Self-refreshing: it acquires the collection's descriptor when it is built
  // and, on a decrypt that meets an unknown key epoch, re-reads the descriptor,
  // swaps itself, and retries that decrypt -- exactly once per reader. An epoch
  // rotation emits no change-feed entry, so a stale descriptor is the expected
  // failure mode; one refresh per reader is enough to recover, and the cap keeps
  // a genuinely undecryptable envelope from looping. The refresh is memoized as
  // a PROMISE upstream, so bodies decrypting concurrently share the single
  // re-read instead of racing it.
  readonly #cipher: DocCipher
  // Whether the one-time "reading this collection the slow way" warning has
  // already been emitted for this reader.
  #warnedSlowPath = false
  readonly #pageSize: number

  private constructor({
    collectionId,
    remoteStore,
    cipher,
    pageSize
  }: {
    collectionId: string
    remoteStore: WasRemoteStore
    cipher: DocCipher
    pageSize: number
  }) {
    this.collectionId = collectionId
    this.#remoteStore = remoteStore
    this.#cipher = cipher
    this.#pageSize = pageSize
  }

  /**
   * Opens a reader over one shared collection: reads its `encryption` descriptor
   * through the delegated zcap and builds the epoch-aware cipher from it.
   *
   * Throws {@link SharedCollectionUnavailableError} when the collection carries
   * no descriptor or a descriptor with no key epochs (it is not multi-recipient, so this
   * app cannot be a recipient of it), and likewise when the cipher cannot unwrap
   * any epoch (this app is not, or is no longer, in the roster).
   *
   * @param options {object}
   * @param options.remoteStore {WasRemoteStore}   the delegated remote store
   * @param options.keyAgreementKey {IKeyAgreementKey}   this app's IDENTITY KAK
   * @param options.keyResolver {IKeyResolver}   its one-key resolver
   * @param options.collectionId {string}   the WAS collection id
   * @param [options.pageSize] {number}   `changes`-feed page size (defaults to
   *   {@link SHARED_CHANGES_PAGE_SIZE})
   * @returns {Promise<SharedCollectionReader>}
   */
  static async open({
    remoteStore,
    keyAgreementKey,
    keyResolver,
    collectionId,
    pageSize = SHARED_CHANGES_PAGE_SIZE
  }: {
    remoteStore: WasRemoteStore
    keyAgreementKey: IKeyAgreementKey
    keyResolver: IKeyResolver
    collectionId: string
    pageSize?: number
  }): Promise<SharedCollectionReader> {
    const cipher = await buildSharedCipher({
      collectionId,
      keyAgreementKey,
      keyResolver,
      source: remoteDescriptorSource({ remoteStore }),
      cache: memoryDescriptorCache()
    })
    return new SharedCollectionReader({
      collectionId,
      remoteStore,
      cipher,
      pageSize
    })
  }

  /**
   * Lists the LIVE resources of the shared collection, decrypted. A body that is
   * not an EDV envelope, a pre-epoch legacy envelope this app is not a
   * recipient of, or one sealed for a different resource id, is SKIPPED rather
   * than failing the whole listing. Only the last of those is logged at
   * `error`; `get()` surfaces it instead of skipping it.
   *
   * Two paths, same result. The fast path pages the `changes` feed
   * ({@link SharedCollectionReader.listViaChanges}), which returns whole pages of
   * documents WITH their bodies -- and on an encrypted collection those bodies
   * are exactly the opaque EDV envelopes wanted here, since the feed does not
   * decrypt. That is one round trip per PAGE rather than the one per RESOURCE a
   * listing plus a `get` each would cost, which on a wallet's
   * `private-credentials` or `contacts` is the difference between a handful of
   * requests and one per credential. It is also the same primitive replication
   * pulls with.
   *
   * The slow path ({@link SharedCollectionReader.listViaResources}) is the
   * fallback for a backend that does not advertise the `changes-query` feature
   * (it answers 501, surfaced as `NotImplementedError`): list the resource
   * summaries, then fetch each body. Taken only on that specific error, and
   * warned about once per reader.
   *
   * @returns {Promise<SharedResource[]>}
   */
  async list(): Promise<SharedResource[]> {
    const collection = this.#collectionHandle()
    try {
      return await this.#listViaChanges(collection)
    } catch (err) {
      if (!(err instanceof NotImplementedError)) {
        throw err
      }
      if (!this.#warnedSlowPath) {
        this.#warnedSlowPath = true
        log.warn(
          'A shared collection is being read the slow way (one request per ' +
            'resource): its backend does not support the "changes-query" ' +
            'feature the paged read path needs.',
          { collectionId: this.collectionId }
        )
      }
      return await this.#listViaResources(collection)
    }
  }

  /**
   * The fast path: walk the `changes` feed page by page, resuming from each
   * page's returned checkpoint, until a page comes back shorter than the
   * requested limit (the feed's "you have caught up" signal). Only
   * `kind: 'resource'` entries name a resource: the Collection's own records
   * (`collection-metadata`, `log`) and a kind this reader does not know are
   * skipped, and the next page still resumes from the page's own checkpoint.
   * A tombstone (`deleted`) and a resource whose content is not JSON drop any
   * body collected for the id, so the result is the LIVE set of JSON resources
   * -- the same semantics the resource-listing path has. A resource that
   * changes more than once within the walk appears under one id, so the last
   * body seen wins.
   */
  async #listViaChanges(collection: Collection): Promise<SharedResource[]> {
    const bodies = new Map<string, Json>()
    let checkpoint: ChangesCheckpoint | undefined
    for (;;) {
      const page = await collection.changes({
        ...(checkpoint && { checkpoint }),
        limit: this.#pageSize
      })
      for (const document of page.documents) {
        if (!isResourceChange(document)) {
          continue
        }
        // A tombstone, or a Resource whose content is not JSON (a binary or
        // `text/jsonl` one carries no inline `data`), drops any body collected
        // for the id. The handle refuses a live JSON entry with no `data`.
        if (document.deleted || !isJsonResourceChange(document)) {
          bodies.delete(document.id)
          continue
        }
        bodies.set(document.id, document.data as Json)
      }
      if (page.documents.length < this.#pageSize || !page.checkpoint) {
        break
      }
      checkpoint = page.checkpoint
    }
    // Decrypt the collected bodies concurrently: each is an independent unwrap
    // with no ordering dependency, so serializing the per-body WebCrypto work
    // would only add latency to the read.
    const decrypted = await Promise.all(
      [...bodies].map(async ([id, body]) => {
        const data = await this.#decryptForListing({ id, body })
        return data === undefined ? null : { id, data }
      })
    )
    return decrypted.filter(resource => resource !== null)
  }

  /**
   * The slow path: one listing request for the resource summaries, then one
   * request per resource for its body.
   */
  async #listViaResources(collection: Collection): Promise<SharedResource[]> {
    const listing = await collection.list()
    const items = listing?.items ?? []
    // Fetch and decrypt the resources concurrently: each is an independent
    // request plus unwrap, and `Promise.all` keeps the listing order.
    const resources = await Promise.all(
      items.map(async item => {
        const body = (await collection.get(item.id)) as Json | null
        const decrypted = await this.#decryptForListing({ id: item.id, body })
        return decrypted === undefined ? null : { id: item.id, data: decrypted }
      })
    )
    return resources.filter(resource => resource !== null)
  }

  /**
   * Reads and decrypts one resource of the shared collection by its WAS
   * resource id. Returns `undefined` for a missing resource, a body that is
   * not an EDV envelope, or an envelope this app cannot decrypt (each warned
   * about, distinguishably). An envelope sealed for a different resource id
   * raises `IntegrityError`: the caller asked for this one resource, so a
   * silent `undefined` would read as "not there".
   *
   * @param resourceId {string}   the WAS resource id
   * @returns {Promise<Json | undefined>}
   */
  async get(resourceId: string): Promise<Json | undefined> {
    const body = (await this.#collectionHandle().get(resourceId)) as Json | null
    return await this.#decryptBody({ id: resourceId, body })
  }

  /**
   * The RAW collection handle: the delegated zcap plus the
   * `encryption: 'plaintext'` override, so `get`/`list` return the stored EDV
   * envelope verbatim instead of routing it through the client's (no-op)
   * encryption provider.
   */
  #collectionHandle(): Collection {
    const capability = this.#remoteStore.collectionCapability(this.collectionId)
    if (!capability) {
      throw new SharedCollectionUnavailableError(
        `No delegated capability covers the shared collection ` +
          `"${this.collectionId}".`
      )
    }
    return this.#remoteStore.was
      .space(this.#remoteStore.spaceId)
      .collection(this.collectionId, { capability, encryption: 'plaintext' })
  }

  /**
   * Decrypts one fetched body, tolerating the two expected non-results: a body
   * that is not an EDV envelope at all, and a pre-epoch legacy envelope this
   * app is not a recipient of.
   *
   * The unknown-epoch recovery lives INSIDE the cipher (it re-reads the
   * descriptor, swaps itself, and retries once per reader), so three kinds of
   * failure reach this catch. A decrypt that stayed unreadable after the reader
   * spent its one refresh. One that raised an unknown epoch when the refresh was
   * already spent. And a `KeyUnwrapError` for an epoch the current descriptor
   * does list but this app holds no key for, which arrives without any refresh
   * being spent, because re-reading the descriptor could not help. That last one
   * is what a mid-session revoke looks like. All three are bodies this app
   * cannot read, and the reader's contract is to warn and skip them, never to
   * fail the listing: the listing degrades to the subset that still decrypts.
   *
   * An `IntegrityError` is a fourth kind and not a tolerated non-result: the
   * envelope was sealed for a different resource than the one it was read
   * under, which is the server serving one document's content under another's
   * URL. It propagates, since `get()`'s caller asked for exactly that resource
   * and a silent `undefined` would read as "not there". The listing paths
   * absorb it themselves ({@link SharedCollectionReader.#decryptForListing}).
   *
   * @param options {object}
   * @param options.id {string}   the WAS resource id the body was read under
   * @param options.body {Json | null}
   * @returns {Promise<Json | undefined>}
   */
  async #decryptBody({
    id,
    body
  }: {
    id: string
    body: Json | null
  }): Promise<Json | undefined> {
    if (body === null || body === undefined) {
      return undefined
    }
    if (!isEncryptedEnvelope(body)) {
      log.warn(
        'Skipping a resource of a shared collection: its body is not an EDV ' +
          'envelope.',
        { resourceId: id, collectionId: this.collectionId }
      )
      return undefined
    }
    try {
      // `id` is the WAS resource id this body was read under -- required so
      // the cipher's binding check runs. No collection read through a
      // `SharedCollectionReader` writes chunked (binary) documents, so the
      // `Blob` member of the upstream return type never occurs here.
      return (await this.#cipher.decrypt({ id, envelope: body })) as Json
    } catch (err) {
      // Not one of the tolerated non-results: the body was not sealed for the
      // id it was read under.
      if (isIntegrityError(err)) {
        throw err
      }
      return this.#skipUndecryptable({ id, err })
    }
  }

  /**
   * {@link SharedCollectionReader.#decryptBody} for the two listing paths,
   * which additionally skip a mis-bound envelope: one of them must not make a
   * wallet-owned collection this app can neither repair nor route around
   * unlistable. The skip is logged at `error` rather than `warn`, because
   * unlike the non-results `#decryptBody` absorbs it is never expected.
   *
   * @param options {object}
   * @param options.id {string}   the WAS resource id the body was read under
   * @param options.body {Json | null}
   * @returns {Promise<Json | undefined>}
   */
  async #decryptForListing({
    id,
    body
  }: {
    id: string
    body: Json | null
  }): Promise<Json | undefined> {
    try {
      return await this.#decryptBody({ id, body })
    } catch (err) {
      if (!isIntegrityError(err)) {
        throw err
      }
      log.error(
        'Skipping a resource of a shared collection: its envelope was ' +
          'sealed for a different resource than the id it is stored under.',
        { resourceId: id, collectionId: this.collectionId, err }
      )
      return undefined
    }
  }

  /**
   * Warns about, and skips, one envelope this app cannot decrypt. The
   * overwhelmingly likely cause is a pre-epoch legacy envelope -- a
   * single-recipient envelope written before the collection had any epoch
   * roster, sealed to the owner alone and never re-encrypted -- which is
   * expected rather than corruption, so it is called out by name.
   */
  #skipUndecryptable({ id, err }: { id: string; err: unknown }): undefined {
    log.warn(
      'Skipping a resource of a shared collection: this app is not a ' +
        'recipient of its envelope (expected for legacy resources written ' +
        'before the collection had an epoch roster -- those stay sealed to ' +
        'the owner alone and are never re-encrypted).',
      { resourceId: id, collectionId: this.collectionId, err }
    )
    return undefined
  }
}

/**
 * The reader's descriptor cache: a plain in-memory Map, one per reader. Nothing
 * about a WALLET-owned collection belongs in this app's offline descriptor
 * cache (that one is keyed by the app's own collection ids and survives a
 * reload); here the cache exists only so the self-refreshing cipher has the
 * durable seam it is written against, and so the descriptor it acquired at open
 * can be inspected afterwards.
 *
 * @returns {EncryptionDescriptorCache}
 */
function memoryDescriptorCache(): EncryptionDescriptorCache {
  const descriptors = new Map<string, CollectionEncryption>()
  return {
    async readDescriptor({ collectionId }: { collectionId: string }) {
      return descriptors.get(collectionId)
    },
    async writeDescriptor({
      collectionId,
      descriptor
    }: {
      collectionId: string
      descriptor: CollectionEncryption
    }) {
      descriptors.set(collectionId, descriptor)
    }
  }
}

/**
 * Builds the self-refreshing epoch-aware cipher for a shared collection,
 * turning the two "cannot read this collection" outcomes into one descriptive
 * error: no multi-recipient roster at all, and a roster this app is not in.
 *
 * The build is the reader's ONE descriptor read at open (`acquireDescriptor`
 * fetches through `source` and caches the result), so the roster check below
 * reads the cache rather than fetching a second time. A descriptor with no
 * epochs builds a single-key cipher rather than throwing, which is why the
 * no-roster case is detected after the build and not before it.
 *
 * Only the cipher's `decrypt` is ever exercised here -- the reader has no write
 * path -- so the seam's write-side id model is irrelevant and left at its
 * default.
 *
 * @param options {object}
 * @param options.collectionId {string}
 * @param options.keyAgreementKey {IKeyAgreementKey}
 * @param options.keyResolver {IKeyResolver}
 * @param options.source {EncryptionDescriptorSource}
 * @param options.cache {EncryptionDescriptorCache}
 * @returns {Promise<DocCipher>}
 */
async function buildSharedCipher({
  collectionId,
  keyAgreementKey,
  keyResolver,
  source,
  cache
}: {
  collectionId: string
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
  source: EncryptionDescriptorSource
  cache: EncryptionDescriptorCache
}): Promise<DocCipher> {
  let cipher: DocCipher
  try {
    cipher = (await createRefreshingEdvDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId,
      source,
      cache
    })) as unknown as DocCipher
  } catch (err) {
    throw new SharedCollectionUnavailableError(
      `Cannot read shared collection "${collectionId}": this app is not a ` +
        `recipient of any of its key epochs. The wallet has not shared it ` +
        `with this app, or access was removed (removing access rotates the ` +
        `epoch off this app's key).`,
      { cause: err }
    )
  }
  const encryption = await cache.readDescriptor({ collectionId })
  if (!encryption?.epochs || encryption.epochs.length === 0) {
    throw new SharedCollectionUnavailableError(
      `Shared collection "${collectionId}" carries no key-epoch roster, so it ` +
        `is not multi-recipient and this app cannot be a recipient of it. The ` +
        `wallet has not shared it with this app.`
    )
  }
  return cipher
}
