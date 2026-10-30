/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for {@link StorageContext}: the hydrate/patch/schedule mechanism
 * that used to be the module-level `rehydrate.ts` functions, plus the
 * attach/detach/activation lifecycle that replaced the old process-wide
 * holders (`setLocalStore` / `clearLocalStore`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Json } from '@interop/pws-sync'
import type { StoreRegistry } from '../config.js'
import type { LocalStore } from './localStore.js'
import { StorageContext } from './storageContext.js'
import {
  activateStorageContext,
  deactivateStorageContext,
  requireStorageContext
} from './storageManager.js'

// A fake LocalStore: `decryptEnvelope` unwraps `{ jwe: payload }` (mirroring the
// lww handler test's fake cipher); the envelope index calls just record.
function makeFakeStore({
  failDecrypt = false,
  index = {} as Record<string, string>
} = {}): {
  store: LocalStore
  remembered: Array<[string, string, string]>
  forgotten: Array<[string, string]>
} {
  const remembered: Array<[string, string, string]> = []
  const forgotten: Array<[string, string]> = []
  const store = {
    decryptEnvelope: async ({ envelope }: { envelope: Json }) => {
      if (failDecrypt) {
        throw new Error('decrypt failed')
      }
      return (envelope as { jwe: Json }).jwe
    },
    rememberEnvelope: (key: string, uuid: string, envelopeId: string) => {
      remembered.push([key, uuid, envelopeId])
    },
    forgetEnvelope: (key: string, uuid: string) => {
      forgotten.push([key, uuid])
    },
    envelopeIdFor: (_key: string, uuid: string) => index[uuid]
  } as unknown as LocalStore
  return { store, remembered, forgotten }
}

// A fake LocalStore whose `decryptEnvelope` only settles once the returned
// `release` is called: it lets a test detach (or swap) the attached store
// while a patch's decrypt is still in flight.
function makeGatedStore(): {
  store: LocalStore
  remembered: Array<[string, string, string]>
  release: () => void
} {
  const remembered: Array<[string, string, string]> = []
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const store = {
    decryptEnvelope: async ({ envelope }: { envelope: Json }) => {
      await gate
      return (envelope as { jwe: Json }).jwe
    },
    rememberEnvelope: (key: string, uuid: string, envelopeId: string) => {
      remembered.push([key, uuid, envelopeId])
    },
    forgetEnvelope: () => {},
    envelopeIdFor: () => undefined
  } as unknown as LocalStore
  return { store, remembered, release: () => release() }
}

// A fake registry entry that records what the mechanism drives.
function makeRegistry(): {
  registry: StoreRegistry
  calls: {
    hydrate: number
    upsert: Array<{ id: string }>
    drop: string[]
    clear: number
  }
} {
  const calls = {
    hydrate: 0,
    upsert: [] as Array<{ id: string }>,
    drop: [] as string[],
    clear: 0
  }
  const registry: StoreRegistry = {
    notes: {
      hydrate: async () => {
        calls.hydrate += 1
      },
      upsert: doc => {
        calls.upsert.push(doc)
      },
      drop: uuid => {
        calls.drop.push(uuid)
      },
      clear: () => {
        calls.clear += 1
      }
    }
  }
  return { registry, calls }
}

function envelope(payload: { id: string }): Json {
  return { jwe: payload } as unknown as Json
}

// Every context this test file creates, so `afterEach` can detach and
// deactivate it regardless of which one ended up active -- `attachStore`
// throws while a DIFFERENT context still has a store attached, so leaking one
// across tests would break every later `attachStore` call.
let contexts: StorageContext[] = []

function makeContext(registry: StoreRegistry = {}): StorageContext {
  const context = new StorageContext({ registry, writerId: 'test-writer' })
  contexts.push(context)
  return context
}

afterEach(() => {
  for (const context of contexts) {
    context.detachStore()
    deactivateStorageContext(context)
  }
  contexts = []
})

