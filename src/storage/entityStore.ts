/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * A generic zustand store over one localStore collection. Holds the decrypted
 * payloads as a `Map<uuid, Doc>` and exposes the CRUD verbs that (1) persist
 * through the encrypted {@link LocalStore} and (2) patch the in-memory Map. UI
 * reads through selectors and applies the app's own comparators/filters; this
 * layer stays domain-agnostic so every entity shares it.
 *
 * The persisted write verbs (`insert` / `update` / `upsert`) stamp the
 * last-write-wins fields themselves through {@link stampLww}, so an app can
 * never degrade conflict resolution by forgetting to.
 *
 * Reactivity note: local writes patch the Map optimistically after the localStore
 * write resolves. Pulled remote changes are applied per-doc by the sync layer
 * through `patch` / `drop` (no whole-collection re-hydrate), keeping multi-device
 * edits and tombstones live without re-hydrate storms. Those per-doc remote
 * patches are coalesced: a pull burst is buffered and flushed on a microtask as a
 * single Map clone + single `set`, so an initial device sync of N docs is one
 * re-render rather than N (and O(N) Map copies rather than O(N^2)). Interactive
 * local writes stay immediate so a single edit is snappy.
 */
import { create, type UseBoundStore, type StoreApi } from 'zustand'
// The verbs resolve the ACTIVE session's context on every call rather than
// capturing one: an entity store is created at module level, before any
// session exists, and outlives every session it serves.
import {
  awaitStore,
  requireStore,
  requireRemoteStore,
  stampLww
} from './storageManager.js'
import { remotePayloadWins } from '@interop/social-core'
import { lwwFields } from '@interop/was-sync'

/**
 * What the persisted write verbs accept: the payload WITHOUT its last-write-wins
 * fields, which the verb stamps itself. The fields stay optional rather than
 * forbidden so a caller that still supplies them keeps compiling -- their values
 * are overwritten.
 */
type WritablePayload<T> = Omit<T, 'updatedAt' | 'writerId'> & {
  updatedAt?: string
  writerId?: string
}

export interface EntityStore<T extends { id: string }> {
  /**
   * Decrypted payloads keyed by logical uuid.
   */
  byId: Map<string, T>
  /**
   * Decrypt every live row of the collection into the Map.
   */
  hydrate: () => Promise<void>
  /**
   * Encrypt+insert a new doc, then add it to the Map. Fresh `updatedAt` /
   * `writerId` LWW fields are stamped by this verb, overwriting any the caller
   * supplied; the Map holds exactly what was persisted.
   */
  insert: (doc: WritablePayload<T>) => Promise<void>
  /**
   * Re-encrypt a doc in place (sequence+1), then replace it in the Map. Fresh
   * LWW fields are stamped by this verb, as for {@link EntityStore.insert}.
   */
  update: (doc: WritablePayload<T>) => Promise<void>
  /**
   * Encrypt+insert the doc when its uuid is new, otherwise re-encrypt it in
   * place (insert-or-update routed by the hydration index), then set it in the
   * Map. The verb for callers that do not track an insert-vs-update flag of
   * their own (e.g. a singleton document). Fresh LWW fields are stamped by this
   * verb, as for {@link EntityStore.insert}.
   */
  upsert: (doc: WritablePayload<T>) => Promise<void>
  /**
   * Tombstone a doc, then drop it from the Map.
   */
  remove: (uuid: string) => Promise<void>
  /**
   * Replace the whole Map WITHOUT persisting. This is the app-facing bulk
   * reset verb: the registry pattern wires `StoreRegistryEntry.clear` to
   * `replaceAll([])` on logout (see the README). Discards any buffered pull
   * burst so it cannot resurrect docs past the reset.
   */
  replaceAll: (docs: T[]) => void
  /**
   * Upsert one already-decrypted doc into the Map WITHOUT persisting (the sync
   * stream owns the persisted row already). Used for per-doc reactive patching
   * of pulled/conflict-resolved remote changes; coalesced into one store update
   * per pull burst (see the reactivity note above). When both the incoming and
   * the held doc carry the LWW fields (`updatedAt` + `writerId`), a stale
   * incoming doc is discarded rather than clobbering the newer held one.
   */
  patch: (doc: T) => void
  /**
   * Drop one doc from the Map WITHOUT persisting (remote tombstone patch);
   * coalesced with `patch` into one store update per pull burst.
   */
  drop: (uuid: string) => void
  /**
   * Runs one server-side equality query against this collection and returns
   * the matching payloads WITHOUT touching the Map (a read verb, not a sync
   * path; the replica already holds this device's rows). Multiple `equals`
   * attributes AND together; values are string equality only, and every
   * attribute must appear in the collection config's declared `indexes`.
   * Requires a wallet-connected session.
   *
   * Works on either visibility. A public (plaintext) collection is queried
   * with the server-side `filter[attr]=value` form; a private (encrypted) one
   * with the blinded-index profile, which needs the collection to have been
   * provisioned with a blinded-index key. On a private collection the standing
   * limitation is that documents written through the local-first sync path do
   * not yet carry blinded index entries, so a query finds only documents
   * written through an index-aware cipher; they become findable once
   * rewritten that way.
   *
   * Pass the returned `cursor` back in to fetch the next page while
   * `hasMore` is true.
   */
  query: (query: {
    equals: Record<string, string>
    limit?: number
    cursor?: string
  }) => Promise<{ docs: T[]; hasMore: boolean; cursor?: string }>
}

