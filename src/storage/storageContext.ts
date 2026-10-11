/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The session-scoped storage context: everything a session's storage layer
 * shares across its async consumers, bound to one store registry and owned by
 * one session auth store. It holds the open {@link LocalStore} replica, the
 * connected session's {@link WasRemoteStore}, the per-install writer id the
 * write verbs stamp with, the sync status store, and the debounced re-hydrate
 * timers -- the values that used to be module globals, so that two providers
 * in one process no longer clobber each other and a consumer never has to
 * invent its own "did the holder change under me" guard.
 *
 * Staleness is one mechanism, a generation counter: every attach and detach of
 * the replica bumps it. {@link StorageContext.whileAttached} runs an async
 * operation against the replica attached at its start and reports the result
 * only if the same replica is still attached when it settles; the scheduled
 * re-hydrates and the per-doc change patches are built on it. A consumer that
 * outlives its replica therefore ends as a silent no-op rather than as an
 * unhandled rejection or -- worse -- a write into the NEXT session's replica.
 */
import { uuidv7 } from 'uuidv7'
import type { StoreRegistry } from '../config.js'
import type { Json, LwwFields } from '@interop/was-sync'
import type { LocalStore } from './localStore.js'
import {
  activateStorageContext,
  deactivateStorageContext
} from './storageManager.js'
import {
  createSyncStatusStore,
  type SyncStatusStore
} from './syncStatusStore.js'
import type { WasRemoteStore } from './wasRemoteStore.js'

/**
 * The debounce window coalescing a pull burst into one re-hydrate.
 */
const REHYDRATE_DEBOUNCE_MS = 50

