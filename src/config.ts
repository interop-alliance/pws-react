/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The central configuration contract for a PWS-backed local-first app: the app
 * identity/origin/URL, the registry of storage collections, and the
 * (all-optional) sync/expiry tuning. An app builds one
 * {@link PwsAppConfig} and threads it through the auth, storage, and sync
 * layers.
 *
 * A collection is a logical `key` (the app-side / RxDB collection handle) mapped
 * to its PWS collection `id` (the deliberately unprefixed, generic name shared
 * across interoperable apps). The auth layer consumes only the `id`s; this
 * config layer owns the `{ key, id }` registry the storage layer routes on.
 *
 * A SHARED collection ({@link SharedCollectionConfig}) is the other direction:
 * a wallet-owned, already-encrypted collection the app is granted read-and-
 * decrypt access to. It has the same `{ key, id }` shape but none of the
 * replication -- no RxDB collection, no writes, no local replica.
 *
 * The STORE REGISTRY ({@link StoreRegistry}) is the injection seam that replaces
 * the storage-layer's former hardcoded per-entity maps: an app supplies, per
 * collection key, the four handlers the rehydrate mechanism drives (hydrate the
 * whole collection, per-doc upsert/drop of an already-decrypted payload, and
 * clear-on-logout). Expressing each collection as its own set of functions lets
 * an app special-case a singleton collection (e.g. a current-focus doc) without
 * a rigid CRUD interface.
 */
/**
 * One storage collection: the logical `key` (app-side / RxDB collection handle)
 * mapped to its PWS collection `id` (the generic, interoperable name).
 */
export interface PwsCollectionConfig {
  /**
   * App-side name; the localStore / RxDB collection handle.
   */
  key: string
  /**
   * PWS collection id (the unprefixed, cross-app generic name).
   */
  id: string
  /**
   * Who can read the collection. `'private'` (the default) is the encrypted
   * mode: payloads are stored as EDV envelopes locally and remotely. `'public'`
   * declares a world-readable collection (the wallet provisions it with a
   * public-read policy); public implies PLAINTEXT -- payloads are stored as-is,
   * with no per-collection cipher, and the LWW bookkeeping fields (`updatedAt`,
   * `writerId`) are world-readable alongside the content (`writerId` is a
   * random per-install attribution label, but still a linkability handle across
   * a user's public documents). Changing a collection's visibility after first
   * use is a data-migration event, not a config tweak: existing rows keep
   * their stored form and stop being readable by the other mode.
   */
  visibility?: 'private' | 'public'
  /**
   * The content attributes the server indexes for equality queries
   * (`store.query({ equals })`), e.g. `['author', 'inReplyTo']`. Declared here
   * so the sync bootstrap can announce them; an undeclared attribute is
   * rejected fail-closed before any request. How they are announced depends on
   * the collection's visibility:
   *
   * - on a PUBLIC (plaintext) collection they are written into the collection
   *   description and served by the plaintext `filter[attr]=value` GET;
   * - on a PRIVATE (encrypted) collection they are declared as blinded-index
   *   attributes in the collection's own encrypted metadata and served by the
   *   `blinded-index` query profile. That requires the collection to have been
   *   provisioned with a blinded-index (blinding) key -- the key is installed
   *   with the collection's first key epoch or never -- and the declarations
   *   are prospective: a document written before its attribute was declared
   *   carries no blinded entry for it and is not findable until rewritten.
   */
  indexes?: string[]
}

/**
 * One SHARED collection: a wallet-owned, already-encrypted collection the app
 * asks the wallet for read-and-decrypt access to (the
 * `https://w3id.org/byoe#shared-wallet-collection` grant). It is the mirror image of
 * {@link PwsCollectionConfig}: read-only, NOT replicated into RxDB, NOT written
 * to, and with no local replica. Reads go straight to the server through a
 * `SharedCollectionReader`.
 */
export interface SharedCollectionConfig {
  /**
   * App-side name; the handle the app looks the reader up by.
   */
  key: string
  /**
   * PWS collection id in the wallet's Space (e.g. `private-credentials`).
   */
  id: string
}

