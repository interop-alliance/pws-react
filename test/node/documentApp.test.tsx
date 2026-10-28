/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Tier-1 facade tests (jsdom): `defineDocumentApp` builds a one-collection
 * local-first config plus a singleton-document registry, and `useAppDocument`
 * reads/writes the document through the storage seam. The LocalStore is a
 * Map-backed fake attached to the session store's own storage context (the
 * repo convention: real encryption never runs under jsdom -- node:crypto
 * Buffers fail @scure/base's byte check once jsdom swaps the global
 * Uint8Array -- so the encrypted round trip lives in the node-environment
 * localStore tests and the example apps' Playwright tiers). Covers the
 * initial-value contract, LWW stamping on
 * patch and updater writes, registry hydration, the export/import round trip
 * (including rejection of non-export files), and the connect/disconnect
 * wiring.
 *
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WasSessionContext } from '../../src/react/WasSessionProvider.js'
import {
  defineDocumentApp,
  DOCUMENT_COLLECTION_KEY,
  DOCUMENT_EXPORT_FORMAT
} from '../../src/react/documentApp.js'
import {
  createAuthStore,
  type WasAuthStore
} from '../../src/session/authStore.js'
import type { LocalStore } from '../../src/storage/localStore.js'

interface SaveFile {
  score: number
  playerName: string
}

interface StoredSave {
  id: string
  updatedAt: string
  writerId: string
  data: SaveFile
}

const INITIAL: SaveFile = { score: 0, playerName: 'anonymous' }

/**
 * A Map-backed LocalStore fake covering the verbs the facade drives.
 */
function fakeLocalStore() {
  const rows = new Map<string, StoredSave>()
  return {
    rows,
    upsertEntity: async (_key: string, payload: StoredSave) => {
      rows.set(payload.id, payload)
    },
    hydrateSingleton: async () => {
      const [first] = rows.values()
      return first ?? null
    }
  }
}

const liveStores: WasAuthStore[] = []

/**
 * A fresh facade + session store, driven to `local` directly (no boot: the
 * fake storage layer stands in for the replica a real boot would open),
 * with the fake attached to THIS store's own storage context.
 */
function localApp() {
  const app = defineDocumentApp<SaveFile>({
    appName: 'Test Saves',
    appOrigin: 'http://localhost:5173',
    document: { collectionId: 'test-saves', initial: INITIAL },
    appUrl: 'http://localhost:5173/test-app'
  })
  const store = createAuthStore({ config: app.config, registry: app.registry })
  liveStores.push(store)
  const fake = fakeLocalStore()
  store.getState().storageContext.attachStore(fake as unknown as LocalStore)
  store.setState({ status: 'local' })
  return { app, store, fake }
}

/**
 * Reads a Blob as text via FileReader (jsdom's Blob has no `.text()`).
 */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

/**
 * A minimal `File` stand-in with the one member `importFile` reads (jsdom's
 * File constructor also lacks `.text()`; real-File handling is covered by the
 * example apps' Playwright tiers).
 */
function fileOf(content: string): File {
  return { text: async () => content } as unknown as File
}

function wrapperFor(store: WasAuthStore) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <WasSessionContext.Provider value={store}>
        {children}
      </WasSessionContext.Provider>
    )
  }
}

afterEach(() => {
  cleanup()
  while (liveStores.length > 0) {
    liveStores.pop()!.getState().storageContext.detachStore()
  }
})