export class StorageContext {
  /**
   * The app's per-collection hydrate/patch handlers; the change patches and the
   * scheduled re-hydrates route on it.
   */
  readonly registry: StoreRegistry
  /**
   * This session's per-collection replication statuses.
   */
  readonly syncStatus: SyncStatusStore = createSyncStatusStore()
  #writerId: string
  #localStore: LocalStore | null = null
  #remoteStore: WasRemoteStore | null = null
  #generation = 0
  /**
   * The replica swap in progress (a connect transition), if any: the writes
   * that arrive while no replica is attached wait on it instead of throwing.
   */
  #swap: {
    promise: Promise<LocalStore>
    resolve: (store: LocalStore) => void
    reject: (err: Error) => void
  } | null = null
  /**
   * Per-collection debounce timers coalescing a pull burst into one hydrate.
   */
  readonly #rehydrateTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * @param options {object}
   * @param options.registry {StoreRegistry}
   * @param options.writerId {string}   the resolved per-install writer id (see
   *   `getWriterId`), the value every stamp of this session carries
   */
  constructor({
    registry,
    writerId
  }: {
    registry: StoreRegistry
    writerId: string
  }) {
    this.registry = registry
    this.#writerId = writerId
  }

  /**
   * The writer id this session stamps with: an unkeyed, clearable attribution
   * label, never an identity.
   *
   * @returns {string}
   */
  get writerId(): string {
    return this.#writerId
  }

  /**
   * Replaces the in-memory writer id with a fresh one (the clear-data wipe,
   * after `clearPersistedWriterId` removed the persisted one). The session
   * keeps running over its new anonymous replica and its write verbs still
   * have to stamp; nothing persists the new id, so the next run resolves and
   * stores an id of its own.
   *
   * @returns {string}   the new id
   */
  resetWriterId(): string {
    this.#writerId = uuidv7()
    return this.#writerId
  }

  /**
   * Stamps a payload with fresh last-write-wins fields: the current instant as
   * `updatedAt` and this session's writer id. Any values the caller supplied
   * are overwritten -- a stamp must describe THIS write, or a hydrated doc's
   * older `updatedAt` would ride a later edit and lose the conflict.
   *
   * @param payload {object}
   * @returns {object}   the payload with the LWW fields set
   */
  stampLww<T extends { id: string }>(payload: T): T & LwwFields {
    return {
      ...payload,
      updatedAt: new Date().toISOString(),
      writerId: this.#writerId
    }
  }

  /**
   * Installs the opened replica and makes this the process's active context
   * (the one the app-facing facades and the entity-store verbs resolve to).
   * Throws if ANOTHER context still has a replica attached: two live sessions
   * in one process would write into each other's entity stores.
   *
   * @param store {LocalStore}
   * @returns {void}
   */
  attachStore(store: LocalStore): void {
    activateStorageContext(this)
    this.#localStore = store
    this.#generation += 1
  }

  /**
   * Releases the replica (the caller closes or deletes it), cancels every
   * pending re-hydrate, and releases the process-wide active pointer when this
   * context holds it -- the mirror of {@link attachStore}'s claim. Anything
   * still in flight against the old replica sees the generation change and
   * ends as a no-op; the facades throw until the next attach claims a live
   * context, rather than resolving a retired one.
   *
   * @returns {LocalStore | null}   the replica that was attached, if any
   */
  detachStore(): LocalStore | null {
    for (const timer of this.#rehydrateTimers.values()) {
      clearTimeout(timer)
    }
    this.#rehydrateTimers.clear()
    const store = this.#localStore
    this.#localStore = null
    this.#generation += 1
    // During a swap the pointer stays: the facades keep resolving this
    // context, and its write verbs wait for the next attach (`awaitStore`)
    // rather than throwing into a click handler mid-transition.
    if (!this.#swap) {
      deactivateStorageContext(this)
    }
    return store
  }

  /**
   * Opens a replica swap: from here until {@link endSwap}, a detach keeps the
   * process-wide pointer and {@link awaitStore} waits for the replica the
   * swap attaches instead of throwing. Idempotent while a swap is open.
   *
   * @returns {void}
   */
  beginSwap(): void {
    if (this.#swap) {
      return
    }
    let resolve!: (store: LocalStore) => void
    let reject!: (err: Error) => void
    const promise = new Promise<LocalStore>((res, rej) => {
      resolve = res
      reject = rej
    })
    // A swap nobody awaits must not surface as an unhandled rejection.
    promise.catch(() => {})
    this.#swap = { promise, resolve, reject }
  }

  /**
   * Closes the swap: the waiting writes run against the replica attached now,
   * or reject with the no-replica error if the swap left none attached. A
   * no-op outside a swap.
   *
   * @returns {void}
   */
  endSwap(): void {
    const swap = this.#swap
    if (!swap) {
      return
    }
    this.#swap = null
    try {
      swap.resolve(this.requireStore())
    } catch (err) {
      swap.reject(err as Error)
      deactivateStorageContext(this)
    }
  }

  /**
   * The attached replica, waiting out an open swap first (the swap resolves
   * it once the new replica is attached and hydrated). Rejects, like
   * {@link requireStore} throws, when none is attached and no swap is open.
   *
   * @returns {Promise<LocalStore>}
   */
  async awaitStore(): Promise<LocalStore> {
    if (this.#swap) {
      return this.#swap.promise
    }
    return this.requireStore()
  }

  /**
   * Whether a replica is attached.
   *
   * @returns {boolean}
   */
  hasStore(): boolean {
    return this.#localStore !== null
  }

  /**
   * The attached replica, or throws if none is open.
   *
   * @returns {LocalStore}
   */
  requireStore(): LocalStore {
    if (!this.#localStore) {
      throw new Error('LocalStore is not initialized; open it first.')
    }
    return this.#localStore
  }

  /**
   * Runs `op` against the replica attached now and resolves with its result
   * only if that same replica is still attached when `op` settles. Resolves
   * `undefined` when no replica is attached, or when it was detached or
   * swapped meanwhile -- including when `op` rejected after the swap, since a
   * read torn by its own teardown is expected noise, not an error. A rejection
   * against a replica that is still attached propagates.
   *
   * @param op {(store: LocalStore) => Promise<T>}
   * @returns {Promise<T | undefined>}
   */
  async whileAttached<T>(
    op: (store: LocalStore) => Promise<T>
  ): Promise<T | undefined> {
    const store = this.#localStore
    if (!store) {
      return undefined
    }
    const generation = this.#generation
    let result: T
    try {
      result = await op(store)
    } catch (err) {
      if (this.#generation !== generation) {
        return undefined
      }
      throw err
    }
    return this.#generation === generation ? result : undefined
  }

  /**
   * Installs the connected session's delegated remote store (once background
   * sync has bootstrapped it from the granted zcaps).
   *
   * @param store {WasRemoteStore}
   * @returns {void}
   */
  attachRemoteStore(store: WasRemoteStore): void {
    this.#remoteStore = store
  }

  /**
   * Releases the remote store (logout / sync teardown).
   *
   * @returns {void}
   */
  detachRemoteStore(): void {
    this.#remoteStore = null
  }

  /**
   * Whether a connected session's remote store is available.
   *
   * @returns {boolean}
   */
  hasRemoteStore(): boolean {
    return this.#remoteStore !== null
  }

  /**
   * The connected session's remote store, or throws while no wallet-connected
   * session is active (local-only mode, or sync has not bootstrapped yet).
   *
   * @returns {WasRemoteStore}
   */
  requireRemoteStore(): WasRemoteStore {
    if (!this.#remoteStore) {
      throw new Error(
        'No WAS remote store is available; connect a wallet session first.'
      )
    }
    return this.#remoteStore
  }

  /**
   * Hydrates every registered store from the attached replica.
   *
   * @returns {Promise<void>}
   */
  async hydrateAll(): Promise<void> {
    await Promise.all(
      Object.values(this.registry).map(entry => entry.hydrate())
    )
  }

  /**
   * Empties every registered store (logout).
   *
   * @returns {void}
   */
  clearEntityStores(): void {
    for (const entry of Object.values(this.registry)) {
      entry.clear()
    }
  }

  /**
   * Patches ONE store from a single RxDB change event (per-doc, no
   * whole-collection re-hydrate): decrypt the changed envelope, then upsert the
   * payload (INSERT / UPDATE, including conflict-resolved rows) or drop it
   * (DELETE / tombstone). The `uuid -> envelopeId` index is kept in step so a
   * later local edit of a remotely-created doc still finds its envelope. Falls
   * back to a debounced whole-collection re-hydrate if the envelope is missing
   * or fails to decrypt.
   *
   * Fired floating off the RxDB change stream, so a logout/login teardown can
   * detach or swap the replica while the decrypt is in flight; the decrypt runs
   * under {@link StorageContext.whileAttached}, so an event that outlives its
   * replica is dropped rather than patched into the next session's stores.
   *
   * @param collectionKey {string}
   * @param event {object}   an RxDB change event (operation + documentData)
   * @returns {Promise<void>}
   */
  async patchFromChange(
    collectionKey: string,
    event: {
      operation: string
      documentData?: { id: string; data?: Json; _deleted?: boolean }
    }
  ): Promise<void> {
    const entry = this.registry[collectionKey]
    if (!entry) {
      return
    }
    const row = event.documentData
    const envelope = row?.data
    const deleted = event.operation === 'DELETE' || row?._deleted === true
    if (!row || envelope === undefined) {
      this.scheduleRehydrate(collectionKey)
      return
    }
    // `null` marks a decrypt failure against a still-attached replica (fall
    // back to a re-hydrate); `undefined` marks a replica gone meanwhile (drop).
    const decrypted = await this.whileAttached(async store => {
      try {
        return {
          store,
          payload: await store.decryptEnvelope<{ id: string }>({
            key: collectionKey,
            id: row.id,
            envelope
          })
        }
      } catch {
        return null
      }
    })
    if (decrypted === undefined) {
      return
    }
    if (decrypted === null) {
      this.scheduleRehydrate(collectionKey)
      return
    }
    const { store, payload } = decrypted
    if (deleted) {
      // Only honor a tombstone for the envelope the entity currently lives in.
      // A delete of a DIFFERENT envelope that decrypts to the same logical id
      // is a stale duplicate being cleaned up (a reconciled singleton loser,
      // or the pre-resurrection row of a locally re-created doc) -- dropping
      // the live doc for it would undo the reconciliation/resurrection.
      const mapped = store.envelopeIdFor(collectionKey, payload.id)
      if (mapped !== undefined && mapped !== row.id) {
        return
      }
      store.forgetEnvelope(collectionKey, payload.id)
      entry.drop(payload.id)
    } else {
      store.rememberEnvelope(collectionKey, payload.id, row.id)
      entry.upsert(payload)
    }
  }

  /**
   * Schedules a debounced re-hydrate of one collection's store after a pull.
   * A no-op without an attached replica, and the timer itself is bound to the
   * replica attached now: a detach cancels it, and one that still fires after
   * a swap finds the generation changed and does nothing.
   *
   * @param collectionKey {string}
   * @returns {void}
   */
  scheduleRehydrate(collectionKey: string): void {
    const entry = this.registry[collectionKey]
    if (!entry || !this.#localStore) {
      return
    }
    const generation = this.#generation
    const existing = this.#rehydrateTimers.get(collectionKey)
    if (existing) {
      clearTimeout(existing)
    }
    this.#rehydrateTimers.set(
      collectionKey,
      setTimeout(() => {
        this.#rehydrateTimers.delete(collectionKey)
        if (this.#generation !== generation) {
          return
        }
        void entry.hydrate()
      }, REHYDRATE_DEBOUNCE_MS)
    )
  }
}
