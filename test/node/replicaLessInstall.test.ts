/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The replica-less install: an app that only reads a wallet-owned shared
 * collection builds no local replica, and resolves this library with `rxdb`
 * absent. `rxdb` is an optional peer: the root entry imports nothing from it at
 * module evaluation, because `LocalStore` loads `rxdb` inside `init()` and
 * `removeDatabase()` and `SyncController` loads the driver subpath
 * (`@interop/was-sync/rxdb`, the one was-sync entry that imports `rxdb`) inside
 * `start()`.
 *
 * The fixture stands in for a separate install: a resolver where every `rxdb`
 * entry point throws is what a missing peer looks like at import time. The
 * second case pins where that failure lands when the peer IS needed: at the
 * first replica operation, with the resolver's own error, and nowhere earlier.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const absent = () => {
  throw new Error("Cannot find package 'rxdb'")
}

describe('the replica-less install', () => {
  afterEach(() => {
    vi.doUnmock('rxdb/plugins/core')
    vi.doUnmock('rxdb/plugins/storage-dexie')
    vi.doUnmock('rxdb/plugins/replication')
    vi.doUnmock('@interop/was-sync/rxdb')
    vi.resetModules()
  })

  it('resolves the root entry with rxdb absent', async () => {
    // `doMock` rather than `mock`: the mocks must apply to the fixture's import
    // below without being hoisted over the other suites in this file.
    vi.doMock('rxdb/plugins/core', absent)
    vi.doMock('rxdb/plugins/storage-dexie', absent)
    vi.doMock('rxdb/plugins/replication', absent)
    vi.doMock('@interop/was-sync/rxdb', absent)

    const { replicaLessSurface } = await import('../fixtures/replicaLessApp.js')
    expect(replicaLessSurface()).toContain('SharedCollectionReader')
  })

  it('fails at the first replica operation, not at import', async () => {
    vi.doMock('rxdb/plugins/core', absent)
    vi.doMock('rxdb/plugins/storage-dexie', absent)

    const { LocalStore } = await import('../../src/index.js')
    const failure: unknown = await LocalStore.removeDatabase({
      dbName: 'replica-less-never-opened'
    }).then(
      () => undefined,
      err => err
    )
    // Vitest wraps a throwing mock factory in an error of its own, with the
    // factory's error as `cause`; the resolver's message sits at the end of
    // that chain.
    const messages: string[] = []
    for (let err = failure; err instanceof Error; err = err.cause) {
      messages.push(err.message)
    }
    expect(messages.at(-1)).toContain("Cannot find package 'rxdb'")
  })
})