/**
 * Optional replication tuning; each field falls back to a documented default.
 */
export interface PwsSyncConfig {
  /**
   * Replication batch size; `undefined` leaves the adapter default.
   */
  batchSize?: number
  /**
   * RxDB `retryTime` backoff (ms); `undefined` leaves the adapter default.
   */
  retryMs?: number
  /**
   * Periodic re-sync interval (ms) that keeps an open session converging while
   * the pull side is poll-based. Defaults to {@link DEFAULT_SYNC_POLL_MS}; set
   * to 0 to disable the periodic poll.
   */
  pollMs?: number
  /**
   * Whether every push declares the session's `writerId` to the server as the
   * `Writer-Id` header (default `true`). The label lets the host tell several
   * installs of one app apart when they share one delegated capability.
   * `false` withholds it: pushes declare no label (which clears any the
   * server held), while the payload's own `writerId` LWW stamp is unchanged.
   */
  declareWriterId?: boolean
}

/**
 * Optional near-expiry warning tuning; each field has the same default.
 */
export interface PwsExpiryConfig {
  /**
   * How close to grant expiry (ms) the reconnect warning is raised proactively.
   * Defaults to {@link DEFAULT_EXPIRY_WARNING_MS} (1h).
   */
  warningMs?: number
  /**
   * Poll interval (ms) for the near-expiry watch (grant expiry is
   * coarse-grained). Defaults to {@link DEFAULT_EXPIRY_WATCH_MS} (1min).
   */
  watchMs?: number
}

/**
 * The cohesive, app-wide configuration. Built once by the app and threaded
 * through the auth, storage, and sync layers.
 */
export interface PwsAppConfig {
  /**
   * Human-readable app name, used in the wallet consent reason lines.
   */
  appName: string
  /**
   * This app's own web origin (the anti-phishing bind on the app key).
   */
  appOrigin: string
  /**
   * This app's canonical URL: what identifies this application among the
   * applications served from its origin, so the app identity is scoped to the
   * triple (user, origin, `appUrl`). It MUST be an absolute URL, MUST NOT carry
   * a fragment, and MUST be same-origin with the app's live browser origin.
   * Everything downstream stores and compares the parsed URL's serialization,
   * so spellings differing only in a default port, in percent-encoding case, or
   * in dot-segments do not name distinct applications. An app with a Web App
   * Manifest is well served by using its processed manifest `id` here.
   */
  appUrl: string
  /**
   * The CHAPI mediator base URL (the requesting origin is appended).
   */
  mediatorBase?: string
  /**
   * The storage collections (logical key to PWS collection id).
   */
  collections: PwsCollectionConfig[]
  /**
   * Wallet-owned collections this app asks to be given READ-AND-DECRYPT access
   * to (the `https://w3id.org/byoe#shared-wallet-collection` grant). Read-only by construction: they
   * are never replicated into RxDB, never written to, and have no local
   * replica -- reads go straight to the server through a
   * `SharedCollectionReader`. A collection may be app-owned (`collections`) or
   * shared, never both.
   */
  sharedCollections?: SharedCollectionConfig[]
  /**
   * How the router treats the pre-connection `local` state. `'local-first'`
   * renders the app immediately over the anonymous replica (connecting a wallet
   * is a bonus); `'login-gated'` redirects to the login path until a wallet is
   * connected. Only affects `ProtectedRoute` rendering, never the store's
   * transitions (boot always opens a replica). Defaults to
   * {@link DEFAULT_ONBOARDING}.
   */
  onboarding?: 'local-first' | 'login-gated'
  /**
   * Optional dev-fixtures hook, called once -- and only when a brand-new
   * anonymous replica is first created (never on reload, since the anon seed
   * persists). Fixtures write through the app's own entity stores, so apps gate
   * this on dev themselves (e.g. `seedLocal: import.meta.env.DEV ? seed :
   * undefined`) to keep fixtures out of production local-first apps.
   */
  seedLocal?: () => Promise<void>
  /**
   * Base name for the local RxDB database and session IndexedDB naming. Defaults
   * to {@link DEFAULT_DB_NAME}.
   */
  dbName?: string
  /**
   * Prefix for this app's `localStorage` keys (e.g. the LWW `writerId`).
   * Defaults to {@link DEFAULT_STORAGE_KEY_PREFIX}. Migrating apps should set
   * their prior prefix so an existing per-install writer id is preserved.
   */
  storageKeyPrefix?: string
  /**
   * Replication tuning; all fields optional with documented defaults.
   */
  sync?: PwsSyncConfig
  /**
   * Near-expiry warning tuning; all fields optional with the same default.
   */
  expiry?: PwsExpiryConfig
}

