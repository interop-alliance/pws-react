/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * LocalStore: the always-on local replica. A GENERIC per-entity envelope store
 * over an app's registered collections. Owns one RxDB (Dexie/IndexedDB)
 * database holding one collection per entity on the shared `syncedDocSchema()`;
 * every at-rest row is `{ id, updatedAt, data }`. On a PRIVATE
 * (default) collection `data` is the EDV envelope `{ id, sequence, jwe }` --
 * the server never sees plaintext. On a PUBLIC collection `data` is the
 * plaintext payload as-is, behind the same {@link DocCipher} seam (a
 * pass-through codec), so everything below this paragraph applies to both.
 *
 * Two id planes: the logical entity `uuid` lives INSIDE the encrypted payload;
 * the RxDB primary key is the opaque random EDV envelope id. An in-memory
 * `uuid -> envelopeId` index (built during hydration) routes updates/deletes.
 * (On a public collection the planes coincide -- the row id IS the payload
 * uuid, giving a public document a stable, shareable resource URL -- and the
 * index degenerates to identity.) Two timestamp planes: the row-level
 * `updatedAt` is only the sync checkpoint; the payload's own `createdAt` /
 * `updatedAt` (inside the ciphertext) drive domain sorting and LWW.
 *
 * Writes: create mints a fresh random envelope; update re-encrypts under the
 * SAME envelope id with `sequence`+1 (the mutable-head model); delete is an RxDB
 * soft-delete tombstone.
 */
import type {
  RxCollection,
  RxDatabase,
  RxDocument,
  RxStorage
} from 'rxdb/plugins/core'
import {
  DEFAULT_DB_NAME,
  isPublicCollection,
  validateCollections,
  validateSharedCollections,
  type SharedCollectionConfig,
  type WasCollectionConfig
} from '../config.js'
import type { CollectionEncryption } from '@interop/was-client'
import {
  DescriptorRefreshPolicy,
  type EncryptionDescriptorSource
} from '@interop/was-client/edv'
import {
  makeLwwConflictHandler,
  syncedDocSchema,
  type Json,
  type SyncedDoc
} from '@interop/was-sync'
import {
  createDocCipher,
  createPlaintextDocCodec,
  createUnprovisionedDocCipher,
  type DocCipher
} from './docCipher.js'
import { log } from '../log.js'
import { remotePayloadWins } from '@interop/social-core'
import { epochRostersEqual, hasKeyEpochs } from '@interop/was-client/edv'
import {
  acquireGovernedDescriptor,
  isDescriptorRefusal
} from './governedDescriptors.js'
import { isIntegrityError, isUnknownEpochError } from '@interop/was-client/sync'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'

// A logical entity payload: the minimum this store needs is a logical `id`
// (uuidv7) to index and route mutable-head updates by. The rest of the payload
// is opaque JSON to this generic layer.
type EntityPayload = { id: string }

/**
 * A stable, RxDB-safe database name per controller DID (FNV-1a hex), so two
 * wallet users on one browser never collide on the same local database.
 *
 * @param options {object}
 * @param options.dbName {string}   the app's base database name
 * @param options.controllerDid {string}   the session controller DID
 * @returns {string}
 */
export function dbNameForController({
  dbName,
  controllerDid
}: {
  dbName: string
  controllerDid: string
}): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < controllerDid.length; index++) {
    hash ^= controllerDid.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${dbName}-${hash.toString(16).padStart(8, '0')}`
}

/**
 * Whether a decrypt failure is the malformed body a PUBLIC collection
 * tolerates, logging the recovery when it is. A public collection takes writes
 * from anything holding a grant on it, so a row that is not a plaintext
 * document bound to its resource id (a body whose `id` does not match the
 * resource id it is stored under, one with no string `id`, or an EDV envelope
 * written into a plaintext collection) is a malformed document rather than a
 * broken seal, and neither hydration nor conflict resolution may fail over it
 * -- the server's body is unchanged on every retry, so a hard failure would
 * break that collection permanently. The plaintext codec raises every one of
 * those as `IntegrityError`, which is what this recognizes. On a private
 * collection the same error means an envelope sealed for another resource, and
 * is never tolerated.
 *
 * @param options {object}
 * @param options.isPublic {boolean}
 * @param options.err {unknown}
 * @param options.collectionKey {string}
 * @param options.resourceId {string}   the row's own id
 * @param options.recovery {string}   what the caller does instead, for the log
 * @returns {boolean}
 */
function toleratesMalformedPublicRow({
  isPublic,
  err,
  collectionKey,
  resourceId,
  recovery
}: {
  isPublic: boolean
  err: unknown
  collectionKey: string
  resourceId: string
  recovery: string
}): boolean {
  if (!isPublic || !isIntegrityError(err)) {
    return false
  }
  log.warn(
    'A public collection holds a row that is not a plaintext document bound ' +
      `to its resource id; ${recovery}.`,
    { resourceId, collectionKey, err }
  )
  return true
}

/**
 * Builds one collection's LWW conflict-side decrypt closure. was-sync calls it
 * once per side with that side's OWN `SyncedDoc.id` (the row's stored id), never
 * an id read out of the decrypted payload: the payload's own `id` is a
 * different, logical uuid on a private (random-id) collection, and trusting it
 * would check an envelope against itself and prove nothing.
 *
 * It decrypts through the store's epoch-REFRESHING path, so a master written
 * under an unseen key epoch triggers the one-shot descriptor re-read and cipher
 * rebuild instead of scoring the master as undecryptable, and it reads the
 * CURRENT cipher for this key at decrypt time (not a captured reference), so a
 * `rebuildCipher` after a descriptor change takes effect here too.
 *
 * @param options {object}
 * @param options.storeHolder {object}   filled in once `init` has constructed
 *   the store, before any replication can run
 * @param options.key {string}
 * @param options.isPublic {boolean}
 * @returns {function}
 */
function conflictSideDecrypt({
  storeHolder,
  key,
  isPublic
}: {
  storeHolder: { current: LocalStore | null }
  key: string
  isPublic: boolean
}): (options: { id: string; envelope: Json }) => Promise<Json> {
  return async ({ id, envelope }) => {
    try {
      return await storeHolder.current!.decryptEnvelope({ key, id, envelope })
    } catch (err) {
      // A tolerated malformed row is compared on whatever last-write-wins
      // stamp its body still carries (hydration skips it either way, see
      // `#decodeAll`). A private collection's mismatch propagates, and was-sync
      // keeps it separate from its undecryptable-side handling: it comes out of
      // `resolve`, RxDB scores the resolution itself as failed, and that
      // collection's replication cycle fails the way any other fatal
      // replication error does.
      if (
        !toleratesMalformedPublicRow({
          isPublic,
          err,
          collectionKey: key,
          resourceId: id,
          recovery: 'comparing the conflict side on its last-write-wins stamp'
        })
      ) {
        throw err
      }
      return envelope
    }
  }
}

