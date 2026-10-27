/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Shared WAS replication bootstrap: given a parsed grant set and the invoking
 * ZcapClient, builds the delegated {@link WasRemoteStore}, acquires each
 * granted private collection's descriptor through the store's governed source,
 * best-effort declares each collection's equality indexes -- as the Metadata
 * object's plaintext `plaintext.indexes` member for a public one, inside its
 * encrypted `custom` envelope (as blinded-index attributes) for a private one
 * -- and starts the supplied {@link SyncController} with reactive store patching. The
 * caller injects the opened localStore, the controller, and the per-doc
 * `onRemoteChange` patcher (typically wired to the rehydrate mechanism over the
 * app's store registry) rather than this module reaching for app-side globals.
 *
 * SHARED collections are handled apart from all of that. They belong to the
 * wallet, so they never enter replication, never get a local replica, and are
 * excluded from the best-effort declaration writes (a read-only grant would
 * draw nothing but a pointless 403). Instead one {@link SharedCollectionReader} is
 * opened per configured shared collection the grant set actually covers; a
 * shared collection with no covering grant, or one this app turns out not to be
 * a recipient of, is skipped with a warning rather than failing the session.
 */
import type { ZcapClient } from '@interop/ezcap'
import type { CollectionEncryption } from '@interop/was-client'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import { hasKeyEpochs } from '@interop/was-client/edv'
import {
  isPublicCollection,
  type SharedCollectionConfig,
  type WasCollectionConfig
} from '../config.js'
import type { ParsedGrants } from '../grants.js'
import { WasRemoteStore, type CollectionMetaRead } from './wasRemoteStore.js'
import type { SpaceTrust } from './spaceTrust.js'
import { SharedCollectionReader } from './sharedCollectionReader.js'
import { acquireGovernedDescriptor } from './governedDescriptors.js'
import type { LocalStore, ReplicaChange } from './localStore.js'
import type { SyncController } from './syncController.js'
import { log } from '../log.js'

/**
 * What the sync bootstrap hands back: the delegated remote store, plus a
 * read-only {@link SharedCollectionReader} per configured shared collection the
 * grant set covers and this app is a recipient of, keyed by the config `key`.
 */
export interface WasSyncBootstrap {
  remoteStore: WasRemoteStore
  sharedCollections: Record<string, SharedCollectionReader>
}

/**
 * The one read-filter-cache pass over a grant set, shared by the login-time
 * {@link readRemoteDescriptors} and the sync bootstrap: per REGISTERED
 * collection the grants actually cover, read its Metadata object ONCE (unless
 * the caller already read the private one's descriptor, or a public one
 * declares no indexes and so wants nothing from its object) and keep only the
 * epoch-bearing encryption descriptors -- a rosterless descriptor cannot build
 * a cipher. A granted id the app never registered is nobody's business here,
 * and a public collection carries no descriptor.
 *
 * `onCollection` is the bootstrap's hook: it runs per granted collection --
 * public ones included -- with the RAW object as read and the descriptor
 * (epoch-bearing or not) known for it, so the public indexes declaration, the
 * blinded-index install, and the cipher rebuild ride that one read. The
 * blinded-index declaration and its schema install read the object again on
 * their own. Collections are processed concurrently, hook included, so one
 * slow collection never holds up the others.
 *
 * A read that FAILS (rather than answering "no object") is never taken for an
 * absent descriptor. The collection is skipped entirely, hook included, and
 * reported on `failures`, so neither a placeholder cipher nor a declaration
 * write is built on a guess about a collection whose roster could not be
 * read. A hook that rejects is reported on `failures` the same way, and its
 * descriptor leaves the returned set. Every collection settles: an outage
 * affecting several reports each of them, and the caller decides what a
 * non-empty `failures` means (the login-time read rejects on it, the
 * bootstrap warns and skips).
 *
 * @param options {object}
 * @param options.remoteStore {WasRemoteStore}
 * @param options.collections {WasCollectionConfig[]}
 * @param options.parsed {ParsedGrants}
 * @param [options.knownDescriptors] {Record<string, CollectionEncryption>}
 *   descriptors already read live in this bring-up, reused instead of re-read
 * @param [options.onCollection] {(options) => Promise<void>}   per granted
 *   collection, with the object this pass read (absent when the read was
 *   skipped for a known descriptor) and the descriptor known for it (absent
 *   for a public one, or one carrying none)
 * @returns {Promise<DescriptorReadOutcome>}   the epoch-bearing descriptors,
 *   keyed by WAS collection id, and the collections whose read or hook failed
 */
async function readGrantedEncryption({
  remoteStore,
  collections,
  parsed,
  knownDescriptors = {},
  onCollection
}: {
  remoteStore: WasRemoteStore
  collections: WasCollectionConfig[]
  parsed: ParsedGrants
  knownDescriptors?: Record<string, CollectionEncryption>
  onCollection?: (options: {
    collection: WasCollectionConfig
    encryption?: CollectionEncryption
    current?: CollectionMetaRead
  }) => Promise<void>
}): Promise<DescriptorReadOutcome> {
  const granted = collections.filter(
    collection => parsed.byCollectionId[collection.id] !== undefined
  )
  const descriptors: Record<string, CollectionEncryption> = {}
  const failures: DescriptorReadOutcome['failures'] = []
  await Promise.all(
    granted.map(async collection => {
      const { id: collectionId } = collection
      const isPublic = isPublicCollection(collection)
      // A private collection's descriptor is the verified head of its
      // governing log, acquired through the store's log-governed source under
      // `requireGoverned`. The `encryption` projection the Metadata object
      // serves is not read for it. A descriptor the caller acquired seconds
      // ago is reused as-is. The object itself is read only for the hook: a public
      // collection declaring indexes wants the `plaintext` declaration
      // baseline off it, a private one whose descriptor was not already known
      // the `custom` envelope its blinded-index install reuses (otherwise the
      // install reads it again on its own). A public collection has no
      // descriptor.
      const known = isPublic ? undefined : knownDescriptors[collectionId]
      let encryption: CollectionEncryption | undefined
      let current: CollectionMetaRead | undefined
      const wanted =
        onCollection !== undefined &&
        (isPublic ? (collection.indexes?.length ?? 0) > 0 : known === undefined)
      try {
        ;[encryption, current] = await Promise.all([
          !isPublic && known === undefined
            ? acquireGovernedDescriptor({
                source: remoteStore.descriptorSource,
                collectionId
              })
            : known,
          wanted ? remoteStore.readCollectionMeta(collectionId) : undefined
        ])
      } catch (err) {
        failures.push({ collection, err })
        return
      }
      if (encryption && hasKeyEpochs(encryption)) {
        descriptors[collectionId] = encryption
      }
      if (onCollection) {
        // The hook is guarded per collection too. A cipher rebuild raises
        // `KeyUnwrapError` when the served roster lists epochs and leaves this
        // app out (rotated off since the cached descriptor), or
        // `IntegrityError` when the roster's entry for this app fails its
        // key-wrap check (a corrupt or tampered entry), and a throw
        // escaping `Promise.all` here would reject the whole bootstrap:
        // nothing after the pass would run and no collection would replicate.
        // The failure costs that one collection, and its descriptor is
        // withdrawn from the fetched set so a roster this app cannot open is
        // not written into the offline cache the next bring-up opens from.
        try {
          await onCollection({
            collection,
            ...(encryption && { encryption }),
            ...(current && { current })
          })
        } catch (err) {
          delete descriptors[collectionId]
          failures.push({ collection, err })
        }
      }
    })
  )
  return { descriptors, failures }
}

/**
 * What one pass of Metadata reads settled to: the epoch-bearing descriptors
 * (a rosterless one cannot build a cipher) and, apart from them, every
 * collection whose read failed rather than answering "no object", or whose
 * per-collection hook rejected.
 */
export type DescriptorReadOutcome = {
  descriptors: Record<string, CollectionEncryption>
  failures: Array<{ collection: WasCollectionConfig; err: unknown }>
}

/**
 * One live encryption-descriptor read per granted private collection, invoked
 * with the grants' delegated zcaps and keyed by WAS collection id. Used at
 * login time, BEFORE any replication exists: the connected replica must open
 * epoch-aware -- epoch-from-birth leaves no single-key fallback, and the
 * adoption merge writes into it before sync starts. The sync bootstrap reuses
 * these reads (its `knownDescriptors` input) rather than re-issuing them.
 *
 * A failed read is reported on `failures` rather than rejecting, so the caller
 * chooses: a login rejects on any failure (the adoption merge would write
 * into a replica opened over a guess), while a hot restore skips the
 * collection fail-closed and leaves the sync bootstrap to repair it.
 *
 * @param options {object}
 * @param options.parsed {ParsedGrants}
 * @param options.zcapClient {ZcapClient}   invocation signer = grants' controller
 * @param options.collections {WasCollectionConfig[]}   the collections to read
 *   descriptors for (public ones are skipped)
 * @param [options.trust] {SpaceTrust}   the activation's Space trust state
 *   (owner view, chain-head pins), shared with the sync bootstrap's store so
 *   the owner is resolved once and the heads this read pins are what the
 *   bootstrap's reads are checked against
 * @returns {Promise<DescriptorReadOutcome>}
 */
export async function readRemoteDescriptors({
  parsed,
  zcapClient,
  collections,
  trust
}: {
  parsed: ParsedGrants
  zcapClient: ZcapClient
  collections: WasCollectionConfig[]
  trust?: SpaceTrust
}): Promise<DescriptorReadOutcome> {
  const remoteStore = WasRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections,
    ...(trust && { trust })
  })
  // A public collection has no descriptor, and nothing else on its object is
  // wanted before replication exists: it is left to the bootstrap's pass.
  return await readGrantedEncryption({
    remoteStore,
    collections: collections.filter(
      collection => !isPublicCollection(collection)
    ),
    parsed
  })
}

