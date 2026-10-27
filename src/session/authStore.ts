/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The session auth store (zustand): a four-state machine
 * (`boot` | `local` | `connected` | `reconnect`) that owns the whole session
 * lifecycle -- boot (hot restore or fall to an anonymous local replica), Login
 * With Wallet, the non-CHAPI `connectWithGrants` path, logout, clear-data, and
 * the expired-access reconnect -- plus the open/hydrate/sync ordering.
 *
 * `boot` attempts a zero-popup session restore. A restore hit opens the
 * encrypted {@link LocalStore} under the session seed, hydrates the entity
 * stores, starts WAS replication, and lands `connected`. A restore miss (or any
 * error) opens the store under a persisted ANONYMOUS seed instead and lands
 * `local`: a fully usable, encrypted, local-only replica with no remote. Both
 * successors finish open+hydrate before leaving `boot`, so "app ready" is simply
 * `status !== 'boot'`.
 *
 * Login (or `connectWithGrants`) tears the anonymous replica down and opens the
 * connected replica under the wallet-derived seed. By default it ADOPTS the
 * anonymous replica's data first (`adopt: 'merge'`): the replica is detached,
 * its decrypted payloads are collected through a fresh handle re-derived from
 * the persisted seed, LWW-merged into the connected replica before its
 * first hydrate/sync (so they reach the server as ordinary creates), and the
 * anonymous seed + database are deleted once the activation lands. `adopt:
 * 'leave'` sets the anonymous replica aside untouched instead (it returns after
 * a logout). Logout returns to a fresh `local` (optionally wiping the connected
 * replica, and leaving the anonymous one in place); `clearLocalData` deletes
 * every database this app ever wrote on the browser, drops the persisted writer
 * id and any persisted connected session, and mints a brand-new anonymous seed
 * and replica.
 *
 * The library cannot bind a module-level store to app config, so this is a
 * FACTORY: {@link createAuthStore} captures the app's {@link WasAppConfig} and
 * {@link StoreRegistry} once (the React provider calls it once) and returns a
 * vanilla zustand store the hooks consume through context.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { IZcap } from '@interop/data-integrity-core'
import type { CollectionEncryption } from '@interop/was-client'
import {
  DEFAULT_DB_NAME,
  DEFAULT_EXPIRY_WARNING_MS,
  DEFAULT_EXPIRY_WATCH_MS,
  DEFAULT_ONBOARDING,
  DEFAULT_STORAGE_KEY_PREFIX,
  type StoreRegistry,
  type WasAppConfig
} from '../config.js'
import type { SharedCollectionReader } from '../storage/sharedCollectionReader.js'
import { createDocumentLoader } from '../identity/documentLoader.js'
import { deriveIdentity, type IdentityAgents } from '../identity/agents.js'
import { createSeedStore, type SeedStore } from '../identity/seedStore.js'
import { createDescriptorManager } from '../storage/descriptorManager.js'
import {
  clearAppSession,
  peekAppSession,
  persistAppSession,
  restoreAppSession,
  isNearExpiry,
  earliestExpiry,
  NO_EXPIRY_MS
} from '../identity/appSession.js'
import {
  loginWithWallet,
  requestGrants,
  LoginCancelledError,
  type LoginConfig,
  type LoginPhase
} from '../auth/loginFlow.js'
import { parseGrants, type ParsedGrants } from '../grants.js'
import {
  LocalStore,
  dbNameForController,
  type ReplicaStorage
} from '../storage/localStore.js'
import {
  executeLocalWipe,
  snapshotWipeTargets,
  type LocalWipeReport,
  type WipeTargets
} from './localWipe.js'
import { activateStorageContext, hasStore } from '../storage/storageManager.js'
import { StorageContext } from '../storage/storageContext.js'
import { getWriterId } from '../storage/writerId.js'
import { mergeAdopted } from '../storage/adopt.js'
import { startWasSync } from '../storage/wasSync.js'
import { createSpaceTrust, type SpaceTrust } from '../storage/spaceTrust.js'
import { errorMessage } from '@interop/was-client/sync'
import { SyncController } from '../storage/syncController.js'
import { log } from '../log.js'

/**
 * The four session states:
 * - `boot`: attempting hot restore; both successors open + hydrate before this
 *   status is left.
 * - `local`: an encrypted anonymous-seed replica, no remote (the pre-connection
 *   product state; tier-1 apps may stay here indefinitely).
 * - `connected`: a wallet-derived identity, parsed grants, replication.
 * - `reconnect`: connected but access expired/revoked; the replica stays usable,
 *   remote invocations paused until re-login.
 */
export type SessionStatus = 'boot' | 'local' | 'connected' | 'reconnect'

/**
 * The network half of a connected activation (see `prepareActivation`): the
 * Space trust state and the descriptors the connected replica opens with.
 */
interface PreparedActivation {
  trust?: SpaceTrust
  descriptors?: Record<string, CollectionEncryption>
  fresh: Record<string, CollectionEncryption>
}

/**
 * What adoption carries from the anonymous replica into the connected one: the
 * decrypted payloads per collection key, plus the anonymous controller DID
 * (whose per-controller database is deleted once the merge lands).
 */
interface AdoptSource {
  controllerDid: string
  entities: Record<string, Array<{ id: string }>>
}