/**
 * The storage a replica is created on, as the structural shape of RxDB's
 * `RxStorage` this library passes through to `createRxDatabase` /
 * `removeRxDatabase`. It is declared here rather than imported so the published
 * declarations name no `rxdb` type: `rxdb` is an optional peer, and a
 * replica-less consumer type-checks the root entry without it installed. Any
 * real `RxStorage` satisfies it (the default Dexie one, or a test's
 * fake-indexeddb-backed one), and the two call sites cast it back to
 * `RxStorage` unchecked: nothing validates the object before RxDB receives it.
 */
export interface ReplicaStorage {
  readonly name: string
  readonly rxdbVersion: string
  createStorageInstance(params: never): Promise<unknown>
}

/**
 * One change on a replica collection, as the two members of RxDB's change event
 * this library reads (and hands to `onRemoteChange` callbacks): the operation
 * and the row after it. Declared here for the same reason as
 * {@link ReplicaStorage}; every `RxChangeEvent<SyncedDoc>` satisfies it.
 */
export interface ReplicaChange {
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  documentData: SyncedDoc & { _deleted?: boolean }
}

/**
 * The default storage, Dexie over IndexedDB, loaded on first use. `rxdb` is an
 * optional peer: a replica-less app (one that only reads shared collections)
 * installs this package without it, and resolves the root entry because nothing
 * here imports `rxdb` at module evaluation. This loader and the two
 * `rxdb/plugins/core` imports in `init()` and `removeDatabase()` are the only
 * places this module reaches for it, all on an async path, so a missing peer
 * fails there with the resolver's own error and nowhere earlier. A caller
 * supplying its own `storage` never triggers this load.
 *
 * @returns {Promise<RxStorage<unknown, unknown>>}
 */
async function defaultStorage(): Promise<RxStorage<unknown, unknown>> {
  const { getRxStorageDexie } = await import('rxdb/plugins/storage-dexie')
  return getRxStorageDexie()
}

/**
 * The local store. Construct via {@link LocalStore.init}, which builds each
 * collection's cipher -- an EDV cipher on the app's identity KAK (private
 * collections) or the pass-through plaintext codec (public collections) -- and
 * opens RxDB.
 */
export class LocalStore {
  #db: RxDatabase
  #collections: Record<string, RxCollection<SyncedDoc>>
  #ciphers: Record<string, DocCipher>
  #configs: Record<string, WasCollectionConfig>
  // The reverse of `#configs`: WAS collection id -> logical key, so a lookup by
  // wire id (a fetched remote descriptor) costs no registry scan.
  #keyByCollectionId: Map<string, string>
  // Per-collection logical-uuid -> envelope (RxDB primary key) index.
  #index: Record<string, Map<string, string>>
  // The app's identity KAK and its resolver: the ONE key material every
  // private collection's cipher is built on, kept so a cipher can be rebuilt
  // when its epoch descriptor changes (a wallet-side rotation).
  #keyAgreementKey: IKeyAgreementKey
  #keyResolver: IKeyResolver
  // The encryption descriptor each private collection's current cipher was built
  // from (keyed by collection logical key), so a descriptor change can be detected.
  #descriptors: Record<string, CollectionEncryption | undefined>
  // The last collection metadata installed per collection LOGICAL key (the
  // stored `/meta` value carrying the blinded-index schema), kept so a cipher
  // rebuild re-installs the schema instead of silently dropping it.
  #metas: Record<string, { custom?: unknown }>
  // Reads a private collection's fresh encryption descriptor (the verified
  // head of its governing log); injected once a remote store exists. Absent
  // offline / local-only, in which case an unknown epoch simply propagates.
  #descriptorSource?: EncryptionDescriptorSource
  // The once-per-collection-per-session unknown-epoch guard, and the in-flight
  // refresh each collection's concurrent decrypts share (see `#spendRefresh`).
  readonly #refreshPolicy: DescriptorRefreshPolicy
  readonly #refreshing = new Map<string, Promise<void>>()
  // Per collection, the refusal its refresh met: a source that does not
  // verify the governing log, or a governing log the source refused to
  // adopt. Kept so the decrypt that spent the refresh, and every later one,
  // surfaces that refusal as itself rather than as the envelope's unknown
  // epoch (see `#decryptWithRefresh`).
  readonly #refusals = new Map<string, Error>()