/**
 * One collection's re-hydrate + patch handlers, supplied by the app. The
 * rehydrate mechanism drives these; expressing each collection as its own set of
 * functions lets an app special-case a singleton (e.g. a current-focus doc)
 * without a rigid CRUD interface.
 */
export interface StoreRegistryEntry {
  /**
   * Decrypt every live row of this collection into the app's store.
   */
  hydrate: () => Promise<void>
  /**
   * Upsert one already-decrypted payload into the store WITHOUT persisting (the
   * sync stream already owns the persisted row).
   */
  upsert: (doc: { id: string }) => void
  /**
   * Drop one payload (by logical uuid) from the store WITHOUT persisting.
   */
  drop: (uuid: string) => void
  /**
   * Empty this collection's store (logout).
   */
  clear: () => void
}

/**
 * The per-collection store handlers, keyed by the collection logical `key`. The
 * injection seam replacing the storage layer's former hardcoded maps.
 */
export type StoreRegistry = Record<string, StoreRegistryEntry>

/**
 * Default base name for the local RxDB database + session IndexedDB naming.
 */
export const DEFAULT_DB_NAME = 'pws-react'

/**
 * Default onboarding mode: `'login-gated'`, preserving the historical
 * gate-on-connected behavior for apps that do not opt into local-first.
 */
export const DEFAULT_ONBOARDING = 'login-gated'

/**
 * Default `localStorage` key prefix (e.g. `pws-react:writerId`).
 */
export const DEFAULT_STORAGE_KEY_PREFIX = 'pws-react:'

/**
 * Default periodic re-sync interval (ms). The pull side is poll-based (no
 * server-side live stream yet), so an open session only sees another device's
 * changes when it re-pulls; a low-frequency periodic re-sync keeps open sessions
 * converging live.
 */
export const DEFAULT_SYNC_POLL_MS = 15000

/**
 * Default near-expiry warning threshold (ms): 1 hour.
 */
export const DEFAULT_EXPIRY_WARNING_MS = 60 * 60 * 1000

/**
 * Default near-expiry watch poll interval (ms): 1 minute.
 */
export const DEFAULT_EXPIRY_WATCH_MS = 60 * 1000

/**
 * Validates a collection registry, fail-closed. Rejects an unknown `visibility`
 * value (a config written against a future library version must not silently
 * fall back to either mode), the encrypted-but-public combination: the same
 * PWS collection id registered under conflicting visibilities, which would
 * treat one server-side collection as both encrypted (private) and plaintext
 * (public), and malformed `indexes` declarations (empty or duplicate attribute
 * names, and the same PWS collection id declared with diverging index sets).
 * Indexes are valid on either visibility -- a public collection serves them
 * over the plaintext filter GET, a private one over the blinded-index query
 * profile -- so only their shape is checked here. Called by the storage layer
 * before any replica is opened.
 *
 * @param collections {PwsCollectionConfig[]}   the collection registry
 * @returns {void}
 */
