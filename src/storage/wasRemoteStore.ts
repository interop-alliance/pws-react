/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WasRemoteStore (delegated-only): the view of the user's WAS Space held by the
 * requester (an app, service, or agent), stripped to the delegated model --
 * this app NEVER provisions the Space, never
 * derives the spaceId, and never touches the `id` collection or DID publishing.
 * It receives a set of wallet-delegated zcaps, reads the server URL + space id
 * straight out of their `invocationTarget`s ({@link parseGrants}), and holds:
 *
 * - a `WasClient` wrapping the app's own `ZcapClient` (its invocation signer is
 *   the seed-derived controller the grants were delegated to);
 * - per-collection capability routing, so each sync request invokes the exact
 *   collection grant;
 * - one raw read of a collection's Metadata object
 *   ({@link WasRemoteStore.readCollectionMeta}): the `encryption` descriptor,
 *   the `plaintext` declaration, and the opaque `custom` envelope arrive as one
 *   object under one validator, so every consumer here reads it once;
 * - two best-effort declarations written back onto that object, each a merge
 *   into the object the caller read (`Collection.configure`, which carries
 *   every other member forward and rebases on a lost race; under WAS v0.5 the
 *   `PUT` at `meta` is a full replacement, so a partial body would clear the
 *   members the caller never read): the `{ scheme: 'edv' }` encryption
 *   descriptor on a private
 *   collection that carries none (whether a delegated collection-scoped RW
 *   zcap authorizes the write is the server's call; non-fatal either way, since
 *   envelopes replicate into an unmarked collection just the same, and a
 *   PUBLIC collection is never marked because public implies plaintext), and
 *   the `plaintext.indexes` list on a public one;
 * - the blinded-index schema write for private ones
 *   ({@link WasRemoteStore.declareBlindedIndexes}) -- plus the equality query
 *   verb itself ({@link WasRemoteStore.queryCollectionByEquality}), which
 *   routes on the collection's visibility: the canonical sorted
 *   `filter[attr]=value` GET for a public collection, the client-blinded
 *   `blinded-index` query for a private one, both parsed into the same
 *   `{ documents, hasMore, cursor? }` page shape.
 */
import type { ZcapClient } from '@interop/ezcap'
import type {
  IKeyAgreementKey,
  IKeyResolver,
  IZcap
} from '@interop/data-integrity-core'
import {
  NotFoundError,
  NotImplementedError,
  WasClient,
  mapError
} from '@interop/was-client'
import type {
  Collection,
  CollectionEncryption,
  CollectionMetadata,
  CollectionWritableFields
} from '@interop/was-client'
import { createEdvEncryption } from '@interop/was-client/edv'
import type { EncryptionDescriptorSource } from '@interop/was-client/edv'
import { collectionPath, resourcePath, toUrl } from '@interop/was-client/paths'
import { errorStatus, errorMessage } from '@interop/was-client/sync'
import type { WasCollectionConfig } from '../config.js'
import type { ParsedGrants } from '../grants.js'
import { log } from '../log.js'

/**
 * The outcome of a best-effort declaration write (the encryption descriptor,
 * the public `indexes` list, or the blinded-index schema), for diagnostics.
 */
export interface DeclarationResult {
  collectionId: string
  ok: boolean
  status?: number
  error?: string
  /**
   * True when no write was attempted -- the declaration does not apply to this
   * collection at all (e.g. the encryption descriptor on a public collection),
   * or it already carries an `encryption` block (e.g. an epoch roster the wallet
   * provisioned at consent time, which a bare-descriptor write must never
   * clobber). Reported as `ok` since the goal state holds either way.
   */
  skipped?: boolean
  /**
   * Whether the declaration actually landed a write on the collection's
   * Metadata object, as opposed to finding the goal state already in place.
   * Reported by {@link WasRemoteStore.declareBlindedIndexes}, so a caller
   * holding a copy of the object read before the declaration knows whether
   * that copy is still current.
   */
  wrote?: boolean
}

/**
 * One collection's Metadata object as `readCollectionMeta` returns it:
 * was-client's own `describeWithEtag` shape.
 */
export type CollectionMetaRead = NonNullable<
  Awaited<ReturnType<Collection['describeWithEtag']>>
>