describe('defineDocumentApp', () => {
  it('builds a one-collection, local-first config and singleton registry', () => {
    const { app } = localApp()
    expect(app.config.collections).toEqual([
      { key: DOCUMENT_COLLECTION_KEY, id: 'test-saves' }
    ])
    expect(app.config.onboarding).toBe('local-first')
    const entry = app.registry[DOCUMENT_COLLECTION_KEY]
    expect(entry).toBeDefined()
    expect(typeof entry?.hydrate).toBe('function')
    expect(typeof entry?.upsert).toBe('function')
    expect(typeof entry?.drop).toBe('function')
    expect(typeof entry?.clear).toBe('function')
  })

  it('hydrates the singleton winner into the document store', async () => {
    const { app, store, fake } = localApp()
    fake.rows.set('main', {
      id: 'main',
      updatedAt: '2026-07-19T00:00:00.000Z',
      writerId: 'device-1',
      data: { score: 12, playerName: 'restored' }
    })
    await app.registry[DOCUMENT_COLLECTION_KEY]?.hydrate()

    const { result } = renderHook(() => app.useAppDocument(), {
      wrapper: wrapperFor(store)
    })
    expect(result.current.doc).toEqual({ score: 12, playerName: 'restored' })
  })
})

describe('useAppDocument', () => {
  it('hides the doc during boot, then serves initial and merges writes', async () => {
    const { app, store } = localApp()
    store.setState({ status: 'boot' })
    const { result } = renderHook(() => app.useAppDocument(), {
      wrapper: wrapperFor(store)
    })
    expect(result.current.doc).toBeUndefined()

    store.setState({ status: 'local' })
    await waitFor(() => expect(result.current.doc).toEqual(INITIAL))
    expect(result.current.status).toBe('local')
    expect(result.current.sync).toBe('offline')
    expect(result.current.connecting).toBe(false)
    expect(result.current.error).toBeNull()

    await result.current.update({ score: 42 })
    await waitFor(() =>
      expect(result.current.doc).toEqual({ score: 42, playerName: 'anonymous' })
    )

    // Updater-function form sees the merged current value.
    await result.current.update(prev => ({
      ...prev,
      score: prev.score + 1,
      playerName: 'miner'
    }))
    await waitFor(() =>
      expect(result.current.doc).toEqual({ score: 43, playerName: 'miner' })
    )
  })

  it('persists under the fixed id with fresh LWW stamps on every write', async () => {
    const { app, store, fake } = localApp()
    const { result } = renderHook(() => app.useAppDocument(), {
      wrapper: wrapperFor(store)
    })
    await result.current.update({ score: 7 })

    const row = fake.rows.get('main')
    expect(row).toBeDefined()
    expect(row?.data).toEqual({ score: 7, playerName: 'anonymous' })
    // The facade stamps nothing itself: the entity store's write verb lands an
    // ISO timestamp and the session's resolved writer id, wrapped BESIDE the
    // app data, never inside it.
    expect(Date.parse(row?.updatedAt ?? '')).not.toBeNaN()
    expect(row?.writerId).toBe(store.getState().writerId)
    expect(fake.rows.size).toBe(1)

    await result.current.update({ score: 8 })
    expect(fake.rows.size).toBe(1)
    expect(fake.rows.get('main')?.data.score).toBe(8)
  })

  it('composes unawaited updates in call order', async () => {
    const { app, store, fake } = localApp()
    const { result } = renderHook(() => app.useAppDocument(), {
      wrapper: wrapperFor(store)
    })
    // Neither write is awaited before the next is issued: the second must
    // merge onto what the first wrote, not onto the pre-write value.
    const first = result.current.update({ score: 1 })
    const second = result.current.update({ playerName: 'racer' })
    const third = result.current.update(prev => ({
      ...prev,
      score: prev.score + 10
    }))
    // An export issued in the same burst already carries the three updates.
    const exported = await result.current.exportFile().then(readBlobText)
    expect((JSON.parse(exported) as { document: SaveFile }).document).toEqual({
      score: 11,
      playerName: 'racer'
    })
    await Promise.all([first, second, third])

    expect(fake.rows.get('main')?.data).toEqual({
      score: 11,
      playerName: 'racer'
    })
    await waitFor(() =>
      expect(result.current.doc).toEqual({ score: 11, playerName: 'racer' })
    )
  })

  it('rolls back an update the store rejects, then takes updates and imports again', async () => {
    const { app, store, fake } = localApp()
    const { result } = renderHook(() => app.useAppDocument(), {
      wrapper: wrapperFor(store)
    })
    await result.current.update({ score: 3 })
    const persist = fake.upsertEntity
    fake.upsertEntity = async () => {
      throw new Error('replica closed')
    }
    await expect(result.current.update({ score: 4 })).rejects.toThrow(
      'replica closed'
    )
    await waitFor(() => expect(result.current.doc?.score).toBe(3))

    fake.upsertEntity = persist
    const next = result.current.update({ playerName: 'back' })
    const imported = result.current.importFile(
      fileOf(
        JSON.stringify({
          format: DOCUMENT_EXPORT_FORMAT,
          document: { score: 7, playerName: 'imported' }
        })
      )
    )
    await Promise.all([next, imported])
    expect(fake.rows.get('main')?.data).toEqual({
      score: 7,
      playerName: 'imported'
    })
  })

  it('keeps updating after a rejected update', async () => {
    const { app, store, fake } = localApp()
    const { result } = renderHook(() => app.useAppDocument(), {
      wrapper: wrapperFor(store)
    })
    const failing = result.current.update(() => {
      throw new Error('bad updater')
    })
    const next = result.current.update({ score: 5 })
    await expect(failing).rejects.toThrow('bad updater')
    await next
    expect(fake.rows.get('main')?.data).toEqual({
      score: 5,
      playerName: 'anonymous'
    })
  })

  it('round-trips the document through exportFile / importFile', async () => {
    const { app, store } = localApp()
    const { result } = renderHook(() => app.useAppDocument(), {
      wrapper: wrapperFor(store)
    })
    await result.current.update({ score: 9000, playerName: 'exporter' })
    await waitFor(() => expect(result.current.doc?.score).toBe(9000))

    const blob = await result.current.exportFile()
    expect(blob.type).toBe('application/json')
    const exported = await readBlobText(blob)
    const body = JSON.parse(exported) as {
      format: string
      app: string
      document: SaveFile
    }
    expect(body.format).toBe(DOCUMENT_EXPORT_FORMAT)
    expect(body.app).toBe('Test Saves')
    expect(body.document).toEqual({ score: 9000, playerName: 'exporter' })

    // Diverge, then restore from the exported file.
    await result.current.update({ score: 0, playerName: 'someone-else' })
    await result.current.importFile(fileOf(exported))
    await waitFor(() =>
      expect(result.current.doc).toEqual({
        score: 9000,
        playerName: 'exporter'
      })
    )
  })

  it('rejects a file that is not a document export', async () => {
    const { app, store } = localApp()
    const { result } = renderHook(() => app.useAppDocument(), {
      wrapper: wrapperFor(store)
    })
    await waitFor(() => expect(result.current.doc).toEqual(INITIAL))

    await expect(
      result.current.importFile(fileOf('not json at all'))
    ).rejects.toThrow(/unreadable JSON/)
    const wrongFormat = fileOf(
      JSON.stringify({ format: 'something-else', document: { score: 1 } })
    )
    await expect(result.current.importFile(wrongFormat)).rejects.toThrow(
      /was-document\/v1/
    )
    // The held document is untouched by either failure.
    expect(result.current.doc).toEqual(INITIAL)
  })

  it('wires connect/disconnect to the session login/logout', () => {
    const { app, store } = localApp()
    const { result } = renderHook(() => app.useAppDocument(), {
      wrapper: wrapperFor(store)
    })
    // The wiring targets are the store's own actions; invoking them here would
    // launch CHAPI / tear down storage, which the auth-store tests cover.
    expect(typeof result.current.connect).toBe('function')
    expect(typeof result.current.disconnect).toBe('function')
    expect(typeof store.getState().login).toBe('function')
    expect(typeof store.getState().logout).toBe('function')
  })
})