export function validateCollections(collections: PwsCollectionConfig[]): void {
  const visibilityById = new Map<string, 'private' | 'public'>()
  const indexesById = new Map<string, string>()
  for (const { key, id, visibility, indexes } of collections) {
    const effective = visibility ?? 'private'
    if (effective !== 'private' && effective !== 'public') {
      throw new Error(
        `Collection "${key}" has unknown visibility "${String(visibility)}" ` +
          `(expected 'private' or 'public').`
      )
    }
    const prior = visibilityById.get(id)
    if (prior !== undefined && prior !== effective) {
      throw new Error(
        `Collection id "${id}" is registered as both '${prior}' and ` +
          `'${effective}': a collection cannot be encrypted and public at once.`
      )
    }
    visibilityById.set(id, effective)

    if (indexes !== undefined) {
      const seen = new Set<string>()
      for (const name of indexes) {
        if (typeof name !== 'string' || name.length === 0) {
          throw new Error(
            `Collection "${key}" declares an empty index attribute name.`
          )
        }
        if (seen.has(name)) {
          throw new Error(
            `Collection "${key}" declares index attribute "${name}" twice.`
          )
        }
        seen.add(name)
      }
    }
    // The same PWS id registered under two keys must declare identical indexes
    // (order-insensitive): the sync bootstrap announces ONE declaration per
    // server-side collection.
    const canonical = [...(indexes ?? [])].sort().join(' ')
    const priorIndexes = indexesById.get(id)
    if (priorIndexes !== undefined && priorIndexes !== canonical) {
      throw new Error(
        `Collection id "${id}" is registered with diverging index ` +
          `declarations; every entry for one PWS collection must declare the ` +
          `same indexes.`
      )
    }
    indexesById.set(id, canonical)
  }
}

/**
 * Validates the shared-collection registry against the app-owned one,
 * fail-closed. Rejects an empty `key` or `id`, a duplicate `key` or `id`, and
 * any `key` or `id` that also appears in `collections`: a collection cannot be
 * both app-owned (replicated, read-write, locally encrypted under the app's own
 * per-collection key) and shared read-only (never replicated, decrypted through
 * the wallet's epoch roster). Called by the storage layer before any replica is
 * opened.
 *
 * @param options {object}
 * @param options.collections {PwsCollectionConfig[]}   the app-owned registry
 * @param [options.sharedCollections] {SharedCollectionConfig[]}   the shared
 *   (read-only) registry
 * @returns {void}
 */
export function validateSharedCollections({
  collections,
  sharedCollections = []
}: {
  collections: PwsCollectionConfig[]
  sharedCollections?: SharedCollectionConfig[]
}): void {
  const ownedKeys = new Set(collections.map(entry => entry.key))
  const ownedIds = new Set(collections.map(entry => entry.id))
  const seenKeys = new Set<string>()
  const seenIds = new Set<string>()
  for (const { key, id } of sharedCollections) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('A shared collection declares an empty "key".')
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`Shared collection "${key}" declares an empty "id".`)
    }
    if (seenKeys.has(key)) {
      throw new Error(`Shared collection key "${key}" is declared twice.`)
    }
    seenKeys.add(key)
    if (seenIds.has(id)) {
      throw new Error(`Shared collection id "${id}" is declared twice.`)
    }
    seenIds.add(id)
    if (ownedKeys.has(key)) {
      throw new Error(
        `Shared collection key "${key}" is also an app collection key: a ` +
          `collection cannot be both app-owned and shared read-only.`
      )
    }
    if (ownedIds.has(id)) {
      throw new Error(
        `Shared collection id "${id}" is also an app collection id: a ` +
          `collection cannot be both app-owned and shared read-only.`
      )
    }
  }
}

/**
 * Whether a collection entry is public (world-readable plaintext), resolving
 * the registry default (an omitted `visibility` means `'private'`). The one
 * shared reading of the `visibility` field: branch sites dispatch through this
 * predicate rather than comparing the raw, possibly-undefined field, so a
 * future visibility mode extends here instead of at every site.
 *
 * @param collection {object}
 * @param [collection.visibility] {string}
 * @returns {boolean}
 */
export function isPublicCollection({
  visibility
}: Pick<PwsCollectionConfig, 'visibility'>): boolean {
  return (visibility ?? 'private') === 'public'
}
