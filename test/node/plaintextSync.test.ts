/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * End-to-end plaintext-collection sync against a real in-process
 * web-spaces-server (the published npm package): provisions a dev Space with
 * a public (plaintext) collection and a private (encrypted) one, replicates
 * local writes up through the real sync stack, asserts the server-side bodies
 * (the public payload verbatim; an EDV envelope for the private one), and
 * pulls both back down into a second, fresh replica.
 *
 * The public collection's equality indexes are declared by the Space
 * controller, the stand-in for the wallet. The app's Collection-scoped grant
 * cannot write Collection Metadata, so its own attempt is refused by name,
 * and its sync bootstrap finds the declaration in place and writes nothing.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openTempBackend,
  startTestServer
} from '@interop/web-spaces-server/testing'
import { provisionDevGrants } from '../../src/dev/provisionDevGrants.js'
import { parseGrants, type ParsedGrants } from '../../src/grants.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { LocalStore } from '../../src/storage/localStore.js'
import { createEntityStore } from '../../src/storage/entityStore.js'
import { publicUrlFor } from '../../src/storage/publicUrl.js'
import { deactivateStorageContext } from '../../src/storage/storageManager.js'
import { StorageContext } from '../../src/storage/storageContext.js'
import { startPwsSync } from '../../src/storage/pwsSync.js'
import { SyncController } from '../../src/storage/syncController.js'
import { createSyncStatusStore } from '../../src/storage/syncStatusStore.js'
import {
  PwsRemoteStore,
  type CollectionMetaRead,
  type DeclarationResult
} from '../../src/storage/pwsRemoteStore.js'
import type { ZcapClient } from '@interop/ezcap'
import type { PwsCollectionConfig } from '../../src/config.js'
import { withCapturedLogs } from '../fixtures/capturedLogs.js'
import { devSpaceOwner } from '../fixtures/devSpaceOwner.js'

// The SyncController wires an `online` listener on `window`; Node has no
// window, so give it an inert stand-in.
;(globalThis as { window?: unknown }).window ??= {
  addEventListener: () => {},
  removeEventListener: () => {}
}

const PUBLIC_ID = 'microblog-posts'
const PRIVATE_ID = 'notes'
const REGISTRY: PwsCollectionConfig[] = [
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
let baseServerUrl: string
let parsed: ParsedGrants
let zcapClient: ZcapClient
const controllers: SyncController[] = []
const statusStores: ReturnType<typeof createSyncStatusStore>[] = []
const stores: LocalStore[] = []
let remoteStore: PwsRemoteStore
// The warnings every sync bootstrap logged.
const bootstrapWarnings: string[] = []
// The app's own declaration attempt before the wallet declared, and the
// Metadata object on either side of it.
let refused: DeclarationResult
let beforeRefusal: CollectionMetaRead | undefined
let afterRefusal: CollectionMetaRead | undefined
// The Metadata object's validator once the wallet's declaration landed.
let declaredEtag: string | undefined

// Written by the push test, read back by the pull test.
const post = makeDoc('A world-readable post')
const note = makeDoc('secret-note-marker')

beforeAll(async () => {
  // The server owns the temp backend, so closing it removes the data dir.
  // Zcap invocation targets embed the port, so every client is built from the
  // `baseServerUrl` the boot returns.
  server = await startTestServer({
    backend: await openTempBackend({
      prefix: 'pws-react-plaintext-',
      capacityBytes: Infinity
    })
  })
  ;({ baseServerUrl } = server)

  const provisioned = await provisionDevGrants({
    baseServerUrl,
    seed: SEED,
    collections: [{ id: PUBLIC_ID, visibility: 'public' }, PRIVATE_ID]
  })
  parsed = parseGrants(provisioned.grants)
  ;({ zcapClient } = await deriveIdentity({ seed: SEED }))

  // The app's own attempt, under its Collection grant, while nothing is
  // declared yet.
  const appStore = PwsRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections: REGISTRY
  })
  beforeRefusal = await appStore.readCollectionMeta(PUBLIC_ID)
  refused = await appStore.declareCollectionIndexes(PUBLIC_ID, {
    ...(beforeRefusal && { current: beforeRefusal })
  })
  afterRefusal = await appStore.readCollectionMeta(PUBLIC_ID)

  // The wallet's declaration: the Space controller invokes as root.
  const owner = await devSpaceOwner({
    baseServerUrl,
    did: provisioned.provisionerDid
  })
  await owner
    .spaceAt(provisioned.spaceUrl)
    .collection(PUBLIC_ID)
    .configure({ plaintext: { indexes: ['title'] } })
  declaredEtag = (await appStore.readCollectionMeta(PUBLIC_ID))?.etag
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
  const syncStatus = createSyncStatusStore()
  statusStores.push(syncStatus)
  const controller = new SyncController({
    collections: REGISTRY,
    syncStatus,
    sync: { pollMs: 500, retryMs: 500 }
  })
  controllers.push(controller)
  const { result, events } = await withCapturedLogs(() =>
    startPwsSync({
      parsed,
      zcapClient,
      collections: REGISTRY,
      localStore: store,
      syncController: controller,
      onRemoteChange: () => {}
    })
  )
  ;({ remoteStore } = result)
  bootstrapWarnings.push(
    ...events.filter(event => event.level === 'warn').map(event => event.msg)
  )
  return store
}