describe('StorageContext', () => {
  it('hydrateAll drives every registry entry', async () => {
    const { registry, calls } = makeRegistry()
    const context = makeContext(registry)
    await context.hydrateAll()
    expect(calls.hydrate).toBe(1)
  })

  it('clearEntityStores drives every registry entry', () => {
    const { registry, calls } = makeRegistry()
    const context = makeContext(registry)
    context.clearEntityStores()
    expect(calls.clear).toBe(1)
  })

  describe('patchFromChange', () => {
    it('upserts an inserted payload and remembers its envelope', async () => {
      const { store, remembered } = makeFakeStore()
      const { registry, calls } = makeRegistry()
      const context = makeContext(registry)
      context.attachStore(store)
      const payload = { id: 'note-1' }
      await context.patchFromChange('notes', {
        operation: 'INSERT',
        documentData: { id: 'env-1', data: envelope(payload) }
      })
      expect(calls.upsert).toEqual([payload])
      expect(calls.drop).toEqual([])
      expect(remembered).toEqual([['notes', 'note-1', 'env-1']])
    })

    it('drops a deleted payload and forgets its envelope', async () => {
      const { store, forgotten } = makeFakeStore()
      const { registry, calls } = makeRegistry()
      const context = makeContext(registry)
      context.attachStore(store)
      await context.patchFromChange('notes', {
        operation: 'DELETE',
        documentData: { id: 'env-1', data: envelope({ id: 'note-1' }) }
      })
      expect(calls.drop).toEqual(['note-1'])
      expect(calls.upsert).toEqual([])
      expect(forgotten).toEqual([['notes', 'note-1']])
    })

    it('ignores a tombstone for a stale duplicate envelope', async () => {
      // The entity lives in env-live; a tombstone arrives for env-stale (a
      // reconciled singleton loser or pre-resurrection row that decrypts to
      // the same logical id). It must not drop the live doc.
      const { store, forgotten } = makeFakeStore({
        index: { 'note-1': 'env-live' }
      })
      const { registry, calls } = makeRegistry()
      const context = makeContext(registry)
      context.attachStore(store)
      await context.patchFromChange('notes', {
        operation: 'DELETE',
        documentData: { id: 'env-stale', data: envelope({ id: 'note-1' }) }
      })
      expect(calls.drop).toEqual([])
      expect(forgotten).toEqual([])
    })

    it('honors a tombstone for the live envelope', async () => {
      const { store, forgotten } = makeFakeStore({
        index: { 'note-1': 'env-live' }
      })
      const { registry, calls } = makeRegistry()
      const context = makeContext(registry)
      context.attachStore(store)
      await context.patchFromChange('notes', {
        operation: 'DELETE',
        documentData: { id: 'env-live', data: envelope({ id: 'note-1' }) }
      })
      expect(calls.drop).toEqual(['note-1'])
      expect(forgotten).toEqual([['notes', 'note-1']])
    })

    it('drops on a soft-delete (_deleted) row', async () => {
      const { store } = makeFakeStore()
      const { registry, calls } = makeRegistry()
      const context = makeContext(registry)
      context.attachStore(store)
      await context.patchFromChange('notes', {
        operation: 'UPDATE',
        documentData: {
          id: 'env-1',
          data: envelope({ id: 'note-1' }),
          _deleted: true
        }
      })
      expect(calls.drop).toEqual(['note-1'])
    })

    it('is a no-op for an unregistered collection', async () => {
      const { store } = makeFakeStore()
      const { registry, calls } = makeRegistry()
      const context = makeContext(registry)
      context.attachStore(store)
      await context.patchFromChange('unknown', {
        operation: 'INSERT',
        documentData: { id: 'env-1', data: envelope({ id: 'x' }) }
      })
      expect(calls.upsert).toEqual([])
      expect(calls.drop).toEqual([])
    })

    it('is a silent no-op when no store is attached', async () => {
      const { registry, calls } = makeRegistry()
      const context = makeContext(registry)
      await context.patchFromChange('notes', {
        operation: 'INSERT',
        documentData: { id: 'env-1', data: envelope({ id: 'note-1' }) }
      })
      expect(calls.upsert).toEqual([])
      expect(calls.drop).toEqual([])
      expect(calls.hydrate).toBe(0)
    })

    it('writes nothing when the store is detached across the decrypt await', async () => {
      const { store, remembered, release } = makeGatedStore()
      const { registry, calls } = makeRegistry()
      const context = makeContext(registry)
      context.attachStore(store)
      // Fired floating off the change stream, as replication does.
      const patched = context.patchFromChange('notes', {
        operation: 'INSERT',
        documentData: { id: 'env-1', data: envelope({ id: 'note-1' }) }
      })
      // A logout tears the store down mid-decrypt.
      context.detachStore()
      release()
      // Resolves rather than rejecting (no unhandled rejection off the stream).
      await expect(patched).resolves.toBeUndefined()
      expect(calls.upsert).toEqual([])
      expect(calls.drop).toEqual([])
      expect(remembered).toEqual([])
    })

    it('writes nothing when the store is replaced under a new context across the decrypt await', async () => {
      const previous = makeGatedStore()
      const { registry, calls } = makeRegistry()
      const previousContext = makeContext(registry)
      previousContext.attachStore(previous.store)
      const patched = previousContext.patchFromChange('notes', {
        operation: 'INSERT',
        documentData: { id: 'env-1', data: envelope({ id: 'note-1' }) }
      })
      // A logout/login re-bootstrap detaches the old replica, then a fresh
      // session attaches a new one under its own context.
      previousContext.detachStore()
      const next = makeFakeStore()
      const nextContext = makeContext(registry)
      nextContext.attachStore(next.store)
      previous.release()
      await expect(patched).resolves.toBeUndefined()
      // The previous session's payload never reaches the new session's replica.
      expect(calls.upsert).toEqual([])
      expect(next.remembered).toEqual([])
      expect(previous.remembered).toEqual([])
    })

    it('schedules a re-hydrate when the envelope is missing', async () => {
      vi.useFakeTimers()
      try {
        const { store } = makeFakeStore()
        const { registry, calls } = makeRegistry()
        const context = makeContext(registry)
        context.attachStore(store)
        await context.patchFromChange('notes', {
          operation: 'INSERT',
          documentData: { id: 'env-1' }
        })
        expect(calls.upsert).toEqual([])
        await vi.advanceTimersByTimeAsync(60)
        expect(calls.hydrate).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('schedules a re-hydrate when decryption fails', async () => {
      vi.useFakeTimers()
      try {
        const { store } = makeFakeStore({ failDecrypt: true })
        const { registry, calls } = makeRegistry()
        const context = makeContext(registry)
        context.attachStore(store)
        await context.patchFromChange('notes', {
          operation: 'INSERT',
          documentData: { id: 'env-1', data: envelope({ id: 'note-1' }) }
        })
        expect(calls.upsert).toEqual([])
        await vi.advanceTimersByTimeAsync(60)
        expect(calls.hydrate).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('scheduleRehydrate', () => {
    it('is a no-op for an unregistered collection', () => {
      vi.useFakeTimers()
      try {
        const { store } = makeFakeStore()
        const { registry, calls } = makeRegistry()
        const context = makeContext(registry)
        context.attachStore(store)
        context.scheduleRehydrate('unknown')
        vi.advanceTimersByTime(60)
        expect(calls.hydrate).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('is a no-op with no store attached', () => {
      vi.useFakeTimers()
      try {
        const { registry, calls } = makeRegistry()
        const context = makeContext(registry)
        context.scheduleRehydrate('notes')
        vi.advanceTimersByTime(60)
        expect(calls.hydrate).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a scheduled re-hydrate that outlives detach is a no-op', async () => {
      vi.useFakeTimers()
      try {
        const { store } = makeFakeStore()
        const { registry, calls } = makeRegistry()
        const context = makeContext(registry)
        context.attachStore(store)
        context.scheduleRehydrate('notes')
        context.detachStore()
        await vi.advanceTimersByTimeAsync(60)
        expect(calls.hydrate).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('detachStore cancels every pending re-hydrate', async () => {
      vi.useFakeTimers()
      try {
        const { store } = makeFakeStore()
        const { registry, calls } = makeRegistry()
        const context = makeContext(registry)
        context.attachStore(store)
        context.scheduleRehydrate('notes')
        context.detachStore()
        await vi.advanceTimersByTimeAsync(60)
        expect(calls.hydrate).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('whileAttached', () => {
    it('resolves undefined without calling op when no store is attached', async () => {
      const context = makeContext()
      let called = false
      const result = await context.whileAttached(async () => {
        called = true
        return 'value'
      })
      expect(result).toBeUndefined()
      expect(called).toBe(false)
    })

    it('resolves the result when the store is still attached', async () => {
      const { store } = makeFakeStore()
      const context = makeContext()
      context.attachStore(store)
      const result = await context.whileAttached(async attached => {
        expect(attached).toBe(store)
        return 'value'
      })
      expect(result).toBe('value')
    })

    it('resolves undefined and swallows a rejection when detached mid-op', async () => {
      let release = () => {}
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const { store } = makeFakeStore()
      const context = makeContext()
      context.attachStore(store)
      const pending = context.whileAttached(async () => {
        await gate
        throw new Error('torn read')
      })
      context.detachStore()
      release()
      await expect(pending).resolves.toBeUndefined()
    })

    it('rethrows a rejection when the store is still attached', async () => {
      const { store } = makeFakeStore()
      const context = makeContext()
      context.attachStore(store)
      await expect(
        context.whileAttached(async () => {
          throw new Error('read failed')
        })
      ).rejects.toThrow(/read failed/)
    })
  })

  describe('attachStore', () => {
    it('throws while another context still has a store attached', () => {
      const first = makeContext()
      first.attachStore(makeFakeStore().store)
      const second = makeContext()
      expect(() => second.attachStore(makeFakeStore().store)).toThrow(
        /one live session/
      )
    })
  })

  describe('activateStorageContext', () => {
    it('replaces an inert context silently', () => {
      // `first` becomes active but never attaches a store, so it is inert;
      // activating `second` in its place must not throw.
      const first = makeContext()
      activateStorageContext(first)
      const second = makeContext()
      expect(() => activateStorageContext(second)).not.toThrow()
      expect(requireStorageContext()).toBe(second)
    })

    it('throws while the active context still has a store attached', () => {
      const first = makeContext()
      first.attachStore(makeFakeStore().store)
      const second = makeContext()
      expect(() => activateStorageContext(second)).toThrow(/one live session/)
    })
  })
})