export interface AuthState {
  status: SessionStatus
  /**
   * The app's onboarding mode. Read by `ProtectedRoute` to decide whether to
   * render the app or redirect to login while in `local`; never affects the
   * store's own transitions.
   */
  onboarding: 'local-first' | 'login-gated'
  /**
   * The per-install LWW attribution id, resolved once at store creation from
   * `WasAppConfig.storageKeyPrefix` and exposed for display and debugging. The
   * entity-store write verbs and the adoption repair stamp it automatically, so
   * an app never has to: one install writes under one identity either way. It
   * is an attribution label, never an identity.
   */
  writerId: string
  /**
   * This session's storage context: the open replica, the remote store, the
   * writer id the write verbs stamp with, and the sync status store, all
   * scoped to this session store rather than to the process. Set once at
   * creation and never replaced; the `useSyncStatus` hook subscribes to its
   * `syncStatus` store through the provider.
   */
  storageContext: StorageContext
  /**
   * The current login phase, for the login page's progress line, and the single
   * source of truth for "a Login With Wallet flow is in flight" (non-`null`
   * throughout the flow; the `status` stays `local` meanwhile). `useSession` /
   * `useLogin` expose the boolean as `authenticating`, computed from this.
   */
  phase: LoginPhase | null
  error: string | null
  controllerDid: string | null
  /**
   * ISO expiry of the current grant set (earliest zcap expiry); `null` in
   * `local` (no grants).
   */
  expires: string | null
  reconnecting: boolean
  /**
   * The read-only readers over the wallet-owned collections the wallet shared
   * with this app, keyed by the `sharedCollections` config `key`. Populated once
   * replication bootstraps; empty in `local`, and cleared on logout / teardown.
   * A shared collection the wallet declined to grant (or that this app is not a
   * recipient of) is simply absent -- never a session failure.
   */
  sharedCollections: Record<string, SharedCollectionReader>
  /**
   * Attempt a zero-popup hot restore; a restore hit lands `connected`, any
   * miss/error falls to `local` (a fresh anonymous replica), never a dead login
   * screen. No-op once the status has left `boot`.
   */
  boot: () => Promise<void>
  /**
   * Full Login With Wallet (first-run or returning). On success tears down the
   * anonymous replica and opens the connected one. `adopt` decides what happens
   * to data created in `local` before this login: `'merge'` (the default)
   * LWW-merges it into the connected replica and then deletes the anonymous
   * seed + database; `'leave'` sets the anonymous replica aside untouched (it
   * returns after a logout). A cancel or failure leaves `local` intact either
   * way.
   *
   * Resolves with `{ firstRun }` on success (`firstRun` is true when this login
   * created a brand-new app key, so the app can show a "connected for the first
   * time" confirmation). Resolves with `null` when the user cancels a wallet
   * popup (not an error), and also when the session changed while the popup
   * was open (a `destroy` with no boot behind it, a `clearLocalData`, a
   * `connectWithGrants`): the connected session is not brought up, and
   * whatever session the change left is kept as it is. REJECTS on any genuine
   * failure, after recording the message in `error` so the UI state still
   * reflects it.
   *
   * @param [options] {object}
   * @param [options.adopt] {'merge' | 'leave'}
   * @returns {Promise<{ firstRun: boolean } | null>}
   */
  login: (options?: {
    adopt?: 'merge' | 'leave'
  }) => Promise<{ firstRun: boolean } | null>
  /**
   * Non-CHAPI connect from an explicit seed + grants (dev/test and provisioned
   * grants). Tears down the current replica and opens the connected one, with
   * the same `adopt` choice (and `'merge'` default) as `login`, so this path
   * exercises adoption exactly as a wallet login does.
   *
   * @param options {object}
   * @param options.seed {Uint8Array}
   * @param options.grants {IZcap[]}
   * @param [options.adopt] {'merge' | 'leave'}
   * @returns {Promise<void>}
   */
  connectWithGrants: (options: {
    seed: Uint8Array
    grants: IZcap[]
    adopt?: 'merge' | 'leave'
  }) => Promise<void>
  /**
   * Re-run the grants flow with the existing seed (expired access).
   */
  reconnect: () => Promise<void>
  /**
   * Detach the wallet and return to a fresh `local` replica. `wipe` deletes the
   * connected replica's database; otherwise it is kept on this browser. The
   * anonymous replica and the writer id survive either way -- a local-first app
   * keeps working logged out, and the user is expected to log back in here. Use
   * {@link WasAuthStore.clearLocalData} to remove everything.
   *
   * @param [options] {object}
   * @param [options.wipe] {boolean}
   * @returns {Promise<void>}
   */
  logout: (options?: { wipe?: boolean }) => Promise<void>
  /**
   * Delete everything this library ever wrote on this browser -- both replicas
   * (the connected one and the anonymous one), both seed stores, and the
   * persisted writer id -- and then mint a fresh anonymous seed/DID + replica.
   * Clearing while connected therefore fully disconnects (a later boot lands
   * `local` instead of silently reconnecting and syncing the data back down).
   * The reset primitive behind the "Clear data" button.
   *
   * Returns what was deleted and what could not be confirmed deleted, so a
   * caller can state an unverified outcome rather than claim a clean wipe.
   *
   * @returns {Promise<LocalWipeReport>}
   */
  clearLocalData: () => Promise<LocalWipeReport>
  /**
   * Whether the anonymous `local` replica currently holds any documents -- the
   * check a login screen runs to decide whether to offer the adoption choice
   * before `login()`. Always false outside `local`.
   */
  hasLocalData: () => Promise<boolean>
  notifyAccessExpired: () => void
  /**
   * Tears down the live replica (expiry watch, controller, local store) WITHOUT
   * wiping the persisted session record, and returns to `boot` so a fresh
   * `boot()` can re-open it. Called from the provider's unmount cleanup so an
   * unmount (or a React dev-mode remount) never orphans the replication loop or
   * the expiry-watch interval. Serialized with `boot` so a destroy fired while a
   * boot is still in flight tears down only once that boot has fully settled,
   * and a boot queued after it re-opens cleanly.
   */
  destroy: () => Promise<void>
}

/**
 * The vanilla zustand store returned by {@link createAuthStore}.
 */
export type WasAuthStore = StoreApi<AuthState>

/**
 * Builds the session auth store bound to an app's config and store registry.
 * Call once (the React provider does) and share the returned store through
 * context; the hooks read it via `useStore`.
 *
 * @param options {object}
 * @param options.config {WasAppConfig}   the app-wide configuration
 * @param options.registry {StoreRegistry}   the per-collection hydrate/patch
 *   handlers the rehydrate mechanism drives
 * @param [options.seedStore] {SeedStore}   the session IndexedDB persistence
 *   (defaults to one bound to `<dbName>-session`; inject a fake for tests)
 * @param [options.storage] {ReplicaStorage}   the storage for the local store
 *   (defaults to Dexie/IndexedDB; inject a fake for tests)
 * @returns {WasAuthStore}
 */