/**
 * Builds a zustand hook for the collection whose localStore key is `collectionKey`.
 *
 * @param collectionKey {string}
 * @returns {UseBoundStore<StoreApi<EntityStore<T>>>}
 */
export function createEntityStore<T extends { id: string }>(
  collectionKey: string
): UseBoundStore<StoreApi<EntityStore<T>>> {
  return create<EntityStore<T>>(set => {
    // The pull path (`patch` / `drop`) can fire once per remote change; an
    // initial device sync of N docs would otherwise clone the byId Map N times
    // and push N separate store updates (O(N^2) copies + N re-renders). Buffer
    // the per-doc remote patches and flush the whole burst in ONE Map clone +
    // ONE `set` on a microtask, preserving per-event insert/drop ordering.
    const pending: Array<
      { type: 'upsert'; doc: T } | { type: 'drop'; uuid: string }
    > = []
    let flushScheduled = false

    /**
     * Applies the buffered pull burst in one Map clone + one `set`.
     */
    function flushPending(): void {
      flushScheduled = false
      if (pending.length === 0) {
        return
      }
      const ops = pending.splice(0)
      set(state => {
        let changed = false
        const byId = new Map(state.byId)
        for (const op of ops) {
          if (op.type === 'upsert') {
            // LWW guard: `patch` events decrypt asynchronously, so two events
            // for the same doc can arrive out of order, and a pull echo can
            // trail a newer optimistic local write. When both payloads carry
            // the LWW fields, a stale incoming doc must not clobber the newer
            // held one.
            const held = byId.get(op.doc.id)
            const incoming = lwwFields(op.doc)
            const current = held === undefined ? null : lwwFields(held)
            if (incoming && current && !remotePayloadWins(incoming, current)) {
              continue
            }
            byId.set(op.doc.id, op.doc)
            changed = true
          } else if (byId.delete(op.uuid)) {
            changed = true
          }
        }
        // A burst of stray drops (ids not present) leaves the Map untouched;
        // keep the old reference so no needless re-render fires.
        return changed ? { byId } : state
      })
    }

    /**
     * Schedules a single microtask flush per pull burst.
     */
    function schedulePendingFlush(): void {
      if (!flushScheduled) {
        flushScheduled = true
        queueMicrotask(flushPending)
      }
    }

    /**
     * Sets one doc in the Map, immediately (the optimistic patch behind a local
     * insert / update / upsert -- an interactive write stays snappy rather than
     * riding the pull-burst coalescing above).
     */
    function commitDoc(doc: T): void {
      set(state => {
        const byId = new Map(state.byId)
        byId.set(doc.id, doc)
        return { byId }
      })
    }

    /**
     * Drops one doc from the Map, immediately (the same optimistic patch behind
     * a local `remove`).
     */
    function dropDoc(uuid: string): void {
      set(state => {
        const byId = new Map(state.byId)
        byId.delete(uuid)
        return { byId }
      })
    }

    return {
      byId: new Map<string, T>(),
      hydrate: async () => {
        const docs = await requireStore().listEntities<T>(collectionKey)
        set({ byId: new Map(docs.map(d => [d.id, d])) })
      },
      insert: async doc => {
        // Stamp once, then persist and commit the SAME object, so the
        // optimistic Map entry is byte-for-byte what the replica holds.
        const local = await awaitStore()
        const stamped = stampLww(doc) as unknown as T
        await local.insertEntity(collectionKey, stamped)
        commitDoc(stamped)
      },
      update: async doc => {
        const local = await awaitStore()
        const stamped = stampLww(doc) as unknown as T
        await local.updateEntity(collectionKey, stamped)
        commitDoc(stamped)
      },
      upsert: async doc => {
        const local = await awaitStore()
        const stamped = stampLww(doc) as unknown as T
        await local.upsertEntity(collectionKey, stamped)
        commitDoc(stamped)
      },
      remove: async uuid => {
        const local = await awaitStore()
        await local.deleteEntity(collectionKey, uuid)
        dropDoc(uuid)
      },
      replaceAll: docs => {
        pending.length = 0
        set({ byId: new Map(docs.map(doc => [doc.id, doc])) })
      },
      patch: doc => {
        pending.push({ type: 'upsert', doc })
        schedulePendingFlush()
      },
      drop: uuid => {
        pending.push({ type: 'drop', uuid })
        schedulePendingFlush()
      },
      query: async ({ equals, limit, cursor }) => {
        // Route the logical key to its WAS collection id through the local
        // registry; the remote store validates visibility + declared indexes
        // and fails closed before any network round trip.
        const { id } = requireStore().collectionConfig(collectionKey)
        const page = await requireRemoteStore().queryCollectionByEquality({
          collectionId: id,
          equals,
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor })
        })
        // `data` is the stored JSON content -- for a public (plaintext)
        // collection that IS the payload, and for a private one it is the
        // decrypted envelope content, which is the payload too; a blob
        // resource carries none and is omitted.
        const docs = page.documents
          .filter(document => document.data !== undefined)
          .map(document => document.data as T)
        return {
          docs,
          hasMore: page.hasMore,
          ...(page.cursor !== undefined && { cursor: page.cursor })
        }
      }
    }
  })
}