/**
 * One page of equality-query results: the shared shape of the GET
 * `filter[attr]=value` filter and the POST `equality` query profile. `data` is
 * the stored JSON content (absent for a blob resource); `custom` is the
 * resource's custom metadata object, present when it has one. The opaque
 * `cursor` continues the page walk when `hasMore` is true.
 */
export interface EqualityQueryPage {
  documents: Array<{ id: string; data?: unknown; custom?: unknown }>
  hasMore: boolean
  cursor?: string
}

/**
 * What one registered collection contributes to request routing: its effective
 * visibility and its declared equality indexes.
 */
type CollectionRouting = {
  visibility: 'private' | 'public'
  indexes?: string[]
}

/**
 * Maps one configured index attribute name to the blinded-index attribute path
 * the EDV codec addresses it by. The codec walks the path from the stored
 * document's root, and a JSON payload is written as that document's `content`
 * verbatim, so an app-level `author` is `content.author`.
 *
 * @param name {string}   the attribute name as declared in the collection config
 * @returns {string}
 */
function blindedAttribute(name: string): string {
  return `content.${name}`
}

/**
 * Runs one read whose failure may mean "absent" rather than "unknown". An
 * error `isAbsent` accepts answers `undefined`; any other failure is rethrown,
 * wrapped with `description`, so the caller cannot mistake an unknown answer
 * (a dropped connection, a 5xx) for an absent one. Retrying is not this
 * layer's job: the HTTP client underneath already retries the transient
 * status codes and network errors on every GET.
 *
 * @param options {object}
 * @param options.read {() => Promise<T>}
 * @param options.isAbsent {(err: Error) => boolean}   which mapped errors mean
 *   "absent"
 * @param options.description {string}   what was being read, for the wrap
 * @returns {Promise<T | undefined>}
 */
async function readOrAbsent<T>({
  read,
  isAbsent,
  description
}: {
  read: () => Promise<T>
  isAbsent: (err: Error) => boolean
  description: string
}): Promise<T | undefined> {
  try {
    return await read()
  } catch (err) {
    const mapped = mapError(err)
    if (isAbsent(mapped)) {
      return undefined
    }
    // The mapped (typed) error carries the caught one as its own `cause`, so
    // the chain is intact; the typed one is what callers match on.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Failed to read ${description}.`, { cause: mapped })
  }
}

/**
 * One entry of a Collection Metadata object's `plaintext.indexes` declaration,
 * as the client types it.
 */
type DeclaredIndex = NonNullable<
  NonNullable<CollectionMetadata['plaintext']>['indexes']
>[number]

/**
 * Whether a stored `plaintext.indexes` declaration already says what the
 * configured list says, compared in the server's normalized shape (a bare
 * string is `{ name, source: 'content', unique: false }`) and in order.
 *
 * @param stored {DeclaredIndex[]}   the declaration read from the object
 * @param configured {DeclaredIndex[]}   the configured list
 * @returns {boolean}
 */
function sameIndexDeclaration(
  stored: DeclaredIndex[],
  configured: DeclaredIndex[]
): boolean {
  const normalize = (entry: DeclaredIndex): string =>
    typeof entry === 'string'
      ? `${entry}\0content\0false`
      : `${entry.name}\0${entry.source ?? 'content'}\0${entry.unique === true}`
  return (
    stored.length === configured.length &&
    stored.map(normalize).join('\n') === configured.map(normalize).join('\n')
  )
}

/**
 * Turns a caught declaration-write failure into a {@link DeclarationResult}:
 * the HTTP status when the mapped error carries one, and its message.
 * Shared by every declaration write's catch block -- the encryption
 * descriptor, the public `indexes` list, and the blinded-index schema --
 * so a refused or raced write is reported rather than thrown, uniformly.
 *
 * @param collectionId {string}   the WAS collection id
 * @param err {unknown}   the caught error
 * @returns {DeclarationResult}
 */
function declarationFailure(
  collectionId: string,
  err: unknown
): DeclarationResult {
  const status = errorStatus(err)
  const message = errorMessage(err)
  return {
    collectionId,
    ok: false,
    ...(status !== undefined && { status }),
    error: message
  }
}

export class WasRemoteStore {
  public readonly was: WasClient
  public readonly serverUrl: string
  public readonly spaceId: string
  readonly #byCollectionId: Record<string, IZcap>
  // Per WAS collection id: the effective visibility + declared equality
  // indexes (the registry guarantees one declaration per id).
  readonly #configById: Map<string, CollectionRouting>
  // Whether `fromGrants` was given this app's identity keys, i.e. whether the
  // client's EDV keystore can build a codec (the blinded-index verbs need one).
  readonly #hasIdentityKeys: boolean

