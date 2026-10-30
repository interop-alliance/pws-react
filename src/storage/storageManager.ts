/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The storage manager: the one remaining process-wide pointer, to the ACTIVE
 * {@link StorageContext}, plus the app-facing facades over it. Entity stores
 * are created at module level, before any session exists, so their verbs
 * cannot hold a context of their own; they reach the live session through
 * {@link requireStore} / {@link requireRemoteStore} / {@link stampLww} here,
 * which resolve to whichever context is active. Keeping the facade free of
 * store imports (no cycle) also lets the session store own the init/hydrate
 * ordering.
 *
 * Activation is deliberate about the two-providers case: a context with a
 * replica attached is live, and a live context is never replaced -- a second
 * session attaching a replica of its own throws instead of silently taking the
 * facades over. A context without a replica (created but not booted, or torn
 * down) is inert and is replaced without complaint, which is what a React
 * dev-mode double `useState` initializer or a test's sequence of stores needs.
 */
import type { LwwFields } from '@interop/pws-sync'
import type { LocalStore } from './localStore.js'
import type { StorageContext } from './storageContext.js'
import type { PwsRemoteStore } from './pwsRemoteStore.js'

let active: StorageContext | null = null

/**
 * Makes `context` the active one (called by the session store at creation, so
 * the facades resolve before any replica opens, again right before it opens a
 * replica, and by {@link StorageContext.attachStore}). Idempotent for the
 * context already active; throws while a DIFFERENT context still has a replica
 * attached.
 *
 * @param context {StorageContext}
 * @returns {void}
 */
export function activateStorageContext(context: StorageContext): void {
  if (active && active !== context && active.hasStore()) {
    throw new Error(
      'Another storage context still has a replica attached; ' +
        'one process hosts one live session (one provider) at a time.'
    )
  }
  active = context
}

/**
 * Releases the active pointer if `context` holds it (called by
 * `StorageContext.detachStore`, so every path that detaches a replica --
 * `destroy`, logout, clear-data, the connected activation's fallback to
 * `local` -- releases it and re-claims on re-attach); a no-op for any other
 * context. Until the next claim the facades throw rather than resolve a
 * retired session.
 *
 * @param context {StorageContext}
 * @returns {void}
 */
export function deactivateStorageContext(context: StorageContext): void {
  if (active === context) {
    active = null
  }
}

/**
 * Whether a storage context is active.
 *
 * @returns {boolean}
 */
export function hasStorageContext(): boolean {
  return active !== null
}

/**
 * The active storage context, or throws if no session store has been created.
 *
 * @returns {StorageContext}
 */
export function requireStorageContext(): StorageContext {
  if (!active) {
    throw new Error(
      'No storage context is active; create the session store first.'
    )
  }
  return active
}

/**
 * The active session's opened replica, or throws if none is open.
 *
 * @returns {LocalStore}
 */
export function requireStore(): LocalStore {
  return requireStorageContext().requireStore()
}

/**
 * The active session's opened replica, waiting out a replica swap in progress
 * (the connect transition) first. The app-driven write verbs resolve the
 * replica through this, so a write issued while the anonymous replica is
 * being traded for the connected one lands in the connected one instead of
 * rejecting.
 *
 * @returns {Promise<LocalStore>}
 */
export async function awaitStore(): Promise<LocalStore> {
  return requireStorageContext().awaitStore()
}

/**
 * Whether the active session has a replica open.
 *
 * @returns {boolean}
 */
export function hasStore(): boolean {
  return active?.hasStore() ?? false
}

/**
 * The active session's remote store, or throws while no wallet-connected
 * session is active.
 *
 * @returns {PwsRemoteStore}
 */
export function requireRemoteStore(): PwsRemoteStore {
  return requireStorageContext().requireRemoteStore()
}

/**
 * Whether the active session has a remote store available.
 *
 * @returns {boolean}
 */
export function hasRemoteStore(): boolean {
  return active?.hasRemoteStore() ?? false
}

/**
 * The active session's writer id, or throws if no session store exists yet.
 * Deliberately never falls back to `getWriterId`: that would resolve under the
 * DEFAULT key prefix, so an app with a custom `storageKeyPrefix` would silently
 * stamp a second writer id.
 *
 * @returns {string}
 */
export function requireWriterId(): string {
  return requireStorageContext().writerId
}

/**
 * Stamps a payload with fresh last-write-wins fields under the active session
 * (see {@link StorageContext.stampLww}); the entity-store write verbs call it
 * on every write, and an app writing through `LocalStore` directly does too.
 *
 * @param payload {object}
 * @returns {object}   the payload with the LWW fields set
 */
export function stampLww<T extends { id: string }>(payload: T): T & LwwFields {
  return requireStorageContext().stampLww(payload)
}
