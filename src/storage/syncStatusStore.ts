/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The per-collection replication status store, mirroring the PWS per-replica
 * sync-status vocabulary, keyed by the registry's logical collection key. One
 * is created per {@link StorageContext} (so per session provider, never
 * process-wide): the sync controller writes to it off the RxDB replication
 * `active$` / `error$` streams, and `useSyncStatus` reads it through the
 * provider. In-memory only, like the session -- reset on logout.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { SyncStatus } from '@interop/pws-client/sync'

/**
 * A single collection's replication status, re-exported from the client's
 * closed vocabulary (`idle` -- configured but no cycle has run yet; `syncing`
 * -- a pull/push cycle is in flight; `synced` -- last cycle completed without
 * error; `error` -- last cycle failed and RxDB is backing off). The client owns
 * the type so the replication driver and the wallets' own sync engine report
 * the same four strings.
 */
export type { SyncStatus }

interface SyncStatusState {
  /**
   * Keyed by the registry's LOGICAL collection key (`PwsCollectionConfig.key`,
   * e.g. `actionItems`), not the PWS wire id. Two registry entries may share one
   * PWS id, so the id is not a unique status key; every other layer (the entity
   * stores, the rehydrate mechanism, the local replica's RxDB collections)
   * routes on the logical key too.
   */
  statuses: Record<string, SyncStatus>
  setStatus: (collectionKey: string, status: SyncStatus) => void
  reset: () => void
}

export type SyncStatusStore = StoreApi<SyncStatusState>

/**
 * Creates one session's sync status store (a vanilla zustand store; subscribe
 * to it from React with zustand's `useStore`).
 *
 * @returns {SyncStatusStore}
 */
export function createSyncStatusStore(): SyncStatusStore {
  return createStore<SyncStatusState>()(set => ({
    statuses: {},
    setStatus: (collectionKey, status) =>
      set(state => ({
        statuses: { ...state.statuses, [collectionKey]: status }
      })),
    reset: () => set({ statuses: {} })
  }))
}

/**
 * The aggregate replication status derived from the per-collection statuses:
 * `offline` when no replication is running (local-only), otherwise rolled up as
 * error > syncing > synced.
 */
export type SyncRollup = 'offline' | 'error' | 'syncing' | 'synced'

/**
 * Rolls the per-collection replication statuses up to a single aggregate plus
 * its display copy. With no collections registered it reports `offline`
 * (local-only, no sync running); otherwise it applies the
 * error > syncing > synced precedence (`idle` counts as syncing -- a collection
 * configured but not yet cycled). Kept beside the status vocabulary so the
 * precedence lives with the store rather than the view; `useSyncStatus` is a
 * thin subscription over it.
 *
 * @param statuses {SyncStatus[]}   the per-collection statuses (store values)
 * @returns {{ state: SyncRollup, label: string, title: string }}
 */
export function deriveSyncRollup(statuses: SyncStatus[]): {
  state: SyncRollup
  label: string
  title: string
} {
  if (statuses.length === 0) {
    return {
      state: 'offline',
      label: 'Local only',
      title: 'Local-only mode -- your data stays on this device'
    }
  }
  if (statuses.includes('error')) {
    return {
      state: 'error',
      label: 'Sync error',
      title: 'Connected to storage -- a collection failed to sync; retrying'
    }
  }
  if (statuses.includes('syncing') || statuses.includes('idle')) {
    return {
      state: 'syncing',
      label: 'Syncing',
      title: 'Connected to storage -- replicating your collections'
    }
  }
  return {
    state: 'synced',
    label: 'Synced',
    title: 'Connected to storage -- all collections replicated'
  }
}