  private constructor({
    db,
    collections,
    ciphers,
    configs,
    keyAgreementKey,
    keyResolver,
    descriptors
  }: {
    db: RxDatabase
    collections: Record<string, RxCollection<SyncedDoc>>
    ciphers: Record<string, DocCipher>
    configs: Record<string, WasCollectionConfig>
    keyAgreementKey: IKeyAgreementKey
    keyResolver: IKeyResolver
    descriptors: Record<string, CollectionEncryption | undefined>
  }) {
    this.#db = db
    this.#collections = collections
    this.#ciphers = ciphers
    this.#configs = configs
    this.#keyByCollectionId = new Map(
      Object.entries(configs).map(([key, config]) => [config.id, key])
    )
    this.#index = {}
    this.#keyAgreementKey = keyAgreementKey
    this.#keyResolver = keyResolver
    this.#descriptors = descriptors
    this.#metas = {}
    // The whole swap an unknown epoch calls for, handed to the policy that
    // rations it: re-read the collection's descriptor through the installed
    // source, under `requireGoverned` (a source that does not verify the
    // governing log is refused with `UnverifiedDescriptorError`, which
    // propagates as itself), and rebuild that collection's cipher from it.
    // With no source, or a collection the registry does not carry, or a read
    // that answers no descriptor, nothing is swapped and the retry fails as
    // the first attempt did.
    this.#refreshPolicy = new DescriptorRefreshPolicy({
      refresh: async ({ collectionId }: { collectionId: string }) => {
        const key = this.#keyByCollectionId.get(collectionId)
        const source = this.#descriptorSource
        if (key === undefined || !source) {
          return
        }
        let encryption: CollectionEncryption | undefined
        try {
          encryption = await acquireGovernedDescriptor({ source, collectionId })
        } catch (err) {
          // A refused source stays refused for the session (the source is
          // installed once), so the refresh is spent rather than un-armed:
          // the policy would otherwise re-ask on every decrypt. The refusal
          // is what the decrypt surfaces.
          if (isDescriptorRefusal(err)) {
            this.#refusals.set(collectionId, err)
            return
          }
          // Any other failure (a dropped connection, a 5xx) is rethrown into
          // the policy, which un-arms the guard without a word; the memo is
          // dropped with it so the next decrypt re-asks, and the failure is
          // logged here since nothing downstream will.
          log.warn(
            'Descriptor refresh for an unknown key epoch failed; the next ' +
              'decrypt that meets one retries it.',
            { collectionId, err }
          )
          this.#refreshing.delete(collectionId)
          throw err
        }
        if (hasKeyEpochs(encryption)) {
          await this.rebuildCipher({ key, encryption })
        }
      }
    })
  }

  /**
   * Opens (or creates) the store: builds one cipher per PRIVATE collection on
   * the app's identity KAK (a PUBLIC collection gets the pass-through plaintext
   * codec instead) and opens one RxDB collection per entity. The key material
   * is derived ONCE, by the caller, and shared by every private collection: an
   * epoch-roster recipient is always the X25519 twin of a controller did:key.
   *
   * When `descriptors` carries an epoch-bearing encryption descriptor for a
   * private collection (from the offline descriptor cache), that collection's
   * cipher is built before any live description read; a collection with no
   * cached roster opens FAIL-CLOSED behind a placeholder cipher until a live
   * descriptor read supplies one (epoch-from-birth: there is no single-key
   * cipher to fall back to).
   *
   * @param options {object}
   * @param options.keyAgreementKey {IKeyAgreementKey}   the app's identity KAK
   *   (`IdentityAgents.keyAgreementKey`)
   * @param options.keyResolver {IKeyResolver}   its one-key resolver
   *   (`IdentityAgents.keyResolver`)
   * @param options.collections {WasCollectionConfig[]}   the collection registry
   *   (logical key to WAS collection id)
   * @param [options.sharedCollections] {SharedCollectionConfig[]}   the shared
   *   (read-only, wallet-owned) registry. Nothing is opened for these -- they
   *   have no local replica -- but they are validated against the app-owned
   *   registry here, before any replica exists
   * @param [options.descriptors] {Record<string, CollectionEncryption>}   cached
   *   encryption descriptors keyed by WAS collection id (from the offline cache)
   * @param [options.storage] {ReplicaStorage}   defaults to Dexie/IndexedDB;
   *   injectable for tests
   * @param [options.dbName] {string}   defaults to {@link DEFAULT_DB_NAME}
   * @returns {Promise<LocalStore>}
   */
  static async init({
    keyAgreementKey,
    keyResolver,
    collections,
    sharedCollections,
    descriptors = {},
    storage,
    dbName = DEFAULT_DB_NAME
  }: {
    keyAgreementKey: IKeyAgreementKey
    keyResolver: IKeyResolver
    collections: WasCollectionConfig[]
    sharedCollections?: SharedCollectionConfig[]
    descriptors?: Record<string, CollectionEncryption>
    storage?: ReplicaStorage
    dbName?: string
  }): Promise<LocalStore> {
    validateCollections(collections)
    validateSharedCollections({
      collections,
      ...(sharedCollections && { sharedCollections })
    })
    const ciphers: Record<string, DocCipher> = {}
    // The descriptor each private cipher was built from, keyed by logical key.
    const builtDescriptors: Record<string, CollectionEncryption | undefined> =
      {}
    // Build every collection's cipher concurrently: each private one runs real
    // asymmetric crypto (an ECDH unwrap of the epoch secret) on the boot
    // critical path, and no collection's cipher depends on another's.
    await Promise.all(
      collections.map(async collection => {
        const { key, id } = collection
        // A public collection is stored plaintext: no key derivation, no EDV
        // cipher -- just the pass-through codec behind the same seam.
        if (isPublicCollection(collection)) {
          ciphers[key] = createPlaintextDocCodec({ collectionId: id })
          return
        }
        // Epoch-from-birth: an EDV cipher exists only from an epoch-bearing
        // descriptor. Without one cached (an offline boot before any sync)
        // the collection opens fail-closed behind the placeholder cipher; the
        // first live descriptor read swaps in the real one via the
        // unknown-epoch recovery or the sync bootstrap.
        const encryption = descriptors[id]
        if (hasKeyEpochs(encryption)) {
          ciphers[key] = await createDocCipher({
            keyAgreementKey,
            keyResolver,
            collectionId: id,
            encryption
          })
          builtDescriptors[key] = encryption
        } else {
          ciphers[key] = createUnprovisionedDocCipher({ collectionId: id })
        }
      })
    )

    // Loaded here rather than at module evaluation; see `defaultStorage`.
    const { createRxDatabase } = await import('rxdb/plugins/core')
    const db = await createRxDatabase({
      name: dbName,
      storage:
        (storage as RxStorage<unknown, unknown> | undefined) ??
        (await defaultStorage()),
      closeDuplicates: true,
      // Single-tab: RxDB gates replication on leadership under multiInstance;
      // multi-tab is deferred, so replicate directly in this tab.
      multiInstance: false
    })
    // Each collection gets an LWW conflict handler bound to its own cipher, so
    // a 412 push conflict (concurrent multi-device edit of the same mutable
    // head) is settled by decrypting both sides and comparing payload
    // `updatedAt` (writerId tiebreak) rather than RxDB's default master-wins.
    // On a public collection the codec is pass-through, so the handler reads
    // those fields directly off the plaintext payload. The decrypt side of it
    // is {@link conflictSideDecrypt}, wired here once the instance exists
    // (`storeHolder` is assigned below, before any replication can run).
    const storeHolder: { current: LocalStore | null } = { current: null }
    const collectionsConfig = Object.fromEntries(
      collections.map(collection => {
        const { key } = collection
        if (!ciphers[key]) {
          throw new Error(`No cipher for collection "${key}".`)
        }
        return [
          key,
          {
            schema: syncedDocSchema(),
            conflictHandler: makeLwwConflictHandler(
              conflictSideDecrypt({
                storeHolder,
                key,
                isPublic: isPublicCollection(collection)
              }),
              remotePayloadWins
            )
          }
        ]
      })
    )
    const collectionsMap = (await db.addCollections(
      collectionsConfig
    )) as unknown as Record<string, RxCollection<SyncedDoc>>

    const store = new LocalStore({
      db,
      collections: collectionsMap,
      ciphers,
      configs: Object.fromEntries(collections.map(entry => [entry.key, entry])),
      keyAgreementKey,
      keyResolver,
      descriptors: builtDescriptors
    })
    storeHolder.current = store
    return store
  }

  #collection(key: string): RxCollection<SyncedDoc> {
    const collection = this.#collections[key]
    if (!collection) {
      throw new Error(`Unknown collection "${key}".`)
    }
    return collection
  }

  /**
   * The registered {@link WasCollectionConfig} for one collection key (the
   * WAS collection id, visibility, and declared indexes the storage layer
   * routes on).
   *
   * @param key {string}   the collection logical key
   * @returns {WasCollectionConfig}
   */
  collectionConfig(key: string): WasCollectionConfig {
    const config = this.#configs[key]
    if (!config) {
      throw new Error(`Unknown collection "${key}".`)
    }
    return config
  }

  #cipher(key: string): DocCipher {
    const cipher = this.#ciphers[key]
    if (!cipher) {
      throw new Error(`No cipher for collection "${key}".`)
    }
    return cipher
  }

  /**
   * Installs the encryption-descriptor source: one verified governing-log read
   * per collection id (the remote store's log-governed source). Called once a
   * remote store exists; a decrypt that meets an unknown key epoch uses it to
   * re-read the descriptor, under `requireGoverned`, and rebuild that
   * collection's cipher, at most once per collection per session.
   *
   * @param source {EncryptionDescriptorSource}
   * @returns {void}
   */
  setDescriptorSource(source: EncryptionDescriptorSource): void {
    this.#descriptorSource = source
    this.#refusals.clear()
  }

  /**
   * Decrypts an at-rest envelope through the collection's cipher, recovering
   * from a stale epoch descriptor: when the cipher reports an unknown epoch (an
   * envelope written under an epoch this device has not seen -- a rekey on
   * another device / a wallet revoke-rotation), spend the collection's one
   * descriptor refresh and retry the decrypt once. A second failure propagates
   * rather than looping, and so does an unknown epoch met after the refresh is
   * spent.
   *
   * @param options {object}
   * @param options.key {string}
   * @param options.id {string}   the resource id the envelope is stored under
   *   (the row's own id), passed to the cipher so its binding check runs. Not
   *   an id read out of the decrypted payload: the server controls that field,
   *   and the binding check exists to catch a mismatch against it.
   * @param options.envelope {Json}
   * @returns {Promise<Json>}
   */
  async #decryptWithRefresh({
    key,
    id,
    envelope
  }: {
    key: string
    id: string
    envelope: Json
  }): Promise<Json> {
    try {
      return await this.#cipher(key).decrypt({ id, envelope })
    } catch (err) {
      if (!isUnknownEpochError(err) || !this.#descriptorSource) {
        throw err
      }
      const { id: collectionId } = this.collectionConfig(key)
      await this.#spendRefresh(collectionId)
      const refusal = this.#refusals.get(collectionId)
      if (refusal) {
        throw refusal
      }
      // One retry, under the (possibly) swapped cipher. When the refresh was
      // already spent this is a purely local re-attempt that fails the same
      // way, so a genuinely foreign envelope still surfaces its unknown epoch
      // and never buys a second description read.
      return await this.#cipher(key).decrypt({ id, envelope })
    }
  }

  /**
   * Spends one collection's single unknown-epoch descriptor refresh for this
   * session, resolving once it has been spent -- by this caller or by a
   * concurrent one.
   *
   * `DescriptorRefreshPolicy` owns the once-per-collection-per-session guard
   * (and the `reset` contract {@link applyRemoteDescriptor} honors); the promise
   * memo on top of it is what makes CONCURRENT decrypts share the single
   * re-read. {@link listEntities} decrypts a whole collection with
   * `Promise.all`, so without it the first row to report an unknown epoch would
   * win the guard and every other row would fail against the still-stale
   * cipher, failing the hydrate outright. (Upstream's
   * `createRefreshingEdvDocCipher` memoizes its own refresh the same way; the
   * policy exposes no equivalent, because its `readWithRefresh` retries the
   * whole read rather than one envelope.)
   */
  #spendRefresh(collectionId: string): Promise<void> {
    let pending = this.#refreshing.get(collectionId)
    if (!pending) {
      pending = this.#refreshPolicy.readWithRefresh<void>({
        collectionId,
        // A read that only ever reports an unknown epoch: the value is not
        // what is wanted here, the refresh is. The decrypt and its one retry
        // stay at the call site, where the envelope is.
        read: async () => ({ value: undefined, unknownEpoch: true })
      })
      this.#refreshing.set(collectionId, pending)
    }
    return pending
  }

  /**
   * Rebuilds one private collection's cipher from a new (epoch-bearing)
   * encryption descriptor, on the same identity KAK the store was opened with. A public (plaintext)
   * collection has no EDV cipher and is a no-op. The new cipher replaces the
   * held one in place, so the conflict handler and every read path pick it up.
   *
   * The collection metadata last installed by {@link applyCollectionMeta} is
   * re-applied at build time, so the blinded-index schema survives an
   * epoch-rotation rebuild and the unknown-epoch refresh (both funnel through
   * here). The schema refresh deliberately does NOT ride the descriptor-equality
   * gate in {@link applyRemoteDescriptor}: a schema-only change rotates no
   * epochs, so it is installed on the live cipher rather than waiting for a
   * descriptor to differ.
   *
   * @param options {object}
   * @param options.key {string}   the collection logical key
   * @param options.encryption {CollectionEncryption}   the new descriptor
   * @returns {Promise<void>}
   */
  async rebuildCipher({
    key,
    encryption
  }: {
    key: string
    encryption: CollectionEncryption
  }): Promise<void> {
    const config = this.collectionConfig(key)
    if (isPublicCollection(config)) {
      return
    }
    this.#ciphers[key] = await createDocCipher({
      keyAgreementKey: this.#keyAgreementKey,
      keyResolver: this.#keyResolver,
      collectionId: config.id,
      encryption,
      ...(this.#metas[key] !== undefined && { meta: this.#metas[key] })
    })
    this.#descriptors[key] = encryption
  }

  /**
   * Installs one collection's stored metadata (by WAS collection id) on its
   * cipher: the persisted blinded-index schema lives inside that metadata, and
   * installing it is what makes subsequent LOCAL writes emit blinded `indexed`
   * entries, so the envelopes this replica pushes are findable by an equality
   * query. It is the sync-path analogue of the direct path re-reading the
   * schema whenever a handle's codec is re-resolved.
   *
   * The metadata is also remembered, so a later {@link rebuildCipher} (an epoch
   * rotation, or the first real cipher swapped in behind the fail-closed
   * placeholder) re-installs the schema rather than dropping it. Unknown ids and
   * public collections are ignored. A metadata value the cipher cannot decode
   * throws: an undecodable envelope is the caller's warn-and-continue.
   *
   * @param options {object}
   * @param options.collectionId {string}   the WAS collection id
   * @param [options.custom] {unknown}   the stored `custom` value from the
   *   collection's `/meta` (an opaque envelope on an encrypted collection)
   * @returns {Promise<boolean>}   whether the metadata was remembered/applied
   */
  async applyCollectionMeta({
    collectionId,
    custom
  }: {
    collectionId: string
    custom?: unknown
  }): Promise<boolean> {
    const key = this.#keyByCollectionId.get(collectionId)
    if (key === undefined) {
      return false
    }
    if (isPublicCollection(this.collectionConfig(key))) {
      return false
    }
    // Remembered even when the collection currently holds the placeholder
    // cipher: the schema then rides the rebuild that swaps in the real one.
    this.#metas[key] = { custom }
    try {
      await this.#cipher(key).applyMeta?.({ custom })
    } catch (err) {
      // An undecodable value must not stay remembered: `createEdvDocCipher`
      // applies build-time meta eagerly, so a poisoned memo would make the next
      // rebuild (the unknown-epoch refresh) throw on a collection that reads
      // fine today.
      delete this.#metas[key]
      throw err
    }
    return true
  }

  /**
   * Applies a freshly fetched remote encryption descriptor (by WAS collection id):
   * rebuilds that collection's cipher when the descriptor's current epoch differs
   * from the one the current cipher was built from (a wallet-side rotation, or
   * first-ever epochs), so subsequent writes stamp the current epoch. Returns
   * whether a rebuild happened. Unknown / public collections are ignored, and
   * so is a descriptor with no key-epoch roster (a bare `edv` declaration): no
   * cipher can be built from it, so the collection keeps its current cipher --
   * the fail-closed placeholder, when it opened without a cached roster.
   *
   * Installing a fresh descriptor here also RE-ARMS the collection's
   * unknown-epoch refresh (the policy's documented `reset` contract): this path
   * is the sync bootstrap's own install, so the next unknown epoch after it is
   * evidence of a NEW rotation elsewhere and deserves its own re-read.
   *
   * @param options {object}
   * @param options.collectionId {string}   the WAS collection id
   * @param options.encryption {CollectionEncryption}   the fetched descriptor
   * @returns {Promise<boolean>}
   */
  async applyRemoteDescriptor({
    collectionId,
    encryption
  }: {
    collectionId: string
    encryption: CollectionEncryption
  }): Promise<boolean> {
    const key = this.#keyByCollectionId.get(collectionId)
    if (key === undefined) {
      return false
    }
    const config = this.collectionConfig(key)
    if (isPublicCollection(config) || !hasKeyEpochs(encryption)) {
      return false
    }
    if (epochRostersEqual(this.#descriptors[key], encryption)) {
      return false
    }
    await this.rebuildCipher({ key, encryption })
    this.#refreshPolicy.reset({ collectionId })
    this.#refreshing.delete(collectionId)
    this.#refusals.delete(collectionId)
    return true
  }

  /**
   * The `uuid -> envelopeId` index for one collection, built on first use.
   * Building it IS hydration -- {@link listEntities} decrypts every live row and
   * stores the index as a side effect -- so this delegates rather than running a
   * second decrypt-and-index loop of its own.
   */
  async #ensureIndex(key: string): Promise<Map<string, string>> {
    const existing = this.#index[key]
    if (existing) {
      return existing
    }
    await this.listEntities(key)
    return this.#index[key]!
  }

  /**
   * Encrypts `payload` into a fresh EDV envelope and inserts it as a new row.
   *
   * @param key {string}            the collection logical key
   * @param payload {EntityPayload} the plaintext entity (carries its own uuid)
   * @returns {Promise<void>}
   */
  async insertEntity<T extends EntityPayload>(
    key: string,
    payload: T
  ): Promise<void> {
    const cipher = this.#cipher(key)
    const {
      id: envelopeId,
      envelope,
      epoch
    } = await cipher.encrypt({
      data: payload as Json
    })
    await this.#collection(key).insert({
      id: envelopeId,
      updatedAt: new Date().toISOString(),
      data: envelope,
      // The epoch the envelope was sealed under rides the content push as the
      // `Key-Epoch` header (absent on the plaintext codec).
      ...(epoch !== undefined && { epoch })
    })
    const index = await this.#ensureIndex(key)
    index.set(payload.id, envelopeId)
  }

  /**
   * Re-encrypts `payload` in place under its existing envelope id, advancing the
   * envelope `sequence` (the mutable-head update). The row keeps its primary key;
   * only `data` and the checkpoint `updatedAt` change.
   *
   * @param key {string}
   * @param payload {EntityPayload}
   * @returns {Promise<void>}
   */
  async updateEntity<T extends EntityPayload>(
    key: string,
    payload: T
  ): Promise<void> {
    const index = await this.#ensureIndex(key)
    const envelopeId = index.get(payload.id)
    const doc = envelopeId
      ? await this.#collection(key).findOne(envelopeId).exec()
      : null
    const current = doc ? doc.toMutableJSON().data : undefined
    // The entity's envelope may be gone -- unknown to the index (another device
    // deleted it and the tombstone was pulled, which forgets the index entry),
    // its row otherwise removed, or the row left without ciphertext. Rather than
    // throwing (which loses the edit), forget any stale index entry (deleting a
    // missing key is a no-op) and resurrect the entity as a fresh create. This
    // matches the mutable-head LWW rule the conflict handler already applies: a
    // live local edit beats a remote tombstone, so re-asserting the payload
    // under a new envelope is correct.
    if (!envelopeId || !doc || current === undefined) {
      index.delete(payload.id)
      await this.insertEntity(key, payload)
      return
    }
    const cipher = this.#cipher(key)
    const { envelope, epoch } = await cipher.encryptUpdate({
      id: envelopeId,
      data: payload as Json,
      current
    })
    // `incrementalModify` (not `incrementalPatch`): a re-encrypt that yields
    // no `epoch` (the plaintext cipher) must CLEAR a stale stamp, and a patch
    // cannot remove a field.
    await doc.incrementalModify(docData => {
      docData.data = envelope
      docData.updatedAt = new Date().toISOString()
      if (epoch !== undefined) {
        docData.epoch = epoch
      } else {
        delete docData.epoch
      }
      return docData
    })
  }

  /**
   * Inserts the entity if the collection has no row for its uuid yet, otherwise
   * re-encrypts it in place. The hydration index is the source of truth for
   * existence, so callers (e.g. an app's singleton collection) need not track
   * an insert-vs-update flag of their own.
   *
   * @param key {string}
   * @param payload {EntityPayload}
   * @returns {Promise<void>}
   */
  async upsertEntity<T extends EntityPayload>(
    key: string,
    payload: T
  ): Promise<void> {
    const index = await this.#ensureIndex(key)
    if (index.has(payload.id)) {
      await this.updateEntity(key, payload)
    } else {
      await this.insertEntity(key, payload)
    }
  }

  /**
   * Tombstones the entity's row (RxDB soft delete) so the deletion replicates.
   *
   * @param key {string}
   * @param uuid {string}   the logical entity uuid
   * @returns {Promise<void>}
   */
  async deleteEntity(key: string, uuid: string): Promise<void> {
    const index = await this.#ensureIndex(key)
    const envelopeId = index.get(uuid)
    if (!envelopeId) {
      return
    }
    const doc = await this.#collection(key).findOne(envelopeId).exec()
    if (doc) {
      await doc.remove()
    }
    index.delete(uuid)
  }

  /**
   * The number of live (non-tombstoned) rows in a collection, without
   * decrypting any of them (e.g. the "is there anything to adopt?" check
   * behind a pre-login adoption prompt).
   *
   * @param key {string}
   * @returns {Promise<number>}
   */
  async countEntities(key: string): Promise<number> {
    return await this.#collection(key).count().exec()
  }

  /**
   * Decrypts every live row of a collection into its plaintext payload, and
   * (re)builds the `uuid -> envelopeId` index as a side effect of hydration.
   *
   * @param key {string}
   * @returns {Promise<T[]>}
   */
  async listEntities<T extends EntityPayload>(key: string): Promise<T[]> {
    const index = new Map<string, string>()
    const decoded = await this.#decodeAll<T>(key)
    const payloads: T[] = []
    for (const entry of decoded) {
      index.set(entry.payload.id, entry.envelopeId)
      payloads.push(entry.payload)
    }
    this.#index[key] = index
    return payloads
  }

  /**
   * Decrypts every live row of a collection, dropping rows that carry no
   * ciphertext, and (with a warning) a public collection's rows that are not
   * plaintext documents bound to their resource id. Each result keeps its RxDocument alongside the plaintext, so a
   * caller that goes on to remove a row (e.g. the singleton reconciler) needs no
   * second lookup.
   *
   * @param key {string}
   * @returns {Promise<Array<{envelopeId: string, payload: T, row: RxDocument<SyncedDoc>}>>}
   */
  async #decodeAll<T extends EntityPayload>(
    key: string
  ): Promise<
    Array<{ envelopeId: string; payload: T; row: RxDocument<SyncedDoc> }>
  > {
    const rows = await this.#collection(key).find().exec()
    const isPublicRow = isPublicCollection(this.collectionConfig(key))
    // Decrypt every row concurrently (the unlock hot path): the store is keyed
    // by logical uuid, so payload order does not matter and serializing the
    // per-row WebCrypto work would only add latency.
    const decoded = await Promise.all(
      rows.map(async row => {
        const { id: envelopeId, data } = row.toMutableJSON()
        if (data === undefined) {
          return null
        }
        try {
          const payload = (await this.#decryptWithRefresh({
            key,
            id: envelopeId,
            envelope: data
          })) as T
          return { envelopeId, payload, row }
        } catch (err) {
          // One malformed row must not fail hydration of the rest.
          if (
            !toleratesMalformedPublicRow({
              isPublic: isPublicRow,
              err,
              collectionKey: key,
              resourceId: envelopeId,
              recovery: 'skipping the row and hydrating the rest'
            })
          ) {
            throw err
          }
          return null
        }
      })
    )
    return decoded.filter(entry => entry !== null)
  }

  /**
   * Hydrates a singleton collection (at most one logical entity, e.g. an app's
   * current-selection doc) and reconciles any duplicates. Two devices that each
   * created the singleton before syncing produce distinct envelope rows that all
   * decrypt to the same logical id; because LWW conflict resolution is
   * per-envelope-id, those duplicates never reconcile on their own. This keeps
   * the last-writer-wins winner (payload `updatedAt`, `writerId` tiebreak) and
   * tombstones the losers so the deletion replicates and the space converges on
   * one row. Returns the winning payload, or `null` when the collection is empty.
   *
   * @param key {string}
   * @returns {Promise<T | null>}
   */
  async hydrateSingleton<
    T extends { id: string; updatedAt: string; writerId: string }
  >(key: string): Promise<T | null> {
    // The winner is picked from the whole decoded set afterwards, so payload
    // order does not matter.
    const decoded = await this.#decodeAll<T>(key)
    const index = new Map<string, string>()
    this.#index[key] = index
    if (decoded.length === 0) {
      return null
    }
    let winner = decoded[0]!
    for (const entry of decoded) {
      if (entry === winner) {
        continue
      }
      if (remotePayloadWins(entry.payload, winner.payload)) {
        winner = entry
      }
    }
    // The losers are tombstoned through the RxDocuments already in hand,
    // concurrently: no re-lookup, and the removals are independent.
    await Promise.all(
      decoded
        .filter(entry => entry.envelopeId !== winner.envelopeId)
        .map(async entry => await entry.row.remove())
    )
    index.set(winner.payload.id, winner.envelopeId)
    return winner.payload
  }

  /**
   * Decrypts a single EDV envelope into its plaintext payload: the sync
   * layer's per-doc reactive patch (a pulled remote change, without a
   * whole-collection re-hydrate) and the LWW conflict handler's decrypt
   * closure both call this.
   *
   * @param options {object}
   * @param options.key {string}
   * @param options.id {string}   the row's own id -- the RxDB primary key / WAS
   *   resource id a patch is addressed by, or the `SyncedDoc.id` a conflict side
   *   carries. See {@link LocalStore.#decryptWithRefresh}.
   * @param options.envelope {Json}   the `data` field of the at-rest row
   * @returns {Promise<T>}
   */
  async decryptEnvelope<T extends EntityPayload>({
    key,
    id,
    envelope
  }: {
    key: string
    id: string
    envelope: Json
  }): Promise<T> {
    return (await this.#decryptWithRefresh({ key, id, envelope })) as T
  }

  /**
   * Records a `uuid -> envelopeId` mapping for a remotely-pulled row so a
   * subsequent LOCAL edit of that entity can find its envelope. A no-op until
   * the collection has been hydrated once (hydration builds the full index).
   *
   * @param key {string}
   * @param uuid {string}
   * @param envelopeId {string}
   * @returns {void}
   */
  rememberEnvelope(key: string, uuid: string, envelopeId: string): void {
    this.#index[key]?.set(uuid, envelopeId)
  }

  /**
   * Forgets a `uuid -> envelopeId` mapping (a remotely-pulled tombstone).
   *
   * @param key {string}
   * @param uuid {string}
   * @returns {void}
   */
  forgetEnvelope(key: string, uuid: string): void {
    this.#index[key]?.delete(uuid)
  }

  /**
   * The envelope id the hydration index currently maps a logical uuid to, or
   * `undefined` when unknown (not yet hydrated, or no such entity). Lets the
   * sync patch path tell a tombstone for the LIVE envelope apart from one for a
   * stale duplicate (a reconciled singleton loser or a pre-resurrection row).
   *
   * @param key {string}
   * @param uuid {string}
   * @returns {string | undefined}
   */
  envelopeIdFor(key: string, uuid: string): string | undefined {
    return this.#index[key]?.get(uuid)
  }

  /**
   * The live RxDB collection handle, for the sync controller and the tests.
   * Stripped from the published declarations (`@internal`), since its type is
   * RxDB's and the root entry's declarations must name no `rxdb` type.
   *
   * @internal
   * @param key {string}
   * @returns {RxCollection<SyncedDoc>}
   */
  rxCollection(key: string): RxCollection<SyncedDoc> {
    return this.#collection(key)
  }

  /**
   * Closes the database (without removing data).
   *
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    await this.#db.close()
  }

  /**
   * Removes the database and all its data (the clear-data / logout-wipe path).
   * Unlike {@link close}, this deletes the underlying Dexie/IndexedDB store.
   *
   * @returns {Promise<void>}
   */
  async remove(): Promise<void> {
    await this.#db.remove()
  }

  /**
   * Deletes a database and all its data by name, without opening it (the
   * post-adoption cleanup of a replica that is already closed).
   *
   * @param options {object}
   * @param options.dbName {string}   the full per-controller database name
   * @param [options.storage] {ReplicaStorage}   defaults to Dexie/IndexedDB;
   *   must match the storage the database was created with
   * @returns {Promise<void>}
   */
  static async removeDatabase({
    dbName,
    storage
  }: {
    dbName: string
    storage?: ReplicaStorage
  }): Promise<void> {
    const { removeRxDatabase } = await import('rxdb/plugins/core')
    await removeRxDatabase(
      dbName,
      (storage as RxStorage<unknown, unknown> | undefined) ??
        (await defaultStorage())
    )
  }
}