  private constructor({
    was,
    parsed,
    configById,
    hasIdentityKeys
  }: {
    was: WasClient
    parsed: ParsedGrants
    configById: Map<string, CollectionRouting>
    hasIdentityKeys: boolean
  }) {
    this.was = was
    this.serverUrl = parsed.serverUrl
    this.spaceId = parsed.spaceId
    this.#byCollectionId = parsed.byCollectionId
    this.#configById = configById
    this.#hasIdentityKeys = hasIdentityKeys
  }

  /**
   * Builds a delegated remote store from a parsed grant set and the app's
   * ZcapClient (whose invocation signer is the controller the grants target).
   *
   * Replication itself needs no keystore at all: it moves opaque envelopes
   * verbatim through `was.request()`, which bypasses the codec, and
   * encrypt/decrypt is a local read/write concern. The keystore matters only
   * for the codec-driven verbs -- the blinded-index query and schema
   * declaration -- so it answers with the app's identity keys when they are
   * supplied and with `null` (fail-closed: "this client holds no keys for that
   * collection") when they are not. The blinding key itself is never passed
   * here: the codec unwraps it from the collection's own encryption descriptor,
   * so a collection provisioned without one simply has no blinded index.
   *
   * @param options {object}
   * @param options.parsed {ParsedGrants}
   * @param options.zcapClient {ZcapClient}
   * @param [options.collections] {WasCollectionConfig[]}   the collection
   *   registry; entries with `visibility: 'public'` are never marked encrypted
   * @param [options.keys] {object}   this app's identity key-agreement key and
   *   its resolver (the same pair `IdentityAgents` carries)
   * @param options.keys.keyAgreementKey {IKeyAgreementKey}
   * @param options.keys.keyResolver {IKeyResolver}
   * @returns {WasRemoteStore}
   */
  static fromGrants({
    parsed,
    zcapClient,
    collections = [],
    keys
  }: {
    parsed: ParsedGrants
    zcapClient: ZcapClient
    collections?: WasCollectionConfig[]
    keys?: {
      keyAgreementKey: IKeyAgreementKey
      keyResolver: IKeyResolver
    }
  }): WasRemoteStore {
    const was = new WasClient({
      serverUrl: parsed.serverUrl,
      zcapClient,
      encryption: createEdvEncryption({
        resolveKeys: async () => keys ?? null
      })
    })
    const configById = new Map<string, CollectionRouting>(
      collections.map(entry => [
        entry.id,
        {
          visibility: entry.visibility ?? 'private',
          ...(entry.indexes && { indexes: entry.indexes })
        }
      ])
    )
    return new WasRemoteStore({
      was,
      parsed,
      configById,
      hasIdentityKeys: keys !== undefined
    })
  }

  /**
   * The delegated capability for one WAS collection, or `undefined` when no
   * grant covers it (the sync port then invokes without a capability and the
   * server denies it -- the intended fail-closed mode).
   *
   * @param collectionId {string}   the WAS collection id
   * @returns {IZcap | undefined}
   */
  collectionCapability(collectionId: string): IZcap | undefined {
    return this.#byCollectionId[collectionId]
  }

