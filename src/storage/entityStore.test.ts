/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { LocalStore } from './localStore.js'
import type { PwsRemoteStore } from './pwsRemoteStore.js'
import { StorageContext } from './storageContext.js'
import {
  activateStorageContext,
  deactivateStorageContext
} from './storageManager.js'
import { createEntityStore } from './entityStore.js'

interface Note {
  id: string
  text: string
}

interface LwwNote extends Note {
  updatedAt: string
  writerId: string
}

const WRITER_ID = 'writer-under-test'

/**
 * Yields one microtask turn so the store's coalesced flush runs.
 */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
}

/**
 * Yields one macrotask turn, enough for a queued persist to reach the fake.
 */
function nextTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/**
 * A promise with its resolver exposed, for gating a fake persist.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

let context: StorageContext

beforeEach(() => {
  // The persisted write verbs stamp from the active context's writer id.
  context = new StorageContext({ registry: {}, writerId: WRITER_ID })
  activateStorageContext(context)
})

afterEach(() => {
  context.detachStore()
  context.detachRemoteStore()
  deactivateStorageContext(context)
})

describe('createEntityStore', () => {
  it('coalesces a pull burst of patches into a single store update', async () => {
    const store = createEntityStore<Note>('notes')
    let notifications = 0
    const seenMaps = new Set<Map<string, Note>>()
    const unsubscribe = store.subscribe(state => {
      notifications += 1
      seenMaps.add(state.byId)
    })

    for (let index = 0; index < 5; index++) {
      store.getState().patch({ id: `note-${index}`, text: `t${index}` })
    }
    // Nothing is applied synchronously; the burst is still buffered.
    expect(store.getState().byId.size).toBe(0)
    expect(notifications).toBe(0)

    await flushMicrotasks()

    expect(notifications).toBe(1)
    expect(seenMaps.size).toBe(1)
    expect(store.getState().byId.size).toBe(5)
    expect(store.getState().byId.get('note-3')).toEqual({
      id: 'note-3',
      text: 't3'
    })
    unsubscribe()
  })

  it('preserves insert/drop ordering within a burst', async () => {
    const store = createEntityStore<Note>('notes')
    // upsert A, upsert B, drop A, upsert C -- the net result keeps B and C and
    // drops A, and a later drop then re-upsert of B keeps B present.
    store.getState().patch({ id: 'a', text: 'a1' })
    store.getState().patch({ id: 'b', text: 'b1' })
    store.getState().drop('a')
    store.getState().patch({ id: 'c', text: 'c1' })
    store.getState().drop('b')
    store.getState().patch({ id: 'b', text: 'b2' })

    await flushMicrotasks()

    const { byId } = store.getState()
    expect(byId.has('a')).toBe(false)
    expect(byId.get('b')).toEqual({ id: 'b', text: 'b2' })
    expect(byId.get('c')).toEqual({ id: 'c', text: 'c1' })
    expect(byId.size).toBe(2)
  })

  it('does not re-render when a burst only drops absent ids', async () => {
    const store = createEntityStore<Note>('notes')
    const before = store.getState().byId
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    store.getState().drop('missing-1')
    store.getState().drop('missing-2')
    await flushMicrotasks()

    expect(notifications).toBe(0)
    expect(store.getState().byId).toBe(before)
    unsubscribe()
  })

  it('discards a stale patch that loses LWW to the held doc', async () => {
    const store = createEntityStore<LwwNote>('notes')
    const newer = {
      id: 'a',
      text: 'newer',
      updatedAt: '2026-07-12T10:00:05Z',
      writerId: 'device-1'
    }
    const older = {
      id: 'a',
      text: 'older',
      updatedAt: '2026-07-12T10:00:00Z',
      writerId: 'device-2'
    }

    // Out-of-order decrypts within one burst: the older payload arrives last.
    store.getState().patch(newer)
    store.getState().patch(older)
    await flushMicrotasks()
    expect(store.getState().byId.get('a')).toEqual(newer)

    // A stale pull echo across bursts must not clobber the held doc either.
    store.getState().patch(older)
    await flushMicrotasks()
    expect(store.getState().byId.get('a')).toEqual(newer)

    // A genuinely newer payload still replaces it.
    const newest = {
      ...newer,
      text: 'newest',
      updatedAt: '2026-07-12T10:00:10Z'
    }
    store.getState().patch(newest)
    await flushMicrotasks()
    expect(store.getState().byId.get('a')).toEqual(newest)
  })

  it('patches docs without LWW fields blindly (last patch wins)', async () => {
    const store = createEntityStore<Note>('notes')
    store.getState().patch({ id: 'a', text: 'first' })
    await flushMicrotasks()
    store.getState().patch({ id: 'a', text: 'second' })
    await flushMicrotasks()
    expect(store.getState().byId.get('a')).toEqual({ id: 'a', text: 'second' })
  })

  it('replaceAll resets the Map and discards a buffered pull burst', async () => {
    const store = createEntityStore<Note>('notes')
    store.getState().patch({ id: 'stale-1', text: 'stale' })
    store.getState().patch({ id: 'stale-2', text: 'stale' })

    // Clear-on-logout while the burst is still buffered: the reset wins and
    // the pending flush must not resurrect the stale docs.
    store.getState().replaceAll([])
    await flushMicrotasks()

    expect(store.getState().byId.size).toBe(0)

    store.getState().replaceAll([{ id: 'fresh', text: 'fresh' }])
    expect(store.getState().byId.get('fresh')).toEqual({
      id: 'fresh',
      text: 'fresh'
    })
  })

  it('applies interactive local writes immediately (unbatched)', async () => {
    const inserted: Array<[string, LwwNote]> = []
    const store = createEntityStore<LwwNote>('notes')
    context.attachStore({
      insertEntity: async (key: string, doc: LwwNote) => {
        inserted.push([key, doc])
      }
    } as unknown as LocalStore)

    await store.getState().insert({ id: 'local-1', text: 'hi' })

    // The insert's `set` fired before the persist was awaited -- no microtask
    // flush needed, and the Map holds exactly what was persisted.
    const held = store.getState().byId.get('local-1')
    expect(held).toMatchObject({ id: 'local-1', text: 'hi' })
    expect(inserted).toEqual([['notes', held]])
  })

  it('commits a write before its persist settles, so read-modify-writes compose', async () => {
    const store = createEntityStore<LwwNote>('notes')
    const started: string[] = []
    const gates = new Map<string, Deferred<void>>()
    context.attachStore({
      upsertEntity: async (_key: string, doc: LwwNote) => {
        started.push(doc.text)
        const gate = deferred<void>()
        gates.set(doc.text, gate)
        await gate.promise
      }
    } as unknown as LocalStore)

    const first = store.getState().upsert({ id: 'n', text: 'one' })
    // Not awaited: the Map already shows the first write.
    expect(store.getState().byId.get('n')).toMatchObject({ text: 'one' })
    const held = store.getState().byId.get('n')!
    const second = store
      .getState()
      .upsert({ ...held, text: `${held.text}+two` })
    expect(store.getState().byId.get('n')).toMatchObject({ text: 'one+two' })

    // Persists to one id run in call order: the second does not start until
    // the first has settled.
    await nextTick()
    expect(started).toEqual(['one'])
    gates.get('one')!.resolve()
    await first
    await nextTick()
    expect(started).toEqual(['one', 'one+two'])
    gates.get('one+two')!.resolve()
    await second
    expect(store.getState().byId.get('n')).toMatchObject({ text: 'one+two' })
  })

  it('puts the last persisted doc back when a write fails', async () => {
    const store = createEntityStore<LwwNote>('notes')
    // The fake rejects by content, so failing and succeeding writes can be
    // queued together.
    const persist = async (_key: string, doc: LwwNote) => {
      if (doc.text.startsWith('lost')) {
        throw new Error('persist failed')
      }
    }
    context.attachStore({
      insertEntity: persist,
      upsertEntity: persist
    } as unknown as LocalStore)

    await store.getState().upsert({ id: 'n', text: 'kept' })
    await expect(
      store.getState().upsert({ id: 'n', text: 'lost' })
    ).rejects.toThrow('persist failed')
    expect(store.getState().byId.get('n')).toMatchObject({ text: 'kept' })

    // A new id that fails to persist leaves no entry behind.
    await expect(
      store.getState().insert({ id: 'ghost', text: 'lost too' })
    ).rejects.toThrow('persist failed')
    expect(store.getState().byId.has('ghost')).toBe(false)

    // A later write queued on top of the failing one stands.
    const failing = store.getState().upsert({ id: 'n', text: 'lost again' })
    const later = store.getState().upsert({ id: 'n', text: 'newer' })
    await expect(failing).rejects.toThrow('persist failed')
    await later
    expect(store.getState().byId.get('n')).toMatchObject({ text: 'newer' })

    // Two failures in a row fall back to the last persisted doc, not to the
    // first failure's never-persisted one.
    const failingA = store.getState().upsert({ id: 'n', text: 'lost a' })
    const failingB = store.getState().upsert({ id: 'n', text: 'lost b' })
    await expect(failingA).rejects.toThrow('persist failed')
    await expect(failingB).rejects.toThrow('persist failed')
    expect(store.getState().byId.get('n')).toMatchObject({ text: 'newer' })
  })

  it('keeps showing a write in flight across a hydrate', async () => {
    const store = createEntityStore<LwwNote>('notes')
    const gate = deferred<void>()
    context.attachStore({
      upsertEntity: async () => {
        await gate.promise
      },
      // The listing predates both writes: one id it does not know, one it
      // holds at its pre-write value.
      listEntities: async () => [
        { id: 'old', text: 'stale', updatedAt: 'then', writerId: 'w' }
      ]
    } as unknown as LocalStore)

    const fresh = store.getState().upsert({ id: 'fresh', text: 'landed' })
    const old = store.getState().upsert({ id: 'old', text: 'edited' })
    await store.getState().hydrate()
    expect(store.getState().byId.get('fresh')).toMatchObject({ text: 'landed' })
    expect(store.getState().byId.get('old')).toMatchObject({ text: 'edited' })

    gate.resolve()
    await Promise.all([fresh, old])
    // Once the queue has drained a hydrate reads the replica as it is.
    await store.getState().hydrate()
    expect(store.getState().byId.has('fresh')).toBe(false)
    expect(store.getState().byId.get('old')).toMatchObject({ text: 'stale' })
  })

  it('drops a doc once its tombstone persists, and keeps it when that fails', async () => {
    const store = createEntityStore<LwwNote>('notes')
    let fail = true
    context.attachStore({
      upsertEntity: async () => {},
      deleteEntity: async () => {
        if (fail) {
          throw new Error('delete failed')
        }
      }
    } as unknown as LocalStore)

    await store.getState().upsert({ id: 'n', text: 'stays' })
    await expect(store.getState().remove('n')).rejects.toThrow('delete failed')
    expect(store.getState().byId.get('n')).toMatchObject({ text: 'stays' })

    fail = false
    await store.getState().remove('n')
    expect(store.getState().byId.has('n')).toBe(false)
  })

  it('stamps fresh LWW fields on insert, update and upsert', async () => {
    const persisted: LwwNote[] = []
    const store = createEntityStore<LwwNote>('notes')
    const persist = async (_key: string, doc: LwwNote) => {
      persisted.push(doc)
    }
    context.attachStore({
      insertEntity: persist,
      updateEntity: persist,
      upsertEntity: persist
    } as unknown as LocalStore)

    const before = Date.now()
    await store.getState().insert({ id: 'a', text: 'inserted' })
    await store.getState().update({ id: 'a', text: 'updated' })
    await store.getState().upsert({ id: 'a', text: 'upserted' })

    expect(persisted).toHaveLength(3)
    for (const doc of persisted) {
      expect(doc.writerId).toBe(WRITER_ID)
      const stampedAt = Date.parse(doc.updatedAt)
      expect(Number.isNaN(stampedAt)).toBe(false)
      expect(stampedAt).toBeGreaterThanOrEqual(before)
      expect(doc.updatedAt).toBe(new Date(stampedAt).toISOString())
    }
    // The optimistic Map entry is the persisted object, stamps included.
    expect(store.getState().byId.get('a')).toEqual(persisted[2])
  })

  it('overwrites caller-supplied LWW fields with a fresh stamp', async () => {
    const persisted: LwwNote[] = []
    const store = createEntityStore<LwwNote>('notes')
    context.attachStore({
      insertEntity: async (_key: string, doc: LwwNote) => {
        persisted.push(doc)
      }
    } as unknown as LocalStore)

    await store.getState().insert({
      id: 'a',
      text: 'stale stamps',
      updatedAt: '1999-01-01T00:00:00.000Z',
      writerId: 'someone-else'
    })

    expect(persisted[0]!.writerId).toBe(WRITER_ID)
    expect(persisted[0]!.updatedAt).not.toBe('1999-01-01T00:00:00.000Z')
  })

  it('query routes key to PWS id and maps the page to payloads', async () => {
    const store = createEntityStore<Note>('notes')
    context.attachStore({
      collectionConfig: (key: string) => ({
        key,
        id: 'shared-notes',
        visibility: 'public',
        indexes: ['text']
      })
    } as unknown as LocalStore)
    const queries: unknown[] = []
    context.attachRemoteStore({
      queryCollectionByEquality: async (query: unknown) => {
        queries.push(query)
        return {
          documents: [
            { id: 'a', data: { id: 'a', text: 'hi' } },
            // A blob resource carries no JSON content; it is omitted from docs.
            { id: 'blob', custom: { name: 'pic' } }
          ],
          hasMore: true,
          cursor: 'more'
        }
      }
    } as unknown as PwsRemoteStore)

    const page = await store
      .getState()
      .query({ equals: { text: 'hi' }, limit: 10 })

    expect(queries).toEqual([
      { collectionId: 'shared-notes', equals: { text: 'hi' }, limit: 10 }
    ])
    expect(page).toEqual({
      docs: [{ id: 'a', text: 'hi' }],
      hasMore: true,
      cursor: 'more'
    })
    // A read verb: the Map is untouched.
    expect(store.getState().byId.size).toBe(0)
  })

  it('query throws while no wallet-connected session holds a remote store', async () => {
    const store = createEntityStore<Note>('notes')
    context.attachStore({
      collectionConfig: () => ({ id: 'shared-notes' })
    } as unknown as LocalStore)

    await expect(
      store.getState().query({ equals: { text: 'hi' } })
    ).rejects.toThrow(/connect a wallet session/)
  })
})
