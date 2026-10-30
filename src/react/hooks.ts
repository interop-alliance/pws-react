/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The React hooks over the session store: thin selectors that read the bound
 * store from context (the logic lives in the auth store and the sync-status
 * store). Components consume these rather than reaching for a module singleton.
 */
import { useContext } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { PwsSessionContext } from './PwsSessionProvider.js'
import type { PwsAuthStore } from '../session/authStore.js'
import type { LocalWipeReport } from '../session/localWipe.js'
import type { SharedCollectionReader } from '../storage/sharedCollectionReader.js'
import {
  deriveSyncRollup,
  type SyncRollup
} from '../storage/syncStatusStore.js'

/**
 * The bound auth store from the nearest {@link PwsSessionProvider}. Throws a
 * helpful error when used outside a provider.
 *
 * @returns {PwsAuthStore}
 */
export function useAuthStore(): PwsAuthStore {
  const store = useContext(PwsSessionContext)
  if (!store) {
    throw new Error(
      'useAuthStore must be used within a <PwsSessionProvider>. Wrap your app ' +
        'in <PwsSessionProvider config={...} registry={...}>.'
    )
  }
  return store
}

/**
 * The current session state (status/phase/expiry/reconnect flags). Re-renders
 * only when one of the selected fields changes. `authenticating` and
 * `accessExpired` are conveniences DERIVED here (`phase !== null` and
 * `status === 'reconnect'`); the store keeps only `phase` and `status`.
 *
 * @returns {object}
 */
export function useSession(): {
  status: ReturnType<PwsAuthStore['getState']>['status']
  onboarding: ReturnType<PwsAuthStore['getState']>['onboarding']
  writerId: string
  authenticating: boolean
  phase: ReturnType<PwsAuthStore['getState']>['phase']
  error: string | null
  controllerDid: string | null
  expires: string | null
  accessExpired: boolean
  reconnecting: boolean
} {
  const store = useAuthStore()
  return useStore(
    store,
    useShallow(state => ({
      status: state.status,
      onboarding: state.onboarding,
      writerId: state.writerId,
      authenticating: state.phase !== null,
      phase: state.phase,
      error: state.error,
      controllerDid: state.controllerDid,
      expires: state.expires,
      accessExpired: state.status === 'reconnect',
      reconnecting: state.reconnecting
    }))
  )
}

/**
 * The login action plus the state the login page renders. `authenticating` is
 * the in-flight flag, derived from `phase` (the `status` stays `local` during
 * login); `status` is exposed so a login page can redirect once it reads
 * `connected`. `login`
 * accepts `{ adopt }` -- `'merge'` (default) migrates data created in `local`
 * into the connected replica, `'leave'` sets it aside untouched.
 *
 * @returns {object}
 */
export function useLogin(): {
  login: (options?: {
    adopt?: 'merge' | 'leave'
  }) => Promise<{ firstRun: boolean } | null>
  authenticating: boolean
  status: ReturnType<PwsAuthStore['getState']>['status']
  phase: ReturnType<PwsAuthStore['getState']>['phase']
  error: string | null
} {
  const store = useAuthStore()
  const login = useStore(store, state => state.login)
  const { authenticating, status, phase, error } = useStore(
    store,
    useShallow(state => ({
      authenticating: state.phase !== null,
      status: state.status,
      phase: state.phase,
      error: state.error
    }))
  )
  return { login, authenticating, status, phase, error }
}

/**
 * The logout action; accepts `{ wipe }` to delete the connected replica rather
 * than keep it on the device.
 *
 * @returns {(options?: { wipe?: boolean }) => Promise<void>}
 */
export function useLogout(): (options?: { wipe?: boolean }) => Promise<void> {
  const store = useAuthStore()
  return useStore(store, state => state.logout)
}

/**
 * The clear-data action: deletes every database this app wrote on the browser
 * (both replicas and both seed stores), drops the persisted writer id, and
 * mints a fresh anonymous seed/DID + replica (the "Clear data" affordance).
 * Resolves with the wipe report, so a caller can surface a deletion the engine
 * could not confirm rather than claim a clean wipe.
 *
 * @returns {() => Promise<LocalWipeReport>}
 */
export function useClearData(): () => Promise<LocalWipeReport> {
  const store = useAuthStore()
  return useStore(store, state => state.clearLocalData)
}

/**
 * Whether the anonymous `local` replica currently holds any documents -- the
 * check a login affordance runs at decision time (e.g. on the login button
 * click) to choose between opening the adoption dialog and calling `login()`
 * directly. Returns the async check, not a subscription.
 *
 * @returns {() => Promise<boolean>}
 */
export function useHasLocalData(): () => Promise<boolean> {
  const store = useAuthStore()
  return useStore(store, state => state.hasLocalData)
}

/**
 * The read-only reader over one wallet-owned collection the wallet shared with
 * this app, looked up by its `sharedCollections` config `key`. Returns
 * `undefined` until replication has bootstrapped, and stays `undefined` when the
 * wallet declined the share (or removed it), so a component must handle its
 * absence rather than assume the grant.
 *
 * @param key {string}   the shared-collection config key
 * @returns {SharedCollectionReader | undefined}
 */
export function useSharedCollection(
  key: string
): SharedCollectionReader | undefined {
  const store = useAuthStore()
  return useStore(store, state => state.sharedCollections[key])
}

/**
 * The expired-access reconnect: the banner flags plus the reconnect action.
 * `accessExpired` is derived from the session status (`status === 'reconnect'`),
 * which the store keeps as its single source of truth.
 *
 * @returns {object}
 */
export function useReconnect(): {
  accessExpired: boolean
  reconnecting: boolean
  reconnect: () => Promise<void>
} {
  const store = useAuthStore()
  const reconnect = useStore(store, state => state.reconnect)
  const { accessExpired, reconnecting } = useStore(
    store,
    useShallow(state => ({
      accessExpired: state.status === 'reconnect',
      reconnecting: state.reconnecting
    }))
  )
  return { accessExpired, reconnecting, reconnect }
}

/**
 * The aggregate replication rollup: no sync running, or error > syncing >
 * synced. Re-exported from the sync-status store, where the derivation lives.
 */
export type { SyncRollup }

/**
 * The aggregate sync status over the per-collection replication statuses (the
 * session's sync-status store keys them by the registry's logical collection
 * key). A thin subscription over that store, reached through the provider's
 * storage context: it reads the collection statuses and defers the
 * offline / error > syncing > synced precedence to {@link deriveSyncRollup}.
 *
 * @returns {{ state: SyncRollup, label: string, title: string }}
 */
export function useSyncStatus(): {
  state: SyncRollup
  label: string
  title: string
} {
  // The context is set once at store creation and never replaced, so reading
  // it outside a selector subscribes to nothing it would need to.
  const { syncStatus } = useAuthStore().getState().storageContext
  const values = useStore(
    syncStatus,
    useShallow(state => Object.values(state.statuses))
  )
  return deriveSyncRollup(values)
}