  /**
   * The navigational handle for one collection, bound to its delegated
   * capability: every codec-driven or description-level verb here goes
   * through it, so the routing is written once.
   *
   * @param collectionId {string}   the WAS collection id
   * @param capability {IZcap}   the delegated zcap covering it
   * @returns {Collection}
   */
  #collection(collectionId: string, capability: IZcap): Collection {
    return this.was.space(this.spaceId).collection(collectionId, { capability })
  }

  /**
   * The shared tail of a best-effort `configure`-based declaration write onto
   * one collection's Metadata object: {@link markCollectionEncrypted} and
   * {@link declareCollectionIndexes} both end here. With no readable object
   * there is nothing to merge into, and writing a bare change would replace
   * the whole object under WAS v0.5's full-replacement `PUT`: the write is
   * refused and reported NOT ok rather than attempted.
   *
   * `change` is called only once `current` is known to be present, and may
   * itself report "nothing to do" by returning `undefined` -- the caller's
   * own skip condition (a stored declaration already matching the configured
   * one), evaluated against the object this method guarantees is there.
   *
   * The write merges into the object the caller already read
   * (`Collection.configure`, which carries every other member -- `name`,
   * `backend`, the `custom` envelope -- forward and rebases on a lost race,
   * pinned to the read's validator).
   *
   * @param collectionId {string}   the WAS collection id
   * @param options {object}
   * @param options.current {CollectionMetaRead | undefined}   the collection's
   *   Metadata object as the caller read it, the merge baseline
   * @param options.change {(current: CollectionMetaRead) => CollectionWritableFields | undefined}
   *   the fields to merge over `current.description`, or `undefined` to skip
   *   the write (the goal state already holds)
   * @returns {Promise<DeclarationResult>}
   */
  async #configure(
    collectionId: string,
    {
      current,
      change
    }: {
      current: CollectionMetaRead | undefined
      change: (
        current: CollectionMetaRead
      ) => CollectionWritableFields | undefined
    }
  ): Promise<DeclarationResult> {
    const capability = this.collectionCapability(collectionId)
    if (!capability) {
      return { collectionId, ok: false, error: 'no capability' }
    }
    if (!current) {
      return {
        collectionId,
        ok: false,
        error:
          'the collection metadata object was not read, so there is nothing ' +
          'to merge the declaration into'
      }
    }
    const fields = change(current)
    if (!fields) {
      return { collectionId, ok: true, skipped: true }
    }
    try {
      await this.#collection(collectionId, capability).configure({
        ...fields,
        current: {
          ...current.description,
          ...(current.etag !== undefined && { etag: current.etag })
        }
      })
      return { collectionId, ok: true }
    } catch (err) {
      return declarationFailure(collectionId, err)
    }
  }

  /**
   * Reads one collection's Metadata object RAW, invoked with that collection's
   * delegated zcap: the `encryption` descriptor, the public `plaintext`
   * declaration, and the `custom` envelope, as one object under one `ETag`
   * validator (returned beside it as `etag` when the backend serves one). On
   * an encrypted collection the returned `custom` is the opaque metadata
   * envelope exactly as stored -- which is what the local
   * store's cipher wants, since it decodes the envelope itself (`applyMeta`)
   * to recover the persisted blinded-index schema. Deliberately NOT
   * `Collection.meta()`: that one DECODES `custom` to plaintext, which
   * `applyMeta` cannot consume.
   *
   * Answers `undefined` for exactly the outcomes that mean "no object": no
   * capability covers the collection, the read answered not-found (which is
   * also how WAS answers an unauthorized read), or the backend has no metadata
   * support (`501`). Any other failure (a dropped connection, a 5xx) is
   * thrown, wrapped with the collection id. It must NOT read as "no object":
   * a caller that takes it for one opens the collection under the fail-closed
   * placeholder cipher, skips the blinded-index install over a guess, or
   * writes a declaration over a roster it never saw.
   *
   * @param collectionId {string}   the WAS collection id
   * @returns {Promise<CollectionMetaRead | undefined>}
   */
  async readCollectionMeta(
    collectionId: string
  ): Promise<CollectionMetaRead | undefined> {
    const capability = this.collectionCapability(collectionId)
    if (!capability) {
      return undefined
    }
    return await readOrAbsent({
      read: async () =>
        (await this.#collection(collectionId, capability).describeWithEtag()) ??
        undefined,
      isAbsent: err =>
        err instanceof NotFoundError || err instanceof NotImplementedError,
      description: `the metadata object of collection "${collectionId}"`
    })
  }

  /**
   * Reads one collection's `encryption` descriptor: the {@link readCollectionMeta}
   * read, narrowed to its {@link CollectionEncryption} member (a
   * multi-recipient descriptor carries key epochs). It is the
   * `EncryptionDescriptorSource` seam and the login-time read, so it keeps
   * that read's contract: `undefined` only when the answer is genuinely "no
   * descriptor" (no capability, not-found, no metadata support, or an object
   * with no `encryption` member), and a throw for every other failure, which
   * must not be taken for "no descriptor" -- a correctly provisioned
   * collection would then fail its first write or decrypt for a network
   * hiccup.
   *
   * @param collectionId {string}   the WAS collection id
   * @returns {Promise<CollectionEncryption | undefined>}
   */
  async readCollectionEncryption(
    collectionId: string
  ): Promise<CollectionEncryption | undefined> {
    const read = await this.readCollectionMeta(collectionId)
    return read?.description.encryption
  }

  /**
   * Best-effort declaration of the `{ encryption: { scheme: 'edv' } }` descriptor on
   * one collection, invoked with that collection's delegated RW zcap. Non-fatal:
   * returns the outcome rather than throwing, so a server that does not authorize
   * a delegated write of the Metadata object leaves replication untouched (the
   * collection simply stays unmarked / plaintext, which still stores envelopes).
   * A PUBLIC collection is never marked (public implies plaintext): the write is
   * skipped and reported as `ok` + `skipped`.
   *
   * A collection that ALREADY carries an `encryption` block is also skipped: the
   * wallet provisions a multi-recipient epoch roster on the descriptor at consent
   * time, and overwriting it with the bare `{ scheme: 'edv' }` descriptor would
   * destroy that roster. So this method is a no-op fallback for servers/wallets
   * that did not provision the roster. The caller passes the descriptor it
   * knows for the collection (read off `current`, or from an earlier live
   * read), and the skip is checked before the merge baseline is even looked
   * for: a collection already carrying a roster needs no write regardless of
   * whether its object was read this bring-up.
   *
   * With no readable object there is nothing to merge into, and a blind write
   * would replace the whole object with a bare descriptor: the write is
   * refused and reported NOT ok instead (the shared merge tail below).
   *
   * @param collectionId {string}   the WAS collection id
   * @param options {object}
   * @param [options.current] {CollectionMetaRead}   the collection's Metadata
   *   object as the caller read it, the baseline the declaration merges into;
   *   absent when the caller did not read it or could not
   * @param [options.encryption] {CollectionEncryption}   the descriptor the
   *   caller knows the collection carries; present means there is nothing to
   *   declare
   * @returns {Promise<DeclarationResult>}
   */
  async markCollectionEncrypted(
    collectionId: string,
    {
      current,
      encryption
    }: { current?: CollectionMetaRead; encryption?: CollectionEncryption }
  ): Promise<DeclarationResult> {
    if (this.#configById.get(collectionId)?.visibility === 'public') {
      return { collectionId, ok: true, skipped: true }
    }
    if (encryption) {
      return { collectionId, ok: true, skipped: true }
    }
    return await this.#configure(collectionId, {
      current,
      change: () => ({ encryption: { scheme: 'edv' } })
    })
  }

  /**
   * Best-effort declaration of a public collection's equality-indexed
   * attributes (`{ plaintext: { indexes: [...] } }`) on its Metadata object,
   * invoked with that collection's delegated RW zcap. The `plaintext` member
   * is the counterpart of `encryption`. The server rejects
   * `filter[attr]=value` queries on undeclared attributes fail-closed, so a
   * public collection that wants `store.query()` must announce its `indexes`
   * here. Non-fatal like the encryption descriptor: returns the outcome rather
   * than throwing. Skipped (reported `ok` + `skipped`) for a private
   * collection or one that declares no indexes.
   *
   * A stored declaration that already matches the configured list is skipped
   * too, so a returning session writes nothing. The comparison is over the
   * server's normalized shape (a bare string entry is
   * `{ name, source: 'content', unique: false }`), so the server echoing an
   * expanded entry is not read as drift.
   *
   * The write is a merge into the object the caller already read
   * (`Collection.configure`, the same path {@link markCollectionEncrypted}
   * takes): the stored `plaintext` object is sent back with its `indexes`
   * replaced, and every other member -- `name`, `backend`, the `custom`
   * envelope, anything this client does not model -- is carried forward,
   * pinned to the read's validator. A lost race is re-read and rebased by
   * was-client's compare-and-swap; only a race lost repeatedly is reported
   * here, and the next session's pass repairs it. With no readable object
   * there is nothing to merge into, and writing the list alone would replace
   * the whole object with it: the write is refused and reported NOT ok (see
   * the shared merge tail below). The already-matches check runs after
   * that guard, against the object it confirms is there.
   *
   * @param collectionId {string}   the WAS collection id
   * @param options {object}
   * @param [options.current] {CollectionMetaRead}   the collection's Metadata
   *   object as the caller read it; absent when it could not be read
   * @returns {Promise<DeclarationResult>}
   */
  async declareCollectionIndexes(
    collectionId: string,
    { current }: { current?: CollectionMetaRead }
  ): Promise<DeclarationResult> {
    const config = this.#configById.get(collectionId)
    if (
      config?.visibility !== 'public' ||
      !config.indexes ||
      config.indexes.length === 0
    ) {
      return { collectionId, ok: true, skipped: true }
    }
    const { indexes } = config
    return await this.#configure(collectionId, {
      current,
      change: ({ description: { plaintext } }) =>
        plaintext?.indexes && sameIndexDeclaration(plaintext.indexes, indexes)
          ? undefined
          : { plaintext: { ...plaintext, indexes } }
    })
  }

  /**
   * Best-effort declaration of a PRIVATE collection's blinded-index attributes.
   * Unlike the public `indexes` declaration, the schema lives inside the
   * Metadata object's ENCRYPTED `custom` envelope (a compare-and-swap write
   * through `Collection.declareIndexes`, which reads the object, re-seals the
   * envelope, and writes the whole object back under its validator), so every
   * recipient discovers what is queryable without out-of-band coordination and
   * the server never sees the attribute names. Only the attributes not already
   * in the persisted schema are declared, all of them in that one write, so a
   * returning session issues no writes at all; `wrote` on the result says
   * whether one landed, since a write replaces the `custom` a caller may have
   * read before it. Non-fatal
   * like the other declarations: returns the outcome rather than throwing.
   * Skipped (reported `ok` + `skipped`) for a public collection or one that
   * declares no indexes.
   *
   * A collection whose descriptor carries no `hmac` member is reported NOT ok
   * (rather than skipped): the blinding key is installed with the collection's
   * first key epoch or never, so this is a provisioning gap the caller should
   * warn about -- the declarations cannot be made and queries on the collection
   * will keep failing.
   *
   * Declarations are prospective: a document written before its attribute was
   * declared carries no blinded entry for it and is not findable until it is
   * rewritten.
   *
   * @param collectionId {string}   the WAS collection id
   * @param options {object}
   * @param options.encryption {CollectionEncryption | undefined}   the
   *   already-read descriptor the caller fetched from the collection
   *   description; `undefined` means the collection carries none
   * @returns {Promise<DeclarationResult>}
   */
  async declareBlindedIndexes(
    collectionId: string,
    { encryption }: { encryption: CollectionEncryption | undefined }
  ): Promise<DeclarationResult> {
    const config = this.#configById.get(collectionId)
    if (
      config?.visibility !== 'private' ||
      !config.indexes ||
      config.indexes.length === 0
    ) {
      return { collectionId, ok: true, skipped: true }
    }
    if (!encryption?.hmac) {
      return {
        collectionId,
        ok: false,
        error:
          'the collection was provisioned without a blinded-index key (the ' +
          'key is installed with the first key epoch or never)'
      }
    }
    const capability = this.collectionCapability(collectionId)
    if (!capability) {
      return { collectionId, ok: false, error: 'no capability' }
    }
    if (!this.#hasIdentityKeys) {
      return { collectionId, ok: false, error: 'no identity keys' }
    }
    try {
      const collection = this.#collection(collectionId, capability)
      const persisted = await collection.indexes()
      const already = new Set(
        persisted.map(declaration =>
          Array.isArray(declaration.attribute)
            ? declaration.attribute.join(',')
            : declaration.attribute
        )
      )
      // Every missing attribute lands in ONE compare-and-swap write (one
      // read, one conditional write) rather than one per attribute.
      const missing = config.indexes
        .map(name => blindedAttribute(name))
        .filter(attribute => !already.has(attribute))
      if (missing.length > 0) {
        await collection.declareIndexes({
          indexes: missing.map(attribute => ({ attribute }))
        })
      }
      return { collectionId, ok: true, wrote: missing.length > 0 }
    } catch (err) {
      return declarationFailure(collectionId, err)
    }
  }

  /**
   * Runs one equality query against a registered collection, routing on its
   * visibility and answering the same `{ documents, hasMore, cursor? }` page
   * either way. Values are string equality only, and multiple `equals`
   * attributes AND together.
   *
   * - A PUBLIC (plaintext) collection uses the canonical GET
   *   `filter[attr]=value` form of the server's `equality` profile, invoked
   *   with the collection's delegated zcap (an anonymous reader would issue the
   *   same URL unsigned against a `PublicCanRead` collection). Filter
   *   attributes are emitted in sorted order so identical queries produce
   *   identical URLs (cache-friendly).
   * - A PRIVATE (encrypted) collection uses the `blinded-index` query profile:
   *   each attribute name and value is blinded client-side with the
   *   collection's blinding key before it leaves the browser, the server
   *   matches opaque tokens, and the returned envelopes are decrypted here.
   *   Attribute names are rooted at the EDV document's `content`, which for a
   *   JSON payload IS the stored payload verbatim, so the configured `author`
   *   is queried as `content.author`.
   *
   * Fails closed before any network round trip on a collection the registry
   * does not know, an empty term set, an attribute missing from the
   * collection's declared `indexes`, an uncovered collection, and -- on the
   * private path -- a store built without this app's identity keys.
   *
   * Standing limitation of the private path: the sync path emits blinded
   * entries only once the bootstrap has installed the collection's persisted
   * schema on its cipher, so a document written before that install carries no
   * entries and a blinded query does not find it. Such a document becomes
   * findable once it is rewritten.
   *
   * @param options {object}
   * @param options.collectionId {string}   the WAS collection id
   * @param options.equals {Record<string, string>}   equality terms; multiple
   *   attributes AND together
   * @param [options.limit] {number}   page size (server default when omitted)
   * @param [options.cursor] {string}   opaque continuation cursor from the
   *   prior page
   * @returns {Promise<EqualityQueryPage>}
   */
  async queryCollectionByEquality({
    collectionId,
    equals,
    limit,
    cursor
  }: {
    collectionId: string
    equals: Record<string, string>
    limit?: number
    cursor?: string
  }): Promise<EqualityQueryPage> {
    const config = this.#configById.get(collectionId)
    if (!config) {
      throw new Error(
        `Equality queries require a registered collection; "${collectionId}" ` +
          `is not in the collection registry.`
      )
    }
    const attributes = Object.keys(equals)
    if (attributes.length === 0) {
      throw new Error('An equality query needs at least one term.')
    }
    const declared = new Set(config.indexes ?? [])
    for (const name of attributes) {
      if (!declared.has(name)) {
        throw new Error(
          `Attribute "${name}" is not declared in collection ` +
            `"${collectionId}" indexes; declare it in the collection config.`
        )
      }
    }
    const capability = this.collectionCapability(collectionId)
    if (!capability) {
      throw new Error(
        `No delegated capability covers collection "${collectionId}".`
      )
    }
    if (config.visibility === 'private') {
      return await this.#queryBlinded({
        collectionId,
        capability,
        equals,
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor })
      })
    }
    // Canonical query string: sorted filter attributes first, then the
    // reserved pagination params. Literal brackets around a percent-encoded
    // attribute name; the server decodes either spelling identically.
    const params = attributes
      .sort()
      .map(
        name =>
          `filter[${encodeURIComponent(name)}]=` +
          encodeURIComponent(equals[name] as string)
      )
    if (limit !== undefined) {
      params.push(`limit=${encodeURIComponent(String(limit))}`)
    }
    if (cursor !== undefined) {
      params.push(`cursor=${encodeURIComponent(cursor)}`)
    }
    // The list endpoint is the collection container URL itself (canonical
    // trailing slash), the same URL was-client's own listing walks.
    const response = await this.was.request({
      capability,
      path: `${collectionPath(this.spaceId, collectionId)}?${params.join('&')}`,
      method: 'GET'
    })
    const page = response.data as Partial<EqualityQueryPage> | undefined
    if (!page || !Array.isArray(page.documents)) {
      throw new Error(
        `Malformed equality query response for "${collectionId}": expected a ` +
          `{ documents, hasMore } page.`
      )
    }
    return {
      documents: page.documents,
      hasMore: page.hasMore === true,
      ...(typeof page.cursor === 'string' && { cursor: page.cursor })
    }
  }

  /**
   * The world-readable share URL for one document in a public (plaintext)
   * collection: the exact URL an unauthenticated reader fetches (e.g. via
   * `WasClient.publicRead`) to consume a share link. Because a public
   * collection stores the payload under its own logical `id`, this URL is
   * stable across edits of the document. Fails closed before composing
   * anything on a non-public collection (the encrypted path stores under a
   * random envelope id, so no stable public URL exists), an empty id, or a
   * collection no delegated capability covers (catching typo'd or
   * unprovisioned collection ids). The URL resolves publicly only once the
   * document has replicated to the server -- a locally-inserted doc shares
   * after the next sync push.
   *
   * @param options {object}
   * @param options.collectionId {string}   the WAS collection id
   * @param options.id {string}   the document's logical uuid
   * @returns {string}
   */
  publicUrlFor({
    collectionId,
    id
  }: {
    collectionId: string
    id: string
  }): string {
    const config = this.#configById.get(collectionId)
    if (config?.visibility !== 'public') {
      throw new Error(
        `Public share URLs require a public (plaintext) collection; ` +
          `"${collectionId}" is not registered as public (a private ` +
          `collection stores documents under a random envelope id, so no ` +
          `stable public URL exists).`
      )
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('A public share URL needs a non-empty document id.')
    }
    const capability = this.collectionCapability(collectionId)
    if (!capability) {
      throw new Error(
        `No delegated capability covers collection "${collectionId}".`
      )
    }
    return toUrl({
      serverUrl: this.serverUrl,
      path: resourcePath(this.spaceId, collectionId, id)
    })
  }

  /**
   * The private-collection half of {@link queryCollectionByEquality}: the
   * `blinded-index` query profile through the collection handle, whose codec
   * blinds the terms before the request and decrypts the returned envelopes.
   * The caller has already run every guard.
   */
  async #queryBlinded({
    collectionId,
    capability,
    equals,
    limit,
    cursor
  }: {
    collectionId: string
    capability: IZcap
    equals: Record<string, string>
    limit?: number
    cursor?: string
  }): Promise<EqualityQueryPage> {
    if (!this.#hasIdentityKeys) {
      throw new Error(
        `Equality queries on the encrypted collection "${collectionId}" ` +
          `require a wallet-connected session with this app's identity keys ` +
          `(the terms are blinded, and the results decrypted, with the ` +
          `collection's own keys).`
      )
    }
    const page = await this.#collection(collectionId, capability).find({
      equals: Object.fromEntries(
        Object.entries(equals).map(([name, value]) => [
          blindedAttribute(name),
          value
        ])
      ),
      ...(limit !== undefined && { limit }),
      ...(cursor !== undefined && { cursor })
    })
    if (!('items' in page)) {
      throw new Error(
        `Malformed equality query response for "${collectionId}": expected a ` +
          `page of items.`
      )
    }
    return {
      // A blob resource decrypts to a `Blob`, which is not a payload the entity
      // layer can use; its id still reports the match, with `data` omitted.
      documents: page.items.map(({ id, data }) => ({
        id,
        ...(!(data instanceof Blob) && { data })
      })),
      hasMore: page.hasMore,
      ...(typeof page.cursor === 'string' && { cursor: page.cursor })
    }
  }
}