describe('plaintext-collection sync against web-spaces-server', () => {
  it('pushes the public payload verbatim and the private one encrypted', async () => {
    const store = await openSyncedReplica('plaintext-sync-a')
    await store.insertEntity('posts', post)
    await store.insertEntity('notes', note)

    // The public resource lands under its own logical id, plaintext.
    const publicBody = await waitFor(async () => {
      const response = await remoteStore.pws.request({
        capability: remoteStore.collectionCapability(PUBLIC_ID),
        url: `${remoteStore.spaceUrl}${PUBLIC_ID}/${post.id}`,
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
      const response = await remoteStore.pws.request({
        capability: remoteStore.collectionCapability(PRIVATE_ID),
        url: `${remoteStore.spaceUrl}${PRIVATE_ID}/${envelopeId}`,
        method: 'GET'
      })
      return response.data as { jwe?: unknown }
    }, 'the private envelope to be pushed')
    expect(typeof privateBody.jwe).toBe('object')
    expect(JSON.stringify(privateBody)).not.toContain('secret-note-marker')
  }, 60000)

  it('refuses the app its own index declaration by name, writing nothing', async () => {
    expect(refused).toMatchObject({
      collectionId: PUBLIC_ID,
      ok: false,
      status: 404,
      errorName: 'SpaceGrantRequiredError'
    })
    // No Metadata write landed: the object kept its validator and declares
    // no indexes.
    expect(beforeRefusal?.etag).toBeDefined()
    expect(afterRefusal?.etag).toBe(beforeRefusal?.etag)
    expect(afterRefusal?.description.plaintext?.indexes).toBeUndefined()
  }, 60000)

  it('leaves the public collection unmarked and finds the wallet-declared indexes', async () => {
    // The Metadata object, read the way the bootstrap reads it.
    const read = await remoteStore.readCollectionMeta(PUBLIC_ID)
    expect(read).toBeDefined()
    expect(read!.description.encryption).toBeUndefined()
    // The Space controller declared the registry's equality indexes. The sync
    // bootstrap found them in place: it wrote nothing, so the validator is
    // the one the wallet's write left, and it warned about nothing.
    expect(read!.description.plaintext?.indexes).toEqual(['title'])
    expect(read!.etag).toBe(declaredEtag)
    expect(
      bootstrapWarnings.filter(message => message.includes('declaration'))
    ).toEqual([])
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

  it('keeps replicating a public collection that holds an EDV envelope row', async () => {
    // What any grant holder can write to a public collection: a body whose
    // only members are `id` and an object `jwe`. Written straight to the
    // server, as a foreign client would, so it arrives through the pull path.
    const strayId = 'stray-envelope'
    await remoteStore.pws.request({
      capability: remoteStore.collectionCapability(PUBLIC_ID),
      url: `${remoteStore.spaceUrl}${PUBLIC_ID}/${strayId}`,
      method: 'PUT',
      json: { id: strayId, jwe: {} }
    })

    const replica = await openSyncedReplica('plaintext-sync-c')
    const syncStatus = statusStores.at(-1)!
    const pulledPosts = await waitFor(async () => {
      const listed = await replica.listEntities<PostDoc>('posts')
      return listed.length > 0 ? listed : null
    }, 'the public post to be pulled beside the stray envelope')
    // The well-formed post hydrates; the envelope row is skipped, not fatal.
    expect(pulledPosts).toEqual([post])
    const strayRow = await waitFor(
      async () => replica.rxCollection('posts').findOne(strayId).exec(),
      'the stray envelope row to be pulled'
    )
    expect(strayRow.toMutableJSON().data).toEqual({ id: strayId, jwe: {} })
    expect(await replica.listEntities<PostDoc>('posts')).toEqual([post])
    // And the collection's replication cycle completed over it.
    const status = await waitFor(async () => {
      const current = syncStatus.getState().statuses['posts']
      return current === 'synced' ? current : null
    }, 'the public collection to report synced')
    expect(status).toBe('synced')
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
    await remoteStore.pws.request({
      capability: remoteStore.collectionCapability(PUBLIC_ID),
      url: `${remoteStore.spaceUrl}${PUBLIC_ID}/policy`,
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
    expect(remoteStore.spaceUrl.startsWith(`${baseServerUrl}space/`)).toBe(true)
    expect(url).toBe(`${remoteStore.spaceUrl}${PUBLIC_ID}/${shared.id}`)

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
