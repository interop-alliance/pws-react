/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * End-to-end plaintext-collection sync against a real in-process
 * was-teaching-server (the published npm package): provisions a dev Space with
 * a public (plaintext) collection and a private (encrypted) one, replicates
 * local writes up through the real sync stack, asserts the server-side bodies
 * (the public payload verbatim; an EDV envelope for the private one), and
 * pulls both back down into a second, fresh replica.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTempBackend, startTestServer } from 'was-teaching-server/testing'
import { provisionDevGrants } from '../../src/dev/provisionDevGrants.js'
import { parseGrants, type ParsedGrants } from '../../src/grants.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { LocalStore } from '../../src/storage/localStore.js'
import { createEntityStore } from '../../src/storage/entityStore.js'
import { publicUrlFor } from '../../src/storage/publicUrl.js'
import { deactivateStorageContext } from '../../src/storage/storageManager.js'
import { StorageContext } from '../../src/storage/storageContext.js'
import { startWasSync } from '../../src/storage/wasSync.js'
import { SyncController } from '../../src/storage/syncController.js'
import { createSyncStatusStore } from '../../src/storage/syncStatusStore.js'
import type { WasRemoteStore } from '../../src/storage/wasRemoteStore.js'
import type { ZcapClient } from '@interop/ezcap'
import type { WasCollectionConfig } from '../../src/config.js'

// The SyncController wires an `online` listener on `window`; Node has no
// window, so give it an inert stand-in.
;(globalThis as { window?: unknown }).window ??= {
  addEventListener: () => {},
  removeEventListener: () => {}
}

const PUBLIC_ID = 'microblog-posts'
const PRIVATE_ID = 'notes'
const REGISTRY: WasCollectionConfig[] = [
  { key: 'posts', id: PUBLIC_ID, visibility: 'public', indexes: ['title'] },
  { key: 'notes', id: PRIVATE_ID }
]

// A fixed 32-byte app (relying party) master seed.
const SEED = new Uint8Array(32).map((_, index) => (index * 13 + 5) & 0xff)

interface PostDoc {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  writerId: string
}

function makeDoc(title: string): PostDoc {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    writerId: 'device-test'
  }
}

