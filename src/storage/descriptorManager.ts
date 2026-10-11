/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The session's collection-encryption descriptor policy, bound once to the app's
 * collection registry and its two seed stores (the connected session's and the
 * anonymous replica's). It owns where a descriptor comes from at each point of a
 * bring-up: minted locally at an anonymous collection's birth, read from the
 * offline cache before any remote exists, completed with live reads for a
 * granted private collection the cache does not cover, and written back to the
 * cache once the sync bootstrap has fetched a fresh set. The auth store merely
 * sequences these four operations.
 *
 * Every operation is best-effort in the same way: a failure leaves the affected
 * collections fail-closed (epoch-from-birth has no single-key fallback) and is
 * warned about, rather than failing the session.
 */
import type { CollectionEncryption } from '@interop/was-client'
import type { SpaceTrust } from './spaceTrust.js'
import { mintRecordEncryption } from '@interop/wallet-core/keyring'
import { isPublicCollection, type WasCollectionConfig } from '../config.js'
import type { IdentityAgents } from '../identity/agents.js'
import { createDescriptorCache, type SeedStore } from '../identity/seedStore.js'
import type { ParsedGrants } from '../grants.js'
import { readRemoteDescriptors } from './wasSync.js'
import { log } from '../log.js'

/**
 * The four descriptor operations, bound to one app's collections and stores.
 */
export interface DescriptorManager {
  loadOrMintAnonDescriptors(
    identity: IdentityAgents
  ): Promise<Record<string, CollectionEncryption>>
  loadCachedDescriptors(options: {
    controllerDid: string
  }): Promise<Record<string, CollectionEncryption> | undefined>
  cacheDescriptors(options: {
    descriptors: Record<string, CollectionEncryption>
    controllerDid: string
  }): Promise<void>
  completeDescriptors(options: {
    cached?: Record<string, CollectionEncryption>
    identity: IdentityAgents
    parsed: ParsedGrants
    onReadFailure: 'reject' | 'skip'
    trust?: SpaceTrust
  }): Promise<{
    descriptors?: Record<string, CollectionEncryption>
    fresh: Record<string, CollectionEncryption>
  }>
}

/**
 * Builds the descriptor manager for one app session.
 *
 * @param options {object}
 * @param options.collections {WasCollectionConfig[]}   the app-owned collection
 *   registry (public collections carry no descriptor)
 * @param options.sessionStore {SeedStore}   the connected session's persistence,
 *   holding the offline descriptor cache
 * @param options.anonStore {SeedStore}   the anonymous replica's persistence,
 *   holding the descriptors minted at local birth
 * @returns {DescriptorManager}
 */
export function createDescriptorManager({
  collections,
  sessionStore,
  anonStore
}: {
  collections: WasCollectionConfig[]
  sessionStore: SeedStore
  anonStore: SeedStore
}): DescriptorManager {
  // The offline encryption-descriptor cache, presented as the seam
  // `@interop/was-client/edv` acquires through. Reads serve the
  // connected replica's epoch-aware open (cache-only, no network); writes land
  // the descriptors the sync bootstrap fetched. Bound per controller DID at
  // each use: a login under a different controller than the one that cached
  // the descriptors reads the cache as empty rather than building ciphers the
  // new identity is no epoch recipient of.
  function sessionDescriptorCache(controllerDid: string) {
    return createDescriptorCache({
      store: sessionStore,
      controller: controllerDid
    })
  }

  /**
   * Loads -- or on first use mints and persists -- the anonymous replica's
   * per-collection encryption descriptors. Epoch-from-birth applies locally
   * too: a private collection's cipher only exists from an epoch-bearing
   * descriptor, and with no wallet to provision one the app mints it at the
   * collection's local birth -- a one-epoch roster sealed to the anonymous
   * identity's KAK alone (the same record-own-epoch construction wallet-core
   * uses for its own locally stored records). Persisted so a reload decrypts
   * the rows the previous session sealed.
   *
   * @param identity {IdentityAgents}   the anonymous identity
   * @returns {Promise<Record<string, CollectionEncryption>>}
   */
  async function loadOrMintAnonDescriptors(
    identity: IdentityAgents
  ): Promise<Record<string, CollectionEncryption>> {
    // The anonymous replica's descriptor cache, persisted alongside the anon
    // seed (and wiped with it). Kept apart from the connected session's cache
    // and bound to the anon controller: the two identities' epochs must never
    // cross.
    const cache = createDescriptorCache({
      store: anonStore,
      controller: identity.controllerDid
    })
    const cached = await cache.readAllDescriptors()
    const descriptors: Record<string, CollectionEncryption> = {}
    const minted: Record<string, CollectionEncryption> = {}
    for (const collection of collections) {
      if (isPublicCollection(collection)) {
        continue
      }
      const { id } = collection
      let descriptor = cached[id]
      if (!descriptor) {
        descriptor = await mintRecordEncryption({
          keyAgreementKey: identity.keyAgreementKey
        })
        minted[id] = descriptor
      }
      descriptors[id] = descriptor
    }
    if (Object.keys(minted).length > 0) {
      await cache.writeDescriptors({ descriptors: minted })
    }
    return descriptors
  }

  /**
   * Loads the cached encryption descriptors for the registered collections
   * (keyed by WAS collection id), or `undefined` when none are cached.
   *
   * Read CACHE-ONLY -- one read of the stored blob, filtered to the registered
   * collections -- because this runs before any remote store exists and must
   * not touch the network: the whole point is that an offline hot restore opens
   * epoch-aware. The connected session refreshes them from the server once sync
   * bootstraps. Best-effort: on a read failure the private collections open
   * fail-closed until the sync bootstrap supplies live descriptors.
   *
   * @param options {object}
   * @param options.controllerDid {string}   the identity whose cached
   *   descriptors are wanted (the cache stamp)
   * @returns {Promise<Record<string, CollectionEncryption> | undefined>}
   */
  async function loadCachedDescriptors({
    controllerDid
  }: {
    controllerDid: string
  }): Promise<Record<string, CollectionEncryption> | undefined> {
    try {
      const cached =
        await sessionDescriptorCache(controllerDid).readAllDescriptors()
      const descriptors: Record<string, CollectionEncryption> = {}
      for (const { id } of collections) {
        const descriptor = cached[id]
        if (descriptor) {
          descriptors[id] = descriptor
        }
      }
      return Object.keys(descriptors).length > 0 ? descriptors : undefined
    } catch (err) {
      log.warn('Failed to load cached encryption descriptors', { err })
      return undefined
    }
  }

  /**
   * Writes the descriptors the sync bootstrap fetched into the offline cache,
   * through the same seam {@link loadCachedDescriptors} reads -- one
   * read-modify-write for the whole set.
   *
   * @param options {object}
   * @param options.descriptors {Record<string, CollectionEncryption>}
   * @param options.controllerDid {string}   the identity the descriptors were
   *   fetched for (the cache stamp)
   * @returns {Promise<void>}
   */
  async function cacheDescriptors({
    descriptors,
    controllerDid
  }: {
    descriptors: Record<string, CollectionEncryption>
    controllerDid: string
  }): Promise<void> {
    await sessionDescriptorCache(controllerDid).writeDescriptors({
      descriptors
    })
  }

  /**
   * Completes the cached descriptor set with live reads for any granted
   * private collection the cache does not cover. A first login has no cache at
   * all, and the connected replica must open epoch-aware BEFORE sync starts:
   * the adoption merge writes into it right after open, and epoch-from-birth
   * leaves no single-key fallback to write under. A live read that answers
   * "no descriptor" leaves that collection fail-closed until the sync
   * bootstrap's own read lands. A read that FAILS is an unknown answer, not an
   * absent one, and `onReadFailure` decides what it costs. `'reject'` (login)
   * rejects the whole completion: opening the replica over a guess would hand
   * a correctly provisioned collection the placeholder cipher and fail the
   * adoption merge on it, so the caller falls back to `local` with the error,
   * where the anonymous replica is intact for a retry. `'skip'` (a hot
   * restore, which adopts nothing) warns and leaves that collection
   * fail-closed for the sync bootstrap to repair, so a reload while offline
   * still restores the connected session. Freshly fetched descriptors enter
   * the offline cache immediately (best-effort), and come back separately as
   * `fresh` so the sync bootstrap can reuse them instead of re-issuing the
   * same reads seconds later (cached descriptors are NOT passed on -- the
   * bootstrap read is their freshness refresh).
   *
   * @param options {object}
   * @param [options.cached] {Record<string, CollectionEncryption>}
   * @param options.identity {IdentityAgents}
   * @param options.parsed {ParsedGrants}
   * @param options.onReadFailure {'reject' | 'skip'}
   * @param [options.trust] {SpaceTrust}   the activation's Space trust state,
   *   shared with the sync bootstrap's reads
   * @returns {Promise<object>}   `descriptors` (the completed set, or
   *   undefined when there are none) and `fresh` (the live-read subset)
   */
  async function completeDescriptors({
    cached,
    identity,
    parsed,
    onReadFailure,
    trust
  }: {
    cached?: Record<string, CollectionEncryption>
    identity: IdentityAgents
    parsed: ParsedGrants
    onReadFailure: 'reject' | 'skip'
    trust?: SpaceTrust
  }): Promise<{
    descriptors?: Record<string, CollectionEncryption>
    fresh: Record<string, CollectionEncryption>
  }> {
    const missing = collections.filter(
      collection =>
        !isPublicCollection(collection) &&
        parsed.byCollectionId[collection.id] !== undefined &&
        !cached?.[collection.id]
    )
    if (missing.length === 0) {
      return { descriptors: cached, fresh: {} }
    }
    const { descriptors: fetched, failures } = await readRemoteDescriptors({
      parsed,
      zcapClient: identity.zcapClient,
      collections: missing,
      ...(trust && { trust })
    })
    if (failures.length > 0) {
      if (onReadFailure === 'reject') {
        throw failures[0]?.err
      }
      for (const { collection, err } of failures) {
        log.warn(
          'Opening a collection fail-closed: its encryption descriptor could ' +
            'not be read at restore.',
          { collectionId: collection.id, err }
        )
      }
    }
    if (Object.keys(fetched).length === 0) {
      return { descriptors: cached, fresh: {} }
    }
    try {
      await cacheDescriptors({
        descriptors: fetched,
        controllerDid: identity.controllerDid
      })
    } catch (err) {
      log.warn('Failed to cache encryption descriptors at login', { err })
    }
    return { descriptors: { ...fetched, ...cached }, fresh: fetched }
  }

  return {
    loadOrMintAnonDescriptors,
    loadCachedDescriptors,
    cacheDescriptors,
    completeDescriptors
  }
}