/**
 * Builds the remote store, opens the shared-collection readers, and starts
 * background replication.
 *
 * @param options {object}
 * @param options.parsed {ParsedGrants}
 * @param options.zcapClient {ZcapClient}   invocation signer = grants' controller
 * @param options.collections {WasCollectionConfig[]}   the collection registry;
 *   public (plaintext) collections are never marked encrypted
 * @param options.localStore {LocalStore}   the opened local encrypted replica
 * @param options.syncController {SyncController}   a fresh per-session controller
 * @param options.onRemoteChange {(collectionKey, event) => void}   per-doc
 *   reactive patcher for pulled/conflict-resolved remote changes
 * @param [options.sharedCollections] {SharedCollectionConfig[]}   the shared
 *   (read-only, wallet-owned) registry; never replicated, never written to
 * @param [options.identityKeys] {object}   this app's IDENTITY key-agreement key
 *   and its resolver, the recipient identity a wallet writes into a shared
 *   collection's epoch roster. Required to open any shared-collection reader,
 *   and to run the codec-driven blinded-index verbs on a private collection
 * @param [options.identityKeys.keyAgreementKey] {IKeyAgreementKey}
 * @param [options.identityKeys.keyResolver] {IKeyResolver}
 * @param [options.onAuthError] {() => void}   fired when replication hits a
 *   401/403 (expired/revoked access) -- wired to the reconnect banner
 * @param [options.onDescriptorsFetched] {(descriptors) => void | Promise<void>}   given
 *   the freshly fetched per-collection encryption descriptors (by WAS collection
 *   id), to refresh the offline descriptor cache
 * @param [options.knownDescriptors] {Record<string, CollectionEncryption>}
 *   descriptors the caller ALREADY read live in this same bring-up (the
 *   login-time {@link readRemoteDescriptors} pass); the bootstrap reuses them
 *   instead of re-issuing the same GET seconds later. A hot restore passes
 *   none -- there the bootstrap read IS the freshness refresh over the
 *   offline cache
 * @param [options.trust] {SpaceTrust}   the activation's Space trust state
 *   (the one the login-time {@link readRemoteDescriptors} pass resolved the
 *   owner into and pinned into), so every governed read of this session
 *   checks one owner and one continuity
 * @returns {Promise<WasSyncBootstrap>}
 */