/**
 * The `EncryptionDescriptorSource` (`@interop/was-client/edv`) over a
 * delegated {@link WasRemoteStore}: one Collection Metadata read per
 * collection, invoked with THAT collection's delegated zcap. It is the seam the
 * descriptor-refresh machinery -- the local store's unknown-epoch policy and a
 * shared collection's self-refreshing cipher -- re-reads a rotated key-epoch
 * roster through.
 *
 * Deliberately NOT `wasDescriptorSource` from the same subpath: that one
 * describes through the client's root capability, which a requester never
 * holds. Every read here must invoke the per-collection grant, which is
 * exactly what {@link WasRemoteStore.readCollectionEncryption} does.
 *
 * A read that fails for a transient reason is warned about and answered as
 * `undefined` here: the refresh guard is already spent by the time the source
 * is consulted, so the decrypt retry fails the same way it would under no
 * refresh at all, and the caller sees the envelope's own unknown-epoch error
 * rather than a network one.
 *
 * @param options {object}
 * @param options.remoteStore {WasRemoteStore}
 * @returns {EncryptionDescriptorSource}
 */
export function remoteDescriptorSource({
  remoteStore
}: {
  remoteStore: WasRemoteStore
}): EncryptionDescriptorSource {
  return {
    async collectionEncryption({ collectionId }: { collectionId: string }) {
      try {
        return await remoteStore.readCollectionEncryption(collectionId)
      } catch (err) {
        log.warn('Descriptor refresh for a collection failed.', {
          collectionId,
          err
        })
        return undefined
      }
    }
  }
}