/**
 * Polls `probe` until it resolves non-null (errors count as null) or the
 * timeout elapses.
 */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  label: string,
  timeoutMs = 30000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await probe().catch(() => null)
    if (result !== null) {
      return result
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}.`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

let server: Awaited<ReturnType<typeof startTestServer>> | undefined
let serverUrl: string
let parsed: ParsedGrants
let zcapClient: ZcapClient
const controllers: SyncController[] = []
const stores: LocalStore[] = []
let remoteStore: WasRemoteStore

// Written by the push test, read back by the pull test.
const post = makeDoc('A world-readable post')
const note = makeDoc('secret-note-marker')

beforeAll(async () => {
  // The server owns the temp backend, so closing it removes the data dir.
  // Zcap invocation targets embed the port, so every client is built from the
  // `serverUrl` the boot returns.
  server = await startTestServer({
    backend: await openTempBackend({
      prefix: 'was-react-plaintext-',
      capacityBytes: Infinity
    })
  })
  ;({ serverUrl } = server)

  const provisioned = await provisionDevGrants({
    serverUrl,
    seed: SEED,
    collections: [{ id: PUBLIC_ID, visibility: 'public' }, PRIVATE_ID]
  })
  parsed = parseGrants(provisioned.grants)
  ;({ zcapClient } = await deriveIdentity({ seed: SEED }))
}, 60000)

afterAll(async () => {
  for (const controller of controllers) {
    await controller.stop()
  }
  for (const store of stores) {
    await store.close()
  }
  await server?.fastify.close()
}, 60000)

/**
 * Opens a replica over the registry and starts real replication against the
 * in-process server (fast retry/poll so the tests converge quickly).
 */
async function openSyncedReplica(dbName: string): Promise<LocalStore> {
  const { keyAgreementKey, keyResolver } = await deriveIdentity({ seed: SEED })
  const store = await LocalStore.init({
    keyAgreementKey,
    keyResolver,
    collections: REGISTRY,
    dbName
  })
  stores.push(store)
  const controller = new SyncController({
    collections: REGISTRY,
    syncStatus: createSyncStatusStore(),
    sync: { pollMs: 500, retryMs: 500 }
  })
  controllers.push(controller)
  ;({ remoteStore } = await startWasSync({
    parsed,
    zcapClient,
    collections: REGISTRY,
    localStore: store,
    syncController: controller,
    onRemoteChange: () => {}
  }))
  return store
}

describe('plaintext-collection sync against was-teaching-server', () => {
  it('pushes the public payload verbatim and the private one encrypted', async () => {
    const store = await openSyncedReplica('plaintext-sync-a')
    await store.insertEntity('posts', post)
    await store.insertEntity('notes', note)

    // The public resource lands under its own logical id, plaintext.
    const publicBody = await waitFor(async () => {
      const response = await remoteStore.was.request({
        capability: remoteStore.collectionCapability(PUBLIC_ID),
        path: `/space/${remoteStore.spaceId}/${PUBLIC_ID}/${post.id}`,
        method: 'GET'
      })
      return response.data as PostDoc
    }, 'the public resource to be pushed')
    expect(publicBody).toEqual(post)

    // The private resource lands under its random envelope id, as ciphertext.
    const rows = await store.rxCollection('notes').find().exec()
    expect(rows).toHaveLength(1)
    const envelopeId = rows[0]!.id
    expect(envelopeId).not.toBe(note.id)
    const privateBody = await waitFor(async () => {
      const response = await remoteStore.was.request({
        capability: remoteStore.collectionCapability(PRIVATE_ID),
        path: `/space/${remoteStore.spaceId}/${PRIVATE_ID}/${envelopeId}`,
        method: 'GET'
      })
      return response.data as { jwe?: unknown }
    }, 'the private envelope to be pushed')
    expect(typeof privateBody.jwe).toBe('object')
    expect(JSON.stringify(privateBody)).not.toContain('secret-note-marker')
  }, 60000)

  it('leaves the public collection unmarked and declares its indexes', async () => {
    // The Metadata object, read the way the bootstrap reads it.
    const read = await remoteStore.readCollectionMeta(PUBLIC_ID)
    expect(read).toBeDefined()
    expect(read!.description.encryption).toBeUndefined()
    // The sync bootstrap announced the registry's equality indexes, writing
    // the object back whole under its validator.
    expect(read!.description.plaintext?.indexes).toEqual(['title'])
    expect(read!.etag).toBeDefined()
  }, 60000)

  it('answers an equality query over the GET filter', async () => {
    const page = await waitFor(async () => {
      const result = await remoteStore.queryCollectionByEquality({
        collectionId: PUBLIC_ID,
        equals: { title: post.title }
      })
      return result.documents.length > 0 ? result : null
    }, 'the equality query to match the pushed post')
    expect(page.hasMore).toBe(false)
    expect(page.documents).toEqual([{ id: post.id, data: post }])

    // A non-matching term answers an empty page, not an error.
    const empty = await remoteStore.queryCollectionByEquality({
      collectionId: PUBLIC_ID,
      equals: { title: 'no such title' }
    })
    expect(empty).toEqual({ documents: [], hasMore: false })

    // An undeclared attribute fails closed client-side.
    await expect(
      remoteStore.queryCollectionByEquality({
        collectionId: PUBLIC_ID,
        equals: { author: 'nobody' }
      })
    ).rejects.toThrow(/not declared/)

    // The app-facing entity-store verb, end-to-end through the storage
    // context: key routing, the GET filter, and the payload mapping.
    const queryContext = new StorageContext({
      registry: {},
      writerId: 'test-writer'
    })
    queryContext.attachStore(stores[0]!)
    queryContext.attachRemoteStore(remoteStore)
    try {
      const posts = createEntityStore<PostDoc>('posts')
      const viaStore = await posts
        .getState()
        .query({ equals: { title: post.title } })
      expect(viaStore).toEqual({ docs: [post], hasMore: false })
    } finally {
      queryContext.detachStore()
      queryContext.detachRemoteStore()
      deactivateStorageContext(queryContext)
    }
  }, 60000)

  it('pulls both collections into a fresh replica', async () => {
    const replica = await openSyncedReplica('plaintext-sync-b')

    const pulledPosts = await waitFor(async () => {
      const listed = await replica.listEntities<PostDoc>('posts')
      return listed.length > 0 ? listed : null
    }, 'the public post to be pulled')
    expect(pulledPosts).toEqual([post])

    const pulledNotes = await waitFor(async () => {
      const listed = await replica.listEntities<PostDoc>('notes')
      return listed.length > 0 ? listed : null
    }, 'the private note to be pulled')
    expect(pulledNotes).toEqual([note])
  }, 60000)

  it('composes a share URL an anonymous reader can fetch, and unshares', async () => {
    // A dedicated shared doc, inserted and then unshared (tombstoned) within
    // this test. It runs after the pull test so the extra post never disturbs
    // that test's assertions.
    const shared = makeDoc('A shareable post')
    const store = stores[0]!
    await store.insertEntity('posts', shared)

    // Mimic wallet provisioning of a public collection: set the `PublicCanRead`
    // access-control policy so unauthenticated reads are authorized (the
    // dev-grant provisioner creates plaintext collections but does not attach a
    // public-read policy). Set via the delegated collection capability, whose
    // invocationTarget is a RESTful prefix of the collection `/policy` path.
    await remoteStore.was.request({
      capability: remoteStore.collectionCapability(PUBLIC_ID),
      path: `/space/${remoteStore.spaceId}/${PUBLIC_ID}/policy`,
      method: 'PUT',
      json: { type: 'PublicCanRead' }
    })

    // The root helper routes the logical key through the storage context; it
    // must agree with the remote store's own composition.
    const urlContext = new StorageContext({
      registry: {},
      writerId: 'test-writer'
    })
    urlContext.attachStore(store)
    urlContext.attachRemoteStore(remoteStore)
    let url: string
    try {
      url = publicUrlFor({ collectionKey: 'posts', id: shared.id })
    } finally {
      urlContext.detachStore()
      urlContext.detachRemoteStore()
      deactivateStorageContext(urlContext)
    }
    expect(url).toBe(
      remoteStore.publicUrlFor({ collectionId: PUBLIC_ID, id: shared.id })
    )
    expect(url).toBe(
      `${serverUrl}/space/${remoteStore.spaceId}/${PUBLIC_ID}/${shared.id}`
    )

    // An unauthenticated reader (a plain, unsigned GET) can consume the share
    // link once the doc has replicated to the server.
    const fetched = await waitFor(async () => {
      const response = await fetch(url)
      return response.ok ? ((await response.json()) as PostDoc) : null
    }, 'the shared post to be publicly readable')
    expect(fetched).toEqual(shared)

    // Unshare: delete the copy, let replication push the tombstone, and the
    // unsigned fetch stops returning the payload.
    await store.deleteEntity('posts', shared.id)
    await waitFor(async () => {
      const response = await fetch(url)
      // Drain the body so the connection is not left dangling.
      await response.arrayBuffer()
      // Wait for a clean 404 -- a transient 5xx can surface while the delete is
      // still settling on the file backend.
      return response.status === 404 ? true : null
    }, 'the unshared post to stop resolving publicly')
  }, 60000)
})