export async function startWasSync({
  parsed,
  zcapClient,
  collections,
  localStore,
  syncController,
  onRemoteChange,
  sharedCollections = [],
  identityKeys,
  onAuthError,
  onDescriptorsFetched,
  knownDescriptors = {},
  trust
}: {
  parsed: ParsedGrants
  zcapClient: ZcapClient
  collections: WasCollectionConfig[]
  localStore: LocalStore
  syncController: SyncController
  onRemoteChange: (collectionKey: string, change: ReplicaChange) => void
  sharedCollections?: SharedCollectionConfig[]
  identityKeys?: {
    keyAgreementKey: IKeyAgreementKey
    keyResolver: IKeyResolver
  }
  onAuthError?: () => void
  onDescriptorsFetched?: (
    descriptors: Record<string, CollectionEncryption>
  ) => void | Promise<void>
  knownDescriptors?: Record<string, CollectionEncryption>
  trust?: SpaceTrust
}): Promise<WasSyncBootstrap> {
  const remoteStore = WasRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections,
    // The same identity keys that open a shared-collection reader also let the
    // client's EDV keystore build a codec, which the blinded-index verbs need.
    ...(identityKeys && { keys: identityKeys }),
    ...(trust && { trust })
  })

  // One pass per REGISTERED collection the grant set covers -- the registry is
  // what this app declared, so a granted id it never registered is none of this
  // bootstrap's business. Each private collection's descriptor is ACQUIRED
  // ONCE through the governed source (skipped for one the caller acquired
  // moments ago), and each collection's Metadata object is READ ONCE where the
  // pass wants it (a public one declaring indexes, a private one whose
  // descriptor was not known). Together they feed:
  //
  // - the best-effort public `plaintext` indexes declaration, a
  //   read-modify-write of the object the pass read, since under WAS v0.5 the
  //   object is replaced whole and a partial body would clear the members
  //   this app never touched. Non-fatal (a query against undeclared indexes
  //   fails with a descriptive 400), and skipped (reported ok + skipped) for
  //   a private collection or a public one with no declared indexes;
  // - the private collection's cipher rebuild, when the acquired descriptor's
  //   epoch roster differs from what the local store opened with (a
  //   wallet-side rotation, or first-ever epochs), with the fresh set handed
  //   to the descriptor-cache refresher so an offline session can rebuild its
  //   epoch-aware ciphers without a live read.
  //
  // A private collection with a blinding key costs extra reads of its own,
  // described further down.
  //
  // A private collection with a blinding key gets one more ride-along: the
  // object's `custom` envelope (RAW, the opaque form, not the decoded one) is
  // installed on that collection's local cipher, which carries the persisted
  // blinded-index schema. Documents written from then on carry blinded
  // `indexed` entries and are findable by `collection.find()`. It runs AFTER
  // the blinded-index declaration deliberately, and the declaration is the one
  // write here that changes `custom`: when it reports having written, the
  // object the pass read is stale and the envelope is read again; when it
  // wrote nothing (a returning session), the pre-read envelope is installed
  // as it is, and the collection costs no second round trip. A known
  // descriptor skips the pass's read, so the install reads then too.
  //
  // The blinded-index declaration is the one write a private collection
  // takes here, and it reads the object fresh for its own compare-and-swap.
  //
  // SHARED collections never appear here: they are wallet-owned, absent from
  // the app-owned registry, and a read-only grant would draw nothing but a
  // pointless 403.
  const { descriptors, failures } = await readGrantedEncryption({
    remoteStore,
    collections,
    parsed,
    knownDescriptors,
    onCollection: async ({ collection, encryption, current }) => {
      const { id: collectionId } = collection
      if (!isPublicCollection(collection)) {
        // Only an epoch-bearing descriptor enters the offline cache or
        // rebuilds a cipher; a collection without a key-epoch roster stays
        // fail-closed, stated plainly here rather than surfacing later as
        // per-row decrypt failures.
        if (hasKeyEpochs(encryption)) {
          await localStore.applyRemoteDescriptor({ collectionId, encryption })
        } else {
          log.warn(
            'A collection has no key-epoch roster on its encryption ' +
              'descriptor; it stays unreadable (fail-closed) until its ' +
              'provisioner installs one.',
            { collectionId }
          )
        }
        // The private-collection counterpart of the public `indexes`
        // declaration: the blinded-index schema lives in the object's
        // encrypted `custom` envelope, so it is written through the collection
        // handle's own compare-and-swap. Non-fatal: an unqueryable collection
        // is still a fully replicating one.
        const blinded = await remoteStore.declareBlindedIndexes(collectionId, {
          encryption
        })
        if (!blinded.ok) {
          log.warn('Blinded-index declaration failed.', {
            collectionId,
            error: blinded.error ?? 'unknown error',
            status: blinded.status ?? 'n/a'
          })
        }
        // The schema the declaration just settled is then installed on this
        // collection's local cipher, so the documents this replica writes from
        // now on carry blinded `indexed` entries. A descriptor with no `hmac`
        // carries no blinding key at all, so the install could only be a no-op
        // and is skipped rather than spent. The envelope comes from the
        // object the pass read unless the declaration replaced it, or the
        // pass never read it; a read that fails (rather than answering "no
        // object") skips the install for this session with a warning: the
        // answer is unknown, and an install skipped over a guess is the same
        // outcome either way, but the warning says why.
        if (hasKeyEpochs(encryption) && encryption.hmac) {
          try {
            const read =
              current !== undefined && !blinded.wrote
                ? current
                : await remoteStore.readCollectionMeta(collectionId)
            if (read) {
              await localStore.applyCollectionMeta({
                collectionId,
                custom: read.description.custom
              })
            }
          } catch (err) {
            log.warn('Blinded-index schema install failed.', {
              collectionId,
              err
            })
          }
        }
      }
      const indexes = await remoteStore.declareCollectionIndexes(collectionId, {
        ...(current && { current })
      })
      if (!indexes.ok) {
        log.warn('Indexes declaration write not authorized.', {
          collectionId,
          status: indexes.status ?? 'n/a',
          error: indexes.error ?? 'unknown error'
        })
      }
    }
  })
  // A read or a hook that failed degrades that one collection: it keeps the
  // cipher it opened with (the cached descriptor, or fail-closed) and receives
  // no declaration write this session. A failed read is not "no object", and
  // a failed cipher rebuild is a `KeyUnwrapError` (a roster rotated off this
  // app) or an `IntegrityError` (this app's roster entry fails its key-wrap
  // check) the per-row decrypts repeat, not a bootstrap failure.
  for (const { collection, err } of failures) {
    log.warn(
      'Skipping the sync bootstrap of a collection: its metadata object ' +
        'could not be read, or its bring-up failed.',
      { collectionId: collection.id, err }
    )
  }
  // Install the store's log-governed descriptor source so a decrypt that meets
  // an unseen epoch (a rotation elsewhere) re-reads the verified log head and
  // rebuilds the cipher -- once per collection per session.
  localStore.setDescriptorSource(remoteStore.descriptorSource)
  if (onDescriptorsFetched) {
    await onDescriptorsFetched(descriptors)
  }

  // Shared collections stay entirely out of replication: one read-only reader
  // each, opened over the delegated read zcap and the collection's epoch
  // roster. Every failure mode here is a warn-and-skip -- an uncovered grant,
  // a collection with no roster, an app that is not (or is no longer) a
  // recipient -- so a removed share degrades one reader, never the session.
  // Opened concurrently: each `open` costs a description read plus an ECDH
  // unwrap, and no reader depends on another.
  const sharedReaders: Record<string, SharedCollectionReader> = {}
  await Promise.all(
    sharedCollections.map(async ({ key, id }) => {
      if (!parsed.byCollectionId[id]) {
        log.warn(
          'Skipping a shared collection: no delegated capability covers it.',
          { collectionId: id }
        )
        return
      }
      if (!identityKeys) {
        log.warn(
          'Skipping a shared collection: no identity key-agreement key was ' +
            'supplied to decrypt it with.',
          { collectionId: id }
        )
        return
      }
      try {
        sharedReaders[key] = await SharedCollectionReader.open({
          remoteStore,
          keyAgreementKey: identityKeys.keyAgreementKey,
          keyResolver: identityKeys.keyResolver,
          collectionId: id
        })
      } catch (err) {
        log.warn('Skipping a shared collection.', { collectionId: id, err })
      }
    })
  )

  await syncController.start({
    remoteStore,
    localStore,
    onRemoteChange,
    ...(onAuthError && { onAuthError })
  })
  return { remoteStore, sharedCollections: sharedReaders }
}
