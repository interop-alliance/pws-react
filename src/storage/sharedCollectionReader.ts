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
import { NotImplementedError } from '@interop/was-client'
import type { Collection } from '@interop/was-client'
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
import type { WasRemoteStore } from './wasRemoteStore.js'
import {
  fetchErrorSink,
  isDescriptorRefusal,
  memoryDescriptorCache
} from './governedDescriptors.js'
import { log } from '../log.js'

/**
 * Default page size for the `changes`-feed walk. The server clamps its own
 * maximum, and a page shorter than what was asked for is the feed's end-of-walk
 * signal. Lower it on a collection of large envelopes to bound per-response
 * size.
 */
export const SHARED_CHANGES_PAGE_SIZE = 100

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
      source: remoteStore.descriptorSource,
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
   * The fast path: was-client's `documents()` walk over the `changes` feed,
   * which pages the feed to its end, keeps only live JSON Resources (the
   * Collection's own records, tombstones, and binary or `text/jsonl` Resources
   * drop out, a rewritten id keeps its last body), and returns each stored
   * body undecrypted -- the LIVE set, the same semantics the resource-listing
   * path has. A collection that is missing or not visible answers `null`,
   * which lists as empty, like the slow path.
   */
  async #listViaChanges(collection: Collection): Promise<SharedResource[]> {
    const documents =
      (await collection.documents({ limit: this.#pageSize })) ?? []
    // Decrypt the collected bodies concurrently: each is an independent unwrap
    // with no ordering dependency, so serializing the per-body WebCrypto work
    // would only add latency to the read.
    const decrypted = await Promise.all(
      documents.map(async ({ id, data }) => {
        const payload = await this.#decryptForListing({
          id,
          body: data as Json
        })
        return payload === undefined ? null : { id, data: payload }
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
   * An `IntegrityError` is a fourth kind and not a tolerated non-result. It
   * has two sources. The envelope was sealed for a different resource than
   * the one it was read under, which is the server serving one document's
   * content under another's URL. Or the envelope's epoch is one the cipher
   * unwraps lazily, and the roster's entry for this app in it fails its
   * key-wrap check on that first decrypt, which is a corrupt or tampered
   * entry. Either propagates, since `get()`'s caller asked for exactly that
   * resource and a silent `undefined` would read as "not there". The listing
   * paths absorb it themselves
   * ({@link SharedCollectionReader.#decryptForListing}).
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
   * which additionally skip an `IntegrityError` (a mis-bound envelope, or an
   * epoch whose roster entry for this app fails its key-wrap check): one of
   * them must not make a wallet-owned collection this app can neither repair
   * nor route around unlistable. The skip is logged at `error` rather than
   * `warn`, because unlike the non-results `#decryptBody` absorbs it is never
   * expected.
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
          'sealed for a different resource than the id it is stored under, ' +
          "or this app's roster entry for its key epoch fails its key-wrap " +
          'check.',
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
 * Builds the self-refreshing epoch-aware cipher for a shared collection,
 * turning the two "cannot read this collection" outcomes into one descriptive
 * error: no multi-recipient roster at all, and a roster this app is not in. A
 * roster that names this app in its current epoch with an entry that fails
 * its key-wrap check is neither: the build raises `IntegrityError` for it,
 * and that is rethrown as itself, like a descriptor refusal.
 *
 * The build is the reader's ONE descriptor read at open (`acquireDescriptor`
 * fetches through `source` and caches the result), so the roster check below
 * reads the cache rather than fetching a second time. A descriptor with no
 * epochs builds a single-key cipher rather than throwing, which is why the
 * no-roster case is detected after the build and not before it. A fetch that
 * fails is a third outcome, kept apart from both: it is rethrown as itself
 * rather than read as a missing share.
 *
 * The acquisition runs under `requireGoverned`: the source must declare
 * `verifiesHistory` (the store's log-governed source does), and the build and
 * every later unknown-epoch refresh adopt only a verified log head. The cache
 * is the reader's own in-memory one: nothing about a WALLET-owned collection
 * belongs in this app's offline descriptor cache, and the cache exists here
 * so the self-refreshing cipher has the seam it is written against and so the
 * descriptor acquired at open can be inspected afterwards.
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
  // A fetch that fails during the build is swallowed by `acquireDescriptor`
  // (it falls back to the cache, empty here), which would make an outage read
  // as "not a recipient". It is rethrown as itself, whether the build then
  // fails or completes, so "unknown" stays apart from "no share"; a fetch
  // failure met by a later unknown-epoch refresh is the cipher's own concern.
  const sink = fetchErrorSink()
  try {
    cipher = (await createRefreshingEdvDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId,
      source,
      cache,
      requireGoverned: true,
      onFetchError: sink.onFetchError
    })) as unknown as DocCipher
  } catch (err) {
    // A build that fails over a swallowed fetch failed because of it.
    sink.rethrow()
    // A refusal is a wiring fault or a security signal, not a share this app
    // lacks, so it is surfaced as itself rather than as "not a recipient".
    // So is an `IntegrityError`: the roster names this app, and its entry
    // fails its key-wrap check, which is a corrupt or tampered entry rather
    // than a share this app was never given.
    if (isDescriptorRefusal(err) || isIntegrityError(err)) {
      throw err
    }
    throw new SharedCollectionUnavailableError(
      `Cannot read shared collection "${collectionId}": this app is not a ` +
        `recipient of any of its key epochs. The wallet has not shared it ` +
        `with this app, or access was removed (removing access rotates the ` +
        `epoch off this app's key).`,
      { cause: err }
    )
  }
  sink.rethrow()
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