export function createAuthStore({
  config,
  registry,
  seedStore,
  storage
}: {
  config: WasAppConfig
  registry: StoreRegistry
  seedStore?: SeedStore
  storage?: ReplicaStorage
}): WasAuthStore {
  const dbName = config.dbName ?? DEFAULT_DB_NAME
  const onboarding = config.onboarding ?? DEFAULT_ONBOARDING
  // Resolve the per-install LWW writer id ONCE, honoring the configured
  // localStorage prefix, so every stamp -- the app's own writes and the
  // adoption repair -- carries the same attribution identity. It lives on the
  // session's storage context, which is made the active one here, before any
  // replica opens, so the write verbs can stamp from the start. Not while
  // another session's replica is still attached, though: a keyed provider
  // remount renders the new provider (and so runs this factory) before the
  // old one's unmount cleanup has torn its session down, and throwing here
  // would throw inside a React render. That session keeps the pointer until
  // its `destroy` detaches the replica and releases it (`deactivateStore`);
  // from then until this session's boot claims at `openAndHydrate`, the
  // facades throw rather than resolve the retired context. A boot that finds
  // the old replica still attached fails at its own attach instead.
  const writerId = getWriterId({
    ...(config.storageKeyPrefix !== undefined && {
      storageKeyPrefix: config.storageKeyPrefix
    })
  })
  const storageContext = new StorageContext({ registry, writerId })
  if (!hasStore()) {
    activateStorageContext(storageContext)
  }
  const sessionStore =
    seedStore ?? createSeedStore({ dbName: `${dbName}-session` })
  // The anonymous-seed persistence for `local` mode: only a raw 32-byte seed,
  // no session record, in its own IndexedDB so it never collides with the
  // wallet session or a connected replica.
  const anonStore = createSeedStore({ dbName: `${dbName}-anon` })
  // Where every encryption descriptor of this session comes from: minted at an
  // anonymous collection's birth, read from the offline cache, completed with
  // live reads, cached again after the sync bootstrap fetched. The store only
  // sequences these.
  const descriptorManager = createDescriptorManager({
    collections: config.collections,
    sessionStore,
    anonStore
  })
  const documentLoader = createDocumentLoader()

  // The login flow consumes only the WAS collection ids + visibility; this
  // config layer owns the `{ key, id }` registry.
  const loginConfig: LoginConfig = {
    appOrigin: config.appOrigin,
    appName: config.appName,
    collections: config.collections.map(collection => ({
      id: collection.id,
      ...(collection.visibility !== undefined && {
        visibility: collection.visibility
      })
    })),
    appUrl: config.appUrl,
    ...(config.sharedCollections && {
      sharedCollections: config.sharedCollections.map(entry => entry.id)
    }),
    documentLoader,
    ...(config.mediatorBase !== undefined && {
      mediatorBase: config.mediatorBase
    })
  }

  /**
   * How close to grant expiry the reconnect banner is raised proactively (so the
   * user re-grants before a live request fails). Wallet grants default to a long
   * TTL, so a short lead time never fires spuriously mid-session.
   */
  const warningMs = config.expiry?.warningMs ?? DEFAULT_EXPIRY_WARNING_MS
  /**
   * Poll interval for the near-expiry watch (grant expiry is coarse-grained).
   */
  const watchMs = config.expiry?.watchMs ?? DEFAULT_EXPIRY_WATCH_MS

  let expiryTimer: ReturnType<typeof setInterval> | undefined
  let expiryInitialCheck: ReturnType<typeof setTimeout> | undefined
  // The per-session controller: single-use, stopped on logout and replaced on a
  // reconnect (started once per grant set).
  let controller: SyncController | null = null
  // The in-flight `beginSync` promise (controller.start() awaits network round
  // trips first). Awaited before teardown so a logout racing the bootstrap
  // cannot stop the controller before it has finished starting.
  let pendingSync: Promise<void> | null = null

  // Serializes the boot/destroy lifecycle so their multi-await bring-up and
  // teardown never overlap. A fast unmount/remount of the session provider
  // (React dev-mode double effects) fires boot -> destroy -> boot in quick
  // succession; run unserialized, the first boot's continuations (open,
  // hydrate, start sync) race the destroy's teardown -- installing a
  // closed/duplicate replica as the process-wide holder, hydrating against a
  // torn-down store, or leaking an interval/controller behind the losing boot.
  // Chaining every boot/destroy through this promise makes each run to
  // completion before the next begins: destroy always tears down a fully-open
  // session, and a queued boot re-opens cleanly on top of it. Neither routine
  // awaits user interaction (boot starts replication in the background, never
  // blocking on it), so the chain cannot deadlock. `connectWithGrants` rides
  // the same chain (fired from mount-time effects, it IS part of this race --
  // see its comment), and so do `logout` and `clearLocalData` -- user-driven,
  // but they tear down and re-open the process-wide holder, so overlapping an
  // in-flight boot's bring-up would race two open/teardown sequences (see the
  // comment at `logout`). `login` and `reconnect` keep their CHAPI popup
  // await off it: chaining that would hold boots and destroys hostage to
  // user interaction. `login`'s connect epilogue (the replica swap) and
  // `reconnect`'s (the re-grant persist and sync restart) ride the chain once
  // the popup has answered.
  let lifecycle: Promise<void> = Promise.resolve()
  function serializeLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const run = lifecycle.then(task, task)
    lifecycle = run.then(
      () => {},
      () => {}
    )
    return run
  }

  /**
   * Stops the near-expiry watch (logout / re-grant).
   */
  function disarmExpiryWatch(): void {
    if (expiryTimer) {
      clearInterval(expiryTimer)
      expiryTimer = undefined
    }
    if (expiryInitialCheck) {
      clearTimeout(expiryInitialCheck)
      expiryInitialCheck = undefined
    }
  }

  /**
   * Watches the session's earliest grant expiry and raises the reconnect banner
   * once it is within `warningMs` (or already past). The first check is
   * DEFERRED a macrotask rather than run synchronously: every caller awaits
   * `persistAndStartSync` (which arms this watch) BEFORE writing
   * `status: 'connected'`, so a synchronous check
   * would always be swallowed by `notifyAccessExpired`'s connected gate and
   * then actively cleared -- leaving a restored near-expiry session without
   * its proactive banner until the first `watchMs` tick. Deferring runs the
   * check after the caller's continuation has set the status. Then checks on a
   * coarse interval; re-armed with the fresh expiry after a reconnect.
   */
  function armExpiryWatch(expires: string): void {
    disarmExpiryWatch()
    const check = () => {
      if (isNearExpiry(expires, warningMs)) {
        store.getState().notifyAccessExpired()
      }
    }
    expiryInitialCheck = setTimeout(check, 0)
    expiryTimer = setInterval(check, watchMs)
  }

  /**
   * Starts a fresh per-session controller replicating the granted collections,
   * wiring reactive per-doc store patching and the auth-error (401/403) signal.
   * The bootstrapped remote store is installed as the process-wide holder so
   * entity-store verbs that need the server (e.g. `query`) can reach it;
   * `stopController` clears it.
   */
  async function beginSync({
    parsed,
    identity,
    knownDescriptors,
    trust
  }: {
    parsed: ParsedGrants
    identity: IdentityAgents
    knownDescriptors?: Record<string, CollectionEncryption>
    trust?: SpaceTrust
  }): Promise<void> {
    const { controllerDid, zcapClient, keyAgreementKey, keyResolver } = identity
    controller = new SyncController({
      collections: config.collections,
      syncStatus: storageContext.syncStatus,
      writerId: storageContext.writerId,
      ...(config.sync && { sync: config.sync })
    })
    const { remoteStore, sharedCollections } = await startWasSync({
      parsed,
      zcapClient,
      collections: config.collections,
      localStore: storageContext.requireStore(),
      syncController: controller,
      onRemoteChange: (key, event) =>
        void storageContext.patchFromChange(key, event),
      ...(config.sharedCollections && {
        sharedCollections: config.sharedCollections
      }),
      identityKeys: { keyAgreementKey, keyResolver },
      onAuthError: () => store.getState().notifyAccessExpired(),
      onDescriptorsFetched: descriptors =>
        void descriptorManager
          .cacheDescriptors({ descriptors, controllerDid })
          .catch(err =>
            log.warn('Failed to cache encryption descriptors', { err })
          ),
      ...(knownDescriptors && { knownDescriptors }),
      ...(trust && { trust })
    })
    storageContext.attachRemoteStore(remoteStore)
    store.setState({ sharedCollections })
  }

  /**
   * Persists the session record, kicks off background replication, and arms the
   * near-expiry watch. Shared by the connected activation and the reconnect
   * re-grant paths (identical persist + begin-sync + arm sequence).
   *
   * @param options {object}
   * @param options.seed {Uint8Array}
   * @param options.identity {IdentityAgents}
   * @param [options.parsed] {ParsedGrants}   the storage topology; absent for
   *   a grant-less session, which persists nothing and replicates nothing
   * @param options.grants {IZcap[]}
   * @param options.expires {string}
   * @param [options.knownDescriptors] {Record<string, CollectionEncryption>}
   *   encryption descriptors already read live during this bring-up, for the
   *   sync bootstrap to reuse instead of re-reading
   * @param [options.trust] {SpaceTrust}   this activation's Space trust
   *   state, shared with the login-time descriptor read
   * @returns {Promise<void>}
   */
  async function persistAndStartSync({
    seed,
    identity,
    parsed,
    grants,
    expires,
    knownDescriptors,
    trust
  }: {
    seed: Uint8Array
    identity: IdentityAgents
    parsed?: ParsedGrants
    grants: IZcap[]
    expires: string
    knownDescriptors?: Record<string, CollectionEncryption>
    trust?: SpaceTrust
  }): Promise<void> {
    // A grant-less session (an app requesting no collections, or a shared-only
    // app whose user declined every share) names no server and no Space:
    // nothing replicates, there is no remote store to build, and nothing is
    // persisted, since the session record carries a storage location and a
    // non-empty grant set. A reload lands in `local`.
    if (parsed === undefined) {
      return
    }
    await persistAppSession({
      session: {
        seed,
        controllerDid: identity.controllerDid,
        baseUrl: parsed.baseUrl,
        spaceId: parsed.spaceId,
        grants,
        expires
      },
      store: sessionStore
    })
    // Replication starts in the background; a down server never blocks entry.
    pendingSync = beginSync({
      parsed,
      identity,
      ...(knownDescriptors && { knownDescriptors }),
      ...(trust && { trust })
    })
    // A failed bootstrap must not resolve silently: surface it on the session
    // `error` (the sync rollup shows the per-collection error statuses the
    // controller leaves behind). The session stays usable -- local-first --
    // but the UI no longer reports "Local only" over a wallet-connected
    // session that simply failed to start replicating.
    void pendingSync.catch(err => {
      log.warn('WAS sync failed to start', { err })
      // Deferred a macrotask: an immediate bootstrap failure would otherwise
      // race the caller's own `set({ ..., error: null })` (which lands right
      // after `persistAndStartSync` resolves) and be wiped by it.
      setTimeout(
        () =>
          store.setState({
            error: `Sync failed to start: ${errorMessage(err)}`
          }),
        0
      )
    })
    armExpiryWatch(expires)
  }

  /**
   * Awaits any in-flight `beginSync` (so the controller has finished starting)
   * and then stops and releases the controller. Idempotent.
   */
  async function stopController(): Promise<void> {
    if (pendingSync) {
      try {
        await pendingSync
      } catch {
        // A failed bootstrap is already logged by the `.catch` on `pendingSync`.
      }
      pendingSync = null
    }
    if (controller) {
      // Teardown is best-effort: a stop that throws is logged, and the rest
      // of the teardown (and every caller's state reset) still runs.
      try {
        await controller.stop()
      } catch (err) {
        log.warn('Error stopping the sync controller', { err })
      }
      controller = null
    }
    // The remote store belongs to the session that just stopped (a reconnect
    // re-grant installs a fresh one via `beginSync`). The shared-collection
    // readers hold that same store and its delegated zcaps, so they go with it.
    storageContext.detachRemoteStore()
    store.setState({ sharedCollections: {} })
  }

  /**
   * Opens the encrypted replica under `identity` (its identity KAK encrypts
   * every private collection; its controller DID names the database), attaches
   * it to the session's storage context, and hydrates every entity store.
   * Shared by `openLocal` and the connected activation. When `adopt` is given
   * (a connected activation following a merge login), the collected anonymous
   * payloads are LWW-merged in BEFORE the hydrate -- and before sync starts --
   * so the entity stores and the first push both see them as ordinary rows.
   *
   * @param options {object}
   * @param options.identity {IdentityAgents}
   * @param [options.adopt] {AdoptSource}
   * @param [options.descriptors] {Record<string, CollectionEncryption>}   cached
   *   encryption descriptors, so a connected (incl. offline hot-restore) or
   *   anonymous replica opens epoch-aware before any live description read
   * @returns {Promise<void>}
   */
  async function openAndHydrate({
    identity,
    adopt,
    descriptors
  }: {
    identity: IdentityAgents
    adopt?: AdoptSource
    descriptors?: Record<string, CollectionEncryption>
  }): Promise<void> {
    // Claim the active pointer BEFORE opening the replica: the claim is what
    // throws while another session's replica is attached, and refusing before
    // `LocalStore.init` leaves no freshly opened database behind (an open
    // RxDB database that nothing would close also counts toward RxDB's
    // process-wide open-collection cap). `attachStore` re-claims idempotently.
    activateStorageContext(storageContext)
    const local = await LocalStore.init({
      keyAgreementKey: identity.keyAgreementKey,
      keyResolver: identity.keyResolver,
      collections: config.collections,
      ...(config.sharedCollections && {
        sharedCollections: config.sharedCollections
      }),
      dbName: dbNameForController({
        dbName,
        controllerDid: identity.controllerDid
      }),
      ...(descriptors && { descriptors }),
      ...(storage && { storage })
    })
    try {
      storageContext.attachStore(local)
    } catch (err) {
      // Two sessions can both pass the creation-time claim (neither had a
      // replica attached yet) and both open a database; the attach-time claim
      // is where the loser learns it lost. Nothing else holds `local`, so close
      // it here, or the open database keeps its IndexedDB connection, counts
      // toward RxDB's process-wide cap, and blocks a later `remove()`.
      await local.close().catch((closeErr: unknown) => {
        log.warn('Error closing the losing replica', { err: closeErr })
      })
      throw err
    }
    if (adopt) {
      await mergeAdopted({
        store: local,
        entities: adopt.entities,
        writerId: storageContext.writerId
      })
    }
    await storageContext.hydrateAll()
  }

  /**
   * Loads the persisted anonymous seed, minting and persisting a fresh random
   * one on first use. `created` is true only when a new seed was generated (the
   * signal for the one-time `seedLocal` fixtures hook).
   *
   * @returns {Promise<{ seed: Uint8Array, created: boolean }>}
   */
  async function loadOrCreateAnonSeed(): Promise<{
    seed: Uint8Array
    created: boolean
  }> {
    const existing = await anonStore.loadSeed()
    if (existing) {
      return { seed: existing, created: false }
    }
    const seed = crypto.getRandomValues(new Uint8Array(32))
    await anonStore.saveSeed(seed)
    return { seed, created: true }
  }

  /**
   * Opens (or re-opens) the anonymous local replica and lands `local`. Seeds
   * dev fixtures only when the anonymous seed was just minted (so they run once
   * per fresh replica, never on reload).
   *
   * @returns {Promise<void>}
   */
  async function openLocal(): Promise<void> {
    const { seed, created } = await loadOrCreateAnonSeed()
    const identity = await deriveIdentity({ seed })
    await openAndHydrate({
      identity,
      descriptors: await descriptorManager.loadOrMintAnonDescriptors(identity)
    })
    if (created && config.seedLocal) {
      await config.seedLocal()
    }
    store.setState({
      status: 'local',
      controllerDid: identity.controllerDid,
      expires: null,
      error: null
    })
  }

  /**
   * The network half of a connected activation, run BEFORE any replica is
   * touched: one Space trust state for the whole activation (the login-time
   * descriptor read and the sync bootstrap build separate remote stores, and
   * the second must verify against the owner the first resolved and continue
   * the heads the first pinned), and the encryption descriptors the connected
   * replica opens epoch-aware with. The cached descriptors let an offline hot
   * restore decrypt multi-recipient envelopes with no live description read,
   * while a first login (no cache yet) completes the set with live reads. A
   * read that fails rejects a login (the adoption merge would write over a
   * guess) but only degrades a restore, which adopts nothing: a reload while
   * offline must not drop a connected user into `local`.
   *
   * Kept apart from the replica swap so the owner-log and collection-log
   * round trips run while the anonymous replica is still attached and
   * writable; only the local work (collect, open, merge, hydrate) sits in the
   * swap.
   *
   * @param session {object}   the connecting identity and its parsed grants
   * @param [session.parsed] {ParsedGrants}   absent for a grant-less session,
   *   which has no Space to trust and no descriptors to read
   * @param [session.restore] {boolean}   a hot restore rather than a login: a
   *   descriptor read that fails degrades that collection instead of rejecting
   * @returns {Promise<PreparedActivation>}
   */
  async function prepareActivation(session: {
    identity: IdentityAgents
    parsed?: ParsedGrants
    restore?: boolean
  }): Promise<PreparedActivation> {
    const { parsed } = session
    if (parsed === undefined) {
      return { fresh: {} }
    }
    const trust = createSpaceTrust(parsed)
    const { descriptors, fresh } = await descriptorManager.completeDescriptors({
      cached: await descriptorManager.loadCachedDescriptors({
        controllerDid: session.identity.controllerDid
      }),
      identity: session.identity,
      parsed,
      onReadFailure: session.restore ? 'skip' : 'reject',
      trust
    })
    return { trust, descriptors, fresh }
  }

  /**
   * Opens the connected replica under the session seed, hydrates, persists the
   * session, and starts sync. On any failure the store is torn back down and the
   * anonymous local replica re-opened (so the app never dead-ends), then the
   * error is rethrown for the caller to surface and finalize.
   *
   * @param session {object}   the session to open: its seed, identity, parsed
   *   grants and expiry, plus the payloads to adopt (merge logins only)
   * @param [session.restore] {boolean}   a hot restore rather than a login: a
   *   descriptor read that fails degrades that collection instead of rejecting
   * @param [session.prepared] {PreparedActivation}   the network half, when
   *   the caller already ran it (the connect transition runs it ahead of the
   *   replica swap); a restore runs it here
   * @returns {Promise<void>}
   */
  async function activateConnected(session: {
    seed: Uint8Array
    identity: IdentityAgents
    parsed?: ParsedGrants
    grants: IZcap[]
    expires: string
    adopt?: AdoptSource
    restore?: boolean
    prepared?: PreparedActivation
  }): Promise<void> {
    try {
      const { trust, descriptors, fresh } =
        session.prepared ?? (await prepareActivation(session))
      await openAndHydrate({
        identity: session.identity,
        ...(session.adopt && { adopt: session.adopt }),
        ...(descriptors && { descriptors })
      })
      await persistAndStartSync({
        seed: session.seed,
        identity: session.identity,
        ...(session.parsed && { parsed: session.parsed }),
        grants: session.grants,
        expires: session.expires,
        knownDescriptors: fresh,
        ...(trust && { trust })
      })
    } catch (err) {
      await deactivateStore()
      // The error the caller sees is the activation's own, never the one a
      // failed fallback hides behind it (`reopenLocal` records that one).
      await reopenLocal()
      throw err
    }
  }

  /**
   * Re-opens the anonymous replica after the live one was torn down, landing
   * `local`. When even that fails (an anonymous replica whose stored schema
   * hash no longer matches, an IndexedDB error), the session lands `local`
   * anyway, with no replica attached and the failure on `error`, rather than
   * keeping a status that names a connected session whose replica is gone and
   * whose record may be cleared. The one exception is a session still in
   * `boot`, whose fatal state is `boot` with `error`: that failure is left to
   * `boot` to surface.
   *
   * @returns {Promise<void>}
   */
  async function reopenLocal(): Promise<void> {
    try {
      await openLocal()
    } catch (err) {
      log.warn('Failed to re-open the anonymous local replica', { err })
      if (store.getState().status !== 'boot') {
        store.setState({
          status: 'local',
          controllerDid: null,
          expires: null,
          error: errorMessage(err)
        })
      }
    }
  }

  /**
   * Tears down the live replica + sync + entity stores WITHOUT touching either
   * persisted seed (the anonymous seed and the session record survive), and
   * releases the active storage-context pointer when this session holds it.
   * Closes the database by default; `deleteDb` deletes it instead (the wipe
   * paths).
   *
   * @param [options] {object}
   * @param [options.deleteDb] {boolean}   delete the database rather than
   *   closing it
   * @returns {Promise<void>}
   */
  async function deactivateStore({
    deleteDb = false
  }: { deleteDb?: boolean } = {}): Promise<void> {
    disarmExpiryWatch()
    // Detach first (cancelling the pending re-hydrates and retiring every
    // in-flight consumer of this replica), then drain the controller, then
    // close what was attached. The detach goes before the drain: stopping the
    // controller awaits the in-flight sync cycle, and a re-hydrate debounced
    // off a pull just before this would otherwise fire during that wait and
    // query a replica about to close.
    // The detach also releases the process-wide pointer the moment the
    // replica is gone. Left standing, it would keep naming a retired context
    // for the process lifetime: a keyed provider remount's entity-store verbs
    // would stamp the OLD session's writer id and write into the replica
    // about to be closed. Every re-open path below (`openLocal`, the
    // connected activation) reclaims on attach.
    const local = storageContext.detachStore()
    await stopController()
    if (local) {
      try {
        if (deleteDb) {
          await local.remove()
        } else {
          await local.close()
        }
      } catch (err) {
        log.warn('Error tearing down the local store', { err })
      }
    }
    storageContext.clearEntityStores()
    storageContext.syncStatus.getState().reset()
  }

  /**
   * Enumerates the databases a wipe of `grade` has to reach, BEFORE any of them
   * is deleted. The anonymous controller DID is re-derived from the persisted
   * anonymous seed while that seed still exists (the `clear` grade discards it,
   * and a name derived afterwards is a name that can no longer be derived at
   * all -- exactly the orphan this snapshot prevents). In `local` the live
   * `controllerDid` IS the anonymous one; in `connected` / `reconnect` the two
   * differ and the `clear` grade takes both.
   *
   * @param grade {'logout' | 'clear'}
   * @returns {Promise<WipeTargets>}
   */
  async function snapshotWipe(grade: 'logout' | 'clear'): Promise<WipeTargets> {
    let anonControllerDid: string | null = null
    if (grade === 'clear') {
      try {
        const seed = await anonStore.loadSeed()
        if (seed) {
          anonControllerDid = (await deriveIdentity({ seed })).controllerDid
        }
      } catch (err) {
        log.warn('Could not resolve the anonymous replica to wipe', { err })
      }
    }
    return snapshotWipeTargets({
      dbName,
      grade,
      connectedControllerDid: store.getState().controllerDid,
      anonControllerDid,
      storageKeyPrefix: config.storageKeyPrefix ?? DEFAULT_STORAGE_KEY_PREFIX
    })
  }

  /**
   * Reads every decrypted payload out of the anonymous replica (adoption is a
   * copy: the anonymous and connected replicas derive their ciphers from
   * different seeds, so envelopes cannot move across). Returns null when there
   * is nothing to adopt -- not in `local`, or every collection empty -- in
   * which case the anonymous database is simply left in place, exactly as an
   * `adopt: 'leave'` login leaves it.
   *
   * Reads through a FRESH handle on the anonymous database (re-derived from
   * the persisted anonymous seed), not the process-wide holder -- the holder
   * has already been torn down by {@link detachAndCollect} (and even before
   * that ordering existed, a provider unmount firing `destroy` mid-login could
   * close the holder out from under this read; `login`/`connectWithGrants`
   * are OFF the serialized boot/destroy lifecycle chain). Re-deriving from the
   * seed keeps the collect independent of the holder's lifecycle.
   *
   * Decides off the caller's PRE-FLOW snapshot of `{ status, controllerDid }`,
   * never the live state: a provider unmount (a route change or StrictMode
   * remount) firing `destroy` while the CHAPI popup is open resets the live
   * status to `boot`, and reading it here would silently collect nothing --
   * an `adopt: 'merge'` login would then resolve successfully while the
   * user's pre-login data never reaches their Web Space.
   *
   * @param snapshot {object}   the caller's state snapshot from before its
   *   first await
   * @returns {Promise<AdoptSource | null>}
   */
  async function collectAdoptable(snapshot: {
    status: SessionStatus
    controllerDid: string | null
  }): Promise<AdoptSource | null> {
    const { status, controllerDid } = snapshot
    if (status !== 'local' || controllerDid === null) {
      return null
    }
    const seed = await anonStore.loadSeed()
    if (!seed) {
      return null
    }
    const identity = await deriveIdentity({ seed })
    const anonLocal = await LocalStore.init({
      keyAgreementKey: identity.keyAgreementKey,
      keyResolver: identity.keyResolver,
      collections: config.collections,
      dbName: dbNameForController({ dbName, controllerDid }),
      descriptors: await descriptorManager.loadOrMintAnonDescriptors(identity),
      ...(storage && { storage })
    })
    try {
      // Read every collection at once: the replica is detached for the whole
      // read, so the transition is as short as the slowest collection rather
      // than the sum of them all.
      const listed = await Promise.all(
        config.collections.map(async ({ key }) => ({
          key,
          payloads: await anonLocal.listEntities(key)
        }))
      )
      const entities: AdoptSource['entities'] = {}
      let total = 0
      for (const { key, payloads } of listed) {
        if (payloads.length > 0) {
          entities[key] = payloads
          total += payloads.length
        }
      }
      return total > 0 ? { controllerDid, entities } : null
    } finally {
      await anonLocal.close()
    }
  }

  /**
   * The connect-transition prologue shared by `login` and `connectWithGrants`:
   * tears the anonymous holder down FIRST and only then reads the adoptable
   * payloads (merge only) through the fresh handle `collectAdoptable` opens.
   * The ordering is load-bearing: the holder and the collect handle each open
   * every configured collection, so holding both at once doubles the open-
   * collection count and trips RxDB's process-wide open-collections cap for
   * apps with many collections (COL23). Detaching first keeps at most one
   * replica's collections open at any moment during the transition.
   *
   * After the holder is gone a collect failure would otherwise strand the
   * session with no open store, so it re-opens the anonymous replica (nothing
   * has been adopted yet; `local` survives intact) and rethrows.
   *
   * @param adopt {'merge' | 'leave'}
   * @param snapshot {object}   the caller's pre-flow `{ status, controllerDid }`
   *   snapshot (see {@link collectAdoptable})
   * @returns {Promise<AdoptSource | null>}
   */
  async function detachAndCollect(
    adopt: 'merge' | 'leave',
    snapshot: { status: SessionStatus; controllerDid: string | null }
  ): Promise<AdoptSource | null> {
    await deactivateStore()
    if (adopt !== 'merge') {
      return null
    }
    try {
      return await collectAdoptable(snapshot)
    } catch (err) {
      await openLocal()
      throw err
    }
  }

  /**
   * Deletes the adopted anonymous replica -- its per-controller database, the
   * Dexie shells RxDB's own removal leaves standing, and LAST its persisted
   * seed -- so the data lives on only in the connected replica and a later
   * logout lands in a genuinely fresh `local`. Called only after the connected
   * activation has landed (status written); any earlier failure leaves the
   * anonymous replica intact for the fallback to re-open.
   *
   * The database goes through the wipe executor at the one-name grade (no seed
   * store, no prefix sweep, no writer id), and the seed is cleared only once
   * the executor reports nothing failed. The order is what keeps a lingering
   * replica reachable: the database is named through the seed, so a seed
   * cleared ahead of a removal that then failed would orphan the database for
   * good. Kept, it re-opens as the next `local` replica, and a later merge
   * login collects it again. That re-collection is a repeat of this one, not a
   * no-op: a payload the connected account deleted meanwhile is re-inserted.
   *
   * Best-effort: a deletion failure (an anonymous Dexie database still open in
   * another tab, an IndexedDB quota error) is logged and swallowed. The
   * connected session is already live and syncing at this point, so failing
   * the login over its cleanup would report `local` over a genuinely connected
   * session.
   *
   * @param controllerDid {string}   the anonymous controller DID
   * @returns {Promise<void>}
   */
  async function discardAnonReplica(controllerDid: string): Promise<void> {
    const replicaDbName = dbNameForController({ dbName, controllerDid })
    try {
      const report = await executeLocalWipe({
        targets: {
          replicaDbNames: [replicaDbName],
          seedStoreDbNames: [],
          idbNamePrefixes: [],
          storageKeyPrefix: null
        },
        ...(storage && { storage })
      })
      if (report.failed.length > 0) {
        log.warn(
          'The adopted anonymous replica was not fully removed; its seed is kept so a later run can still name it',
          { dbName: replicaDbName, failed: report.failed }
        )
        return
      }
      await anonStore.clearSeedStore()
    } catch (err) {
      log.warn('Failed to delete the adopted anonymous replica', { err })
    }
  }

  /**
   * The connect epilogue shared by `login` and `connectWithGrants`, sequenced
   * once so the load-bearing ordering lives in one place: tear the anonymous
   * holder down and collect its payloads ({@link detachAndCollect}, merge
   * only), activate the connected replica, write the connected status, and
   * only THEN discard the adopted anonymous replica. The anonymous seed and
   * database are deleted only after the activation lands, so a failure at any
   * earlier step still falls back to an intact `local`; the cleanup itself is
   * best-effort ({@link discardAnonReplica}) and runs after the status write
   * so its failure can never leave the session reporting `local` over a live,
   * syncing connected session.
   *
   * @param options {object}
   * @param options.seed {Uint8Array}
   * @param options.identity {IdentityAgents}
   * @param [options.parsed] {ParsedGrants}   absent for a grant-less login
   * @param options.grants {IZcap[]}
   * @param options.expires {string}
   * @param options.adopt {'merge' | 'leave'}
   * @param options.snapshot {object}   the caller's pre-flow
   *   `{ status, controllerDid }` snapshot (see {@link collectAdoptable})
   * @returns {Promise<void>}
   */
  async function completeConnect({
    seed,
    identity,
    parsed,
    grants,
    expires,
    adopt,
    snapshot
  }: {
    seed: Uint8Array
    identity: IdentityAgents
    parsed?: ParsedGrants
    grants: IZcap[]
    expires: string
    adopt: 'merge' | 'leave'
    snapshot: { status: SessionStatus; controllerDid: string | null }
  }): Promise<void> {
    // The network half first, with the anonymous replica still attached: a
    // failed owner-log or descriptor read rejects here with nothing to undo.
    const prepared = await prepareActivation({
      identity,
      ...(parsed && { parsed })
    })
    // The replica swap: writes that arrive while no replica is attached wait
    // on it and land in the connected replica (or, on a failed activation, in
    // the re-opened anonymous one) once it is attached and hydrated. Only a
    // merge that carries anonymous data over opens one, which is exactly the
    // case `collectAdoptable` collects for: `adopt: 'merge'` from `local`.
    // Under `leave` the anonymous data is set aside, and a write composed
    // against it must not follow it over: an `update` of a set-aside doc would
    // find no envelope in the connected replica and resurrect it there as a
    // create. A login from `reconnect` collects nothing either, and a write
    // composed against the expired account's replica must not be written into
    // the newly connected account's as a create. Those writes reject instead,
    // as every mid-transition write did before the swap existed.
    const carriesAnonData =
      adopt === 'merge' &&
      snapshot.status === 'local' &&
      snapshot.controllerDid !== null
    if (carriesAnonData) {
      storageContext.beginSwap()
    }
    let source: AdoptSource | null
    try {
      source = await detachAndCollect(adopt, snapshot)
      await activateConnected({
        seed,
        identity,
        ...(parsed && { parsed }),
        grants,
        expires,
        prepared,
        ...(source && { adopt: source })
      })
    } finally {
      storageContext.endSwap()
    }
    store.setState({
      status: 'connected',
      controllerDid: identity.controllerDid,
      expires,
      phase: null,
      error: null
    })
    if (source) {
      await discardAnonReplica(source.controllerDid)
    }
  }

  // Declared last so `prefer-const` is satisfied; the lifecycle closures above
  // only dereference `store` at call time, by which point it is assigned.
  const store: WasAuthStore = createStore<AuthState>()((set, get) => {
    const bootImpl = async (): Promise<void> => {
      if (get().status !== 'boot') {
        return
      }
      try {
        const restored = await restoreAppSession({ store: sessionStore })
        if (!restored) {
          await openLocal()
          return
        }
        const identity = await deriveIdentity({ seed: restored.seed })
        if (identity.controllerDid !== restored.controllerDid) {
          // A corrupt record; treat as logged out and fall to local.
          await clearAppSession({ store: sessionStore })
          await openLocal()
          return
        }
        const parsed = parseGrants(restored.grants)
        // Unlike login/reconnect (which run `checkGrants`), a hot restore trusts
        // the persisted grants; re-check that they still cover every configured
        // collection so a partially-covered grant set raises the reconnect
        // banner proactively rather than waiting for a per-collection 403.
        const uncovered = config.collections.filter(
          collection => parsed.byCollectionId[collection.id] === undefined
        )
        await activateConnected({
          seed: restored.seed,
          identity,
          parsed,
          grants: restored.grants,
          expires: restored.expires,
          restore: true
        })
        set({
          status: uncovered.length > 0 ? 'reconnect' : 'connected',
          controllerDid: identity.controllerDid,
          expires: restored.expires,
          error: null
        })
      } catch (err) {
        log.warn('Session boot failed', { err })
        // `activateConnected` already re-opens local on its own failure (and
        // `openLocal` has written `local` then); surface the error over that,
        // and only open local here for a failure that never reached it.
        if (get().status !== 'boot') {
          set({ error: errorMessage(err) })
        }
        if (get().status === 'boot') {
          try {
            await openLocal()
          } catch (localErr) {
            // Even the anonymous local replica could not be opened: a genuine
            // storage failure, the only case that leaves `status` at `boot`
            // with an `error`. Surfacing it here (rather than a login/reconnect
            // failure, which only ever sets `error` after `status` has left
            // `boot`) is what lets `ProtectedRoute` scope its fatal alert to
            // boot/storage failures alone.
            set({ error: errorMessage(localErr) })
          }
        }
      }
    }

    const destroyImpl = async (): Promise<void> => {
      try {
        await deactivateStore()
      } finally {
        // Back to `boot` (not `local`) and both persisted seeds left intact: a
        // remount's `boot()` re-opens the same session (or local). Serialized
        // with `boot` (see `serializeLifecycle`), so this teardown always runs
        // against a fully-open session, never an in-flight one. The reset
        // lands even if the teardown throws, so a `login` epilogue never reads
        // the old session off a failed destroy.
        set({
          status: 'boot',
          phase: null,
          error: null,
          controllerDid: null,
          expires: null,
          reconnecting: false,
          sharedCollections: {}
        })
      }
    }

    return {
      status: 'boot',
      onboarding,
      writerId,
      storageContext,
      phase: null,
      error: null,
      controllerDid: null,
      expires: null,
      reconnecting: false,
      sharedCollections: {},

      boot: () => serializeLifecycle(bootImpl),

      login: async ({ adopt = 'merge' } = {}) => {
        if (get().phase !== null || get().status === 'connected') {
          return null
        }
        // Snapshot the pre-login state BEFORE the popup await: a provider
        // unmount (`destroy`) landing while CHAPI is open resets the live
        // status to `boot`, and the adoption collect must still see the
        // `local` session this login left.
        const preLogin = {
          status: get().status,
          controllerDid: get().controllerDid
        }
        set({ error: null, phase: 'connecting' })
        try {
          const outcome = await loginWithWallet({
            config: loginConfig,
            onPhase: phase => set({ phase })
          })
          // The wallet succeeded: run the shared connect epilogue (a cancel
          // above leaves `local` intact, and a failure inside it still falls
          // back to an intact `local` -- see `completeConnect`). The popup
          // await above stays off the lifecycle chain; the epilogue rides it,
          // since it swaps the process-wide holder and awaits no user
          // interaction. A `connectWithGrants` or a `destroy` queued meanwhile
          // runs to completion first instead of tearing the swap apart.
          return await serializeLifecycle(async () => {
            // Bail unless the session this login left is still the live one
            // (a StrictMode destroy/boot pair re-opens the same session and
            // passes): the epilogue must not bring a session up on top of one
            // the login never started from.
            const live = get()
            if (
              live.status !== preLogin.status ||
              live.controllerDid !== preLogin.controllerDid
            ) {
              log.warn(
                'Login abandoned: the session changed while the wallet popup was open',
                {
                  before: preLogin,
                  after: {
                    status: live.status,
                    controllerDid: live.controllerDid
                  }
                }
              )
              set({ phase: null })
              return null
            }
            await completeConnect({
              seed: outcome.seed,
              identity: outcome.identity,
              ...(outcome.parsed && { parsed: outcome.parsed }),
              grants: outcome.grants,
              expires: outcome.expires,
              adopt,
              snapshot: preLogin
            })
            return { firstRun: outcome.firstRun }
          })
        } catch (err) {
          // A cancel is not a failure: clear the in-flight flags without leaving a
          // scary error, and resolve with `null` so the caller can distinguish it
          // from a connected outcome. `local` stays intact.
          if (err instanceof LoginCancelledError) {
            set({ phase: null, error: null })
            return null
          }
          // A genuine failure: record the message so the UI state still reflects
          // it, then rethrow so the caller's promise rejects.
          const message = `Login failed: ${errorMessage(err)}`
          set({ phase: null, error: message })
          throw err
        }
      },

      connectWithGrants: async ({ seed, grants, adopt = 'merge' }) => {
        // Serialized with boot/destroy, unlike `login`: connectWithGrants is
        // typically fired from an effect at mount, exactly when a dev-mode
        // remount's queued destroy/boot pair is still draining the lifecycle
        // chain. Run off the chain, that pair tears down and re-opens the
        // anonymous replica UNDERNEATH the in-flight connect, and the adoption
        // collect races it -- nondeterministically dropping the local data the
        // merge was meant to carry over. Nothing here awaits user interaction
        // (the grants are already in hand), so the chain cannot deadlock;
        // `login` stays off it because it blocks on a wallet popup that must
        // not stall a queued destroy, and being user-driven it never runs as
        // part of the mount race. The connected guard makes a double-fired
        // connect (dev-mode double effects again) a no-op instead of a
        // re-activation, and the phase guard keeps it off a Login With
        // Wallet flow in flight: that login's popup await is off the chain,
        // so without the guard this connect would land first and the login's
        // epilogue would then swap out the replica it just opened.
        await serializeLifecycle(async () => {
          if (get().status === 'connected' || get().phase !== null) {
            return
          }
          const preConnect = {
            status: get().status,
            controllerDid: get().controllerDid
          }
          try {
            const identity = await deriveIdentity({ seed })
            const parsed = parseGrants(grants)
            const expires =
              earliestExpiry(grants) ??
              new Date(Date.now() + NO_EXPIRY_MS).toISOString()
            await completeConnect({
              seed,
              identity,
              parsed,
              grants,
              expires,
              adopt,
              snapshot: preConnect
            })
          } catch (err) {
            set({ error: errorMessage(err) })
            throw err
          }
        })
      },

      reconnect: async () => {
        const { reconnecting, status, controllerDid: startDid } = get()
        if (reconnecting || status !== 'reconnect') {
          return
        }
        set({ reconnecting: true, error: null })
        try {
          // The seed survives grant expiry; only the grants need renewing, and
          // the record carries the storage location the continuity check below
          // compares against. Peeked (not `restoreAppSession`, which WIPES an
          // expired record -- seed included -- exactly in the case reconnect
          // exists for), and read before the popup so the comparison baseline
          // cannot be overwritten mid-flow. A missing seed means the session is
          // unrecoverable in place.
          const { seed, record } = await peekAppSession({ store: sessionStore })
          if (!seed) {
            await get().logout()
            return
          }
          const identity = await deriveIdentity({ seed })
          const checked = await requestGrants({ identity, config: loginConfig })
          // Continuity check: `parseGrants` only asserts the returned set is
          // INTERNALLY consistent. Without this comparison, a reconnect
          // returning internally-consistent grants for a DIFFERENT server or
          // space would silently re-point the whole encrypted replica (whose
          // database name derives from the controller DID alone) at a new
          // storage location the user never chose. Refuse instead; switching
          // storage is a logout + fresh login, an explicit user action.
          if (
            record !== null &&
            checked.parsed !== undefined &&
            (checked.parsed.baseUrl !== record.baseUrl ||
              checked.parsed.spaceId !== record.spaceId)
          ) {
            throw new Error(
              `The renewed grants point at a different storage location ` +
                `("${checked.parsed.baseUrl}", space ` +
                `"${checked.parsed.spaceId}") than this session's ` +
                `("${record.baseUrl}", space "${record.spaceId}"). ` +
                `Refusing to re-point the session; log out and log in again ` +
                `to switch storage.`
            )
          }
          // The popup await above is off the lifecycle chain, so a `logout`,
          // `clearLocalData`, or `destroy` can complete while it is open. The
          // epilogue rides the chain (as `login`'s does) and re-checks the
          // session it is about to renew: persisting the record over a
          // completed logout would undo it, and `beginSync` would replicate
          // whatever replica is attached by then (the anonymous one) into the
          // user's Space under the wallet's zcaps.
          await serializeLifecycle(async () => {
            const { status, controllerDid } = get()
            if (status !== 'reconnect' || controllerDid !== startDid) {
              log.warn(
                'Discarding the renewed grants: the session left reconnect ' +
                  'while the wallet popup was open',
                { status, controllerDid, startDid }
              )
              set({ reconnecting: false })
              return
            }
            await stopController()
            await persistAndStartSync({
              seed,
              identity,
              ...(checked.parsed && { parsed: checked.parsed }),
              grants: checked.grants,
              expires: checked.expires
            })
            set({
              status: 'connected',
              expires: checked.expires,
              reconnecting: false
            })
          })
        } catch (err) {
          set({ reconnecting: false, error: errorMessage(err) })
        }
      },

      // Serialized with boot/destroy: a logout clicked during the StrictMode
      // remount churn after a reload (boot -> destroy -> boot, each a
      // multi-await bring-up/teardown) would otherwise tear the store down and
      // re-open the anonymous replica CONCURRENTLY with the queued boot's hot
      // restore -- two overlapping open/teardown sequences on the process-wide
      // holder, which can deadlock the re-open. Queued behind the chain, the
      // in-flight boot completes first and logout tears down a fully-open
      // session. Neither body awaits user interaction, so the chain cannot
      // deadlock.
      logout: ({ wipe = false } = {}) =>
        serializeLifecycle(async () => {
          // Snapshot before the teardown re-points `controllerDid` at the
          // anonymous identity. Only a connected session has a replica to
          // erase: a wiping logout from `local` is the anonymous replica
          // emptying itself, and its database is the one this grade spares.
          const connected =
            get().status === 'connected' || get().status === 'reconnect'
          const targets =
            wipe && connected ? await snapshotWipe('logout') : null
          // Tear down, clear the record, wipe, and only then re-open the
          // anonymous replica: the record goes before the re-open so a
          // re-open that fails (a stored schema hash that no longer matches
          // after an upgrade) never leaves the wallet seed on disk for a
          // reload to hot-restore. `deleteDb` deletes the open replica rather
          // than closing it (logout-and-erase); the persisted anonymous seed
          // is left alone either way, so a local-first app keeps working
          // logged out.
          await deactivateStore({ deleteDb: wipe })
          await clearAppSession({ store: sessionStore })
          if (targets) {
            // RxDB's own removal clears each collection's table but leaves its
            // IndexedDB database standing, so "erase data" would otherwise
            // leave the connected replica's shells (and the session store's)
            // behind. The `logout` grade names them and nothing else.
            await executeLocalWipe({
              targets,
              ...(storage && { storage })
            })
          }
          // Lands `local` (a fresh anonymous replica, or none with the
          // failure on `error`); clear the remaining transients.
          await reopenLocal()
          set({ phase: null, reconnecting: false })
        }),

      // Ordered so nothing is orphaned and nothing fresh is swept away:
      // snapshot every target while the identities that name them still exist,
      // tear the live replica down (an open database blocks its own deletion),
      // clear the persisted records (which is what reaches an INJECTED seed
      // store, whose database name this enumeration cannot know), wipe, and
      // only then mint the new anonymous identity -- `openLocal` last, so the
      // prefix sweep cannot delete the replica it just created.
      clearLocalData: () =>
        serializeLifecycle(async () => {
          const targets = await snapshotWipe('clear')
          await deactivateStore({ deleteDb: true })
          await anonStore.clearSeedStore()
          await clearAppSession({ store: sessionStore })
          const report = await executeLocalWipe({
            targets,
            ...(storage && { storage })
          })
          // The persisted id is gone; mint the fresh in-memory one the write
          // verbs stamp under from here on, and let the displayed value follow.
          const writerId = storageContext.resetWriterId()
          await openLocal()
          set({ phase: null, reconnecting: false, writerId })
          return report
        }),

      hasLocalData: async () => {
        if (get().status !== 'local') {
          return false
        }
        // This probe runs off the serialized boot/destroy lifecycle chain (the
        // login page calls it while in `local`), so a concurrent provider
        // unmount can close the replica mid-read; `whileAttached` reports that
        // as `undefined`, read as "no data". A count that fails against a
        // replica still attached (a corrupt collection, an IndexedDB error)
        // is warned about and read the same way: `false` only skips the
        // adoption prompt, and login's `'merge'` default still collects
        // (through a fresh handle) whatever exists, so the probe never rejects
        // into a login-button click handler. Counted in parallel: this runs
        // on that click, so the probe costs one round of counts rather than
        // one per collection.
        let counts: number[] | undefined
        try {
          counts = await storageContext.whileAttached(local =>
            Promise.all(
              config.collections.map(({ key }) => local.countEntities(key))
            )
          )
        } catch (err) {
          log.warn('Could not probe the local replica for data', { err })
          return false
        }
        return counts?.some(count => count > 0) ?? false
      },

      notifyAccessExpired: () => {
        if (get().status === 'connected') {
          set({ status: 'reconnect' })
        }
      },

      destroy: () => serializeLifecycle(destroyImpl)
    }
  })

  return store
}
