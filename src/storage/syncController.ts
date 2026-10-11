/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * SyncController: this library's session binding over the replication
 * controller core in `@interop/was-sync/rxdb`.
 *
 * The core owns the lifecycle -- the serialized start/stop queue, one
 * `replicateRxCollection` state machine per collection, the per-collection
 * capability skip, the status and auth-error callbacks, the poll timer, and the
 * failed-bring-up unwind. What this binding owns is everything app-shaped: the
 * port built from the session's {@link WasRemoteStore} and {@link LocalStore},
 * the browser reachability source, the poll interval from the app's
 * {@link WasSyncConfig}, the session's `writerId` handed to the core as its
 * writer-attribution label (unless the config's `declareWriterId` opts out),
 * and the Zustand {@link SyncStatusStore} the statuses are written into (keyed
 * by the registry's LOGICAL collection key, which is the first argument the
 * core delivers).
 *
 * A controller is single-use per session, which is the core's own rule: `stop()`
 * is terminal for a core instance, so the binding builds a fresh one inside
 * `start()` and resets the status store on stop.
 *
 * The core's `isAuthError` predicate is not re-exported here: import it from
 * `@interop/was-sync/rxdb`, which this module itself only loads inside
 * `start()`.
 */
import type { SyncController as SyncControllerCore } from '@interop/was-sync/rxdb'
import type { IZcap } from '@interop/data-integrity-core'
import {
  DEFAULT_SYNC_POLL_MS,
  type WasCollectionConfig,
  type WasSyncConfig
} from '../config.js'
import type { LocalStore, ReplicaChange } from './localStore.js'
import type { WasRemoteStore } from './wasRemoteStore.js'
import type { SyncStatusStore } from './syncStatusStore.js'
import { log } from '../log.js'

/**
 * The browser reachability source the core polls and subscribes through. An
 * `isOnline` that cannot answer reports `true`, since a platform with no
 * reachability signal must still poll.
 *
 * @returns {object}   the core's `onlineSource` port
 */
function browserOnlineSource(): {
  isOnline: () => boolean
  subscribe: (onOnline: () => void) => () => void
} {
  return {
    isOnline: () =>
      typeof navigator === 'undefined' || navigator.onLine !== false,
    subscribe: onOnline => {
      if (typeof window === 'undefined') {
        return () => {}
      }
      window.addEventListener('online', onOnline)
      return () => window.removeEventListener('online', onOnline)
    }
  }
}

/**
 * A per-session controller around background replication.
 */
export class SyncController {
  #collections: WasCollectionConfig[]
  #sync: WasSyncConfig
  #syncStatus: SyncStatusStore
  #writerId?: string
  #core?: SyncControllerCore
  #stopped = false

  /**
   * @param options {object}
   * @param options.collections {WasCollectionConfig[]}
   * @param options.syncStatus {SyncStatusStore}   the session's per-collection
   *   status store this controller reports into
   * @param [options.writerId] {string}   the session's resolved writer id
   *   (`StorageContext.writerId`, the same label the payloads are stamped
   *   with); declared on every push as `Writer-Id` unless
   *   `sync.declareWriterId` is `false`
   * @param [options.sync] {WasSyncConfig}
   */
  constructor({
    collections,
    syncStatus,
    writerId,
    sync
  }: {
    collections: WasCollectionConfig[]
    syncStatus: SyncStatusStore
    writerId?: string
    sync?: WasSyncConfig
  }) {
    this.#collections = collections
    this.#syncStatus = syncStatus
    this.#writerId = writerId
    this.#sync = sync ?? {}
  }

  /**
   * Starts background replication for every entity collection covered by the
   * grant set. Idempotent (a no-op if already running, or if `stop()` has
   * already run: `stop()` is terminal, so a logout that raced an in-flight
   * session bootstrap never spins up replications against a closed database).
   *
   * A failed bring-up rethrows, with every collection's status left at `error`,
   * so the caller's bootstrap can surface it.
   *
   * @param options {object}
   * @param options.remoteStore {WasRemoteStore}
   * @param options.localStore {LocalStore}
   * @param [options.onRemoteChange] {(collectionKey: string, change: ReplicaChange) => void}
   *   fired per replica change (pull or conflict-resolved push) for reactive
   *   per-doc store patching
   * @param [options.onAuthError] {() => void}   fired when a replication error
   *   carries a 401/403 (storage access expired/revoked)
   * @returns {Promise<void>}
   */
  async start({
    remoteStore,
    localStore,
    onRemoteChange,
    onAuthError
  }: {
    remoteStore: WasRemoteStore
    localStore: LocalStore
    onRemoteChange?: (collectionKey: string, change: ReplicaChange) => void
    onAuthError?: () => void
  }): Promise<void> {
    if (this.#core || this.#stopped) {
      return
    }
    const setStatus = this.#syncStatus.getState().setStatus
    // A collection the grant set does not cover would otherwise sync with no
    // capability and draw a fail-closed 403, tripping the session-wide
    // "storage access expired" banner. Flag it and keep it out of the port
    // instead, so an uncovered collection never masquerades as expired access.
    // The core makes the same call, but only for a port whose OTHER entries
    // carry a capability: it cannot tell an all-uncovered delegated port from
    // a wallet's root-capability port, and every session here is delegated.
    const covered: Array<{ key: string; id: string; capability: IZcap }> = []
    for (const { key, id } of this.#collections) {
      const capability = remoteStore.collectionCapability(id)
      if (!capability) {
        log.warn(
          'Skipping sync for a collection: no delegated capability ' +
            'covers it.',
          { collectionId: id }
        )
        setStatus(key, 'error')
        continue
      }
      covered.push({ key, id, capability })
    }
    // The driver subpath is the one `@interop/was-sync` entry that imports
    // `rxdb`, an optional peer here. Loading it at the first `start()` rather
    // than at module evaluation is what lets a replica-less app resolve this
    // package's root entry with `rxdb` absent.
    const { createSyncController } = await import('@interop/was-sync/rxdb')
    // The import is a suspension the guard above did not cover: a `stop()`
    // (or a second `start()`) that landed meanwhile must win, or replication
    // would start on a controller its owner already stopped.
    if (this.#core || this.#stopped) {
      return
    }
    this.#core = createSyncController({
      port: {
        wasClient: remoteStore.was,
        spaceId: remoteStore.spaceId,
        serverUrl: remoteStore.serverUrl,
        collections: covered,
        rxCollection: key => localStore.rxCollection(key),
        // The 412 conflict re-read resolves the primary state (the server's
        // write stamp and validators) from the changes-feed body: CORS hides
        // the `GET` ETag cross-origin, which is this library's deployment
        // shape.
        feedPrimaryRead: true,
        // A `401` / `403` / the server's masked `404` must arrive typed, or
        // `onAuthError` could never fire.
        mapAuthErrors: true,
        ...(this.#sync.batchSize !== undefined && {
          batchSize: this.#sync.batchSize
        }),
        ...(this.#sync.retryMs !== undefined && {
          retryTime: this.#sync.retryMs
        })
      },
      // The core delivers the logical key first and the WAS id second; the
      // status store is keyed on the logical key, since two registry entries
      // may share one WAS id. An `IntegrityError` out of the LWW conflict
      // handler's decrypt closure reports here as `error` too, through no
      // special case of its own.
      onStatus: (key, _collectionId, status) => setStatus(key, status),
      ...(onAuthError && { onAuthError }),
      ...(onRemoteChange && { onRemoteChange }),
      onlineSource: browserOnlineSource(),
      pollMs: this.#sync.pollMs ?? DEFAULT_SYNC_POLL_MS,
      // One label, two carriers: the payload's LWW stamp and the wire's
      // `Writer-Id` header. The opt-out withholds the wire carrier only, so
      // pushes declare no label; the pull side never reads it.
      ...(this.#writerId !== undefined &&
        this.#sync.declareWriterId !== false && { writerId: this.#writerId })
    })
    try {
      await this.#core.start()
    } catch (err) {
      // The core already unwound and flagged every collection; drop the
      // instance so this session's controller is not left holding a core it
      // can neither start nor usefully stop, and rethrow.
      this.#core = undefined
      throw err
    }
  }

  /**
   * Triggers an immediate replication cycle on every running collection, rather
   * than waiting for RxDB's next scheduled tick. Fire-and-forget.
   *
   * @returns {void}
   */
  reSync(): void {
    this.#core?.reSync()
  }

  /**
   * Stops replication and releases resources (the database is owned by the
   * caller). Idempotent, and terminal: a later `start()` is refused.
   *
   * @returns {Promise<void>}
   */
  async stop(): Promise<void> {
    this.#stopped = true
    const core = this.#core
    this.#core = undefined
    await core?.stop()
    this.#syncStatus.getState().reset()
  }
}
