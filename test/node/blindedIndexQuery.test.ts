/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * End-to-end blinded-index query against a real in-process web-spaces-server
 * (the published npm package): provisions a dev Space with a PRIVATE
 * (encrypted) collection carrying a blinded-index key, has the Space
 * controller (the stand-in for the wallet) declare the registry's index
 * attributes into the collection's encrypted metadata, writes documents
 * through the index-aware codec path, and queries them back through the
 * `blinded-index` profile -- both directly on the remote store and through
 * the app-facing entity-store verb.
 *
 * The app's Collection-scoped grant cannot write Collection Metadata, so its
 * own declaration attempt is refused by name, and its sync bootstrap finds
 * the schema in place and writes nothing.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  openTempBackend,
  startTestServer
} from '@interop/web-spaces-server/testing'
import { provisionDevGrants } from '../../src/dev/provisionDevGrants.js'
import { parseGrants, type ParsedGrants } from '../../src/grants.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { LocalStore } from '../../src/storage/localStore.js'
import { createEntityStore } from '../../src/storage/entityStore.js'
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
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import type { PwsCollectionConfig } from '../../src/config.js'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../../src/log.js'
import { withCapturedLogs } from '../fixtures/capturedLogs.js'
import { devSpaceOwner } from '../fixtures/devSpaceOwner.js'

// The SyncController wires an `online` listener on `window`; Node has no
// window, so give it an inert stand-in.
;(globalThis as { window?: unknown }).window ??= {
  addEventListener: () => {},
  removeEventListener: () => {}
}

const PRIVATE_ID = 'indexed-notes'
// A second private collection, provisioned WITHOUT a blinding key: nothing to
// install, so the bootstrap must not spend a metadata read on it.
const PLAIN_ID = 'plain-notes'
const REGISTRY: PwsCollectionConfig[] = [
  { key: 'notes', id: PRIVATE_ID, indexes: ['title'] },
  { key: 'plain', id: PLAIN_ID }
]

// A fixed 32-byte app (relying party) master seed, distinct from the other
// integration suites' so the two never share a provisioned Space.
const SEED = new Uint8Array(32).map((_, index) => (index * 7 + 11) & 0xff)

const SHARED_TITLE = 'a blinded title'

interface NoteDoc {
  // The index signature is what lets a note be handed to the codec write path
  // (`Collection.add` takes a `JsonObject`); every field here is a string.
  [field: string]: string
  id: string
  title: string
  updatedAt: string
  writerId: string
}

function makeNote(title: string): NoteDoc {
  return {
    id: crypto.randomUUID(),
    title,
    updatedAt: new Date().toISOString(),
    writerId: 'writer-test'
  }
}

let server: Awaited<ReturnType<typeof startTestServer>> | undefined
let parsed: ParsedGrants
let zcapClient: ZcapClient
let identityKeys: {
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
}
let localStore: LocalStore
let syncController: SyncController
let remoteStore: PwsRemoteStore
// The app's own declaration attempt before the wallet declared, the Metadata
// object and the schema on either side of it, and the warnings the main
// bootstrap logged.
let refused: DeclarationResult
let beforeRefusal: CollectionMetaRead | undefined
let afterRefusal: CollectionMetaRead | undefined
let schemaAfterRefusal: unknown[]
let declaredEtag: string | undefined
let bootstrapWarnings: string[]

// Two notes share a title (for paging); the third is the negative control.
const matching = [makeNote(SHARED_TITLE), makeNote(SHARED_TITLE)]
const other = makeNote('an unrelated title')

/**
 * The collection handle every codec-path write and schema read goes through:
 * the remote store's own `PwsClient`, whose keystore answers with this app's
 * identity keys, invoking the collection's delegated zcap.
 */
function collectionHandle() {
  return remoteStore.pws.spaceAt(remoteStore.spaceUrl).collection(PRIVATE_ID, {
    capability: remoteStore.collectionCapability(PRIVATE_ID)
  })
}

beforeAll(async () => {
  // The server owns the temp backend, so closing it removes the data dir.
  // Zcap invocation targets embed the port, so every client is built from the
  // `baseServerUrl` the boot returns.
  server = await startTestServer({
    backend: await openTempBackend({
      prefix: 'pws-react-blinded-',
      capacityBytes: Infinity
    })
  })
  const { baseServerUrl } = server

  // The blinding key installs with the collection's first key epoch or never.
  const provisioned = await provisionDevGrants({
    baseServerUrl,
    seed: SEED,
    collections: [
      { id: PRIVATE_ID, visibility: 'private', blindedIndex: true },
      { id: PLAIN_ID, visibility: 'private' }
    ]
  })
  parsed = parseGrants(provisioned.grants)
  const identity = await deriveIdentity({ seed: SEED })
  zcapClient = identity.zcapClient
  identityKeys = {
    keyAgreementKey: identity.keyAgreementKey,
    keyResolver: identity.keyResolver
  }

  localStore = await LocalStore.init({
    ...identityKeys,
    collections: REGISTRY,
    dbName: 'blinded-index-query'
  })
  syncController = new SyncController({
    collections: REGISTRY,
    syncStatus: createSyncStatusStore(),
    sync: { pollMs: 500, retryMs: 500 }
  })

  // The app's own attempt, under its Collection grant, while the schema is
  // still empty.
  const appStore = PwsRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections: REGISTRY,
    keys: identityKeys
  })
  const encryption = await appStore.descriptorSource.collectionEncryption({
    collectionId: PRIVATE_ID
  })
  beforeRefusal = await appStore.readCollectionMeta(PRIVATE_ID)
  refused = await appStore.declareBlindedIndexes(PRIVATE_ID, { encryption })
  afterRefusal = await appStore.readCollectionMeta(PRIVATE_ID)
  schemaAfterRefusal = await appStore.pws
    .spaceAt(appStore.spaceUrl)
    .collection(PRIVATE_ID, {
      capability: appStore.collectionCapability(PRIVATE_ID)
    })
    .indexes()

  // The wallet's declaration: the Space controller invokes as root, sealing
  // the schema to the collection's current epoch.
  const owner = await devSpaceOwner({
    baseServerUrl,
    did: provisioned.provisionerDid,
    keys: identityKeys
  })
  await owner
    .spaceAt(provisioned.spaceUrl)
    .collection(PRIVATE_ID)
    .declareIndexes({ indexes: [{ attribute: 'content.title' }] })
  declaredEtag = (await appStore.readCollectionMeta(PRIVATE_ID))?.etag

  // The bootstrap finds the schema in place and installs it on the local
  // cipher, with no declaration write of its own.
  const { result, events } = await withCapturedLogs(() =>
    startPwsSync({
      parsed,
      zcapClient,
      collections: REGISTRY,
      localStore,
      syncController,
      onRemoteChange: () => {},
      identityKeys
    })
  )
  ;({ remoteStore } = result)
  bootstrapWarnings = events
    .filter(event => event.level === 'warn')
    .map(event => event.msg)
}, 60000)

afterAll(async () => {
  await syncController?.stop()
  await localStore?.close()
  await server?.fastify.close()
}, 60000)

describe('blinded-index query against web-spaces-server', () => {
  it('refuses the app its own schema declaration by name, writing nothing', async () => {
    expect(refused).toMatchObject({
      collectionId: PRIVATE_ID,
      ok: false,
      status: 404,
      errorName: 'SpaceGrantRequiredError'
    })
    // No Metadata write landed: the object kept its validator and the schema
    // stayed empty.
    expect(beforeRefusal?.etag).toBeDefined()
    expect(afterRefusal?.etag).toBe(beforeRefusal?.etag)
    expect(schemaAfterRefusal).toEqual([])
  }, 60000)

  it('finds the wallet-declared attributes and writes nothing', async () => {
    // The schema is collection state, readable by any recipient. The attribute
    // is rooted at the EDV document's `content`, which for a JSON payload IS
    // the stored payload verbatim.
    const declared = await collectionHandle().indexes()
    expect(declared.map(entry => entry.attribute)).toEqual(['content.title'])
    // The bootstrap found it in place: the validator is the one the wallet's
    // write left, and no declaration warning was logged.
    expect((await remoteStore.readCollectionMeta(PRIVATE_ID))?.etag).toBe(
      declaredEtag
    )
    expect(
      bootstrapWarnings.filter(message => message.includes('declaration'))
    ).toEqual([])

    // Declaring again under the Collection grant is a no-op: the schema is
    // read first, nothing is missing, and no write is attempted.
    const again = await remoteStore.declareBlindedIndexes(PRIVATE_ID, {
      encryption: await remoteStore.descriptorSource.collectionEncryption({
        collectionId: PRIVATE_ID
      })
    })
    expect(again).toEqual({ collectionId: PRIVATE_ID, ok: true, wrote: false })
    const unchanged = await collectionHandle().indexes()
    expect(unchanged.map(entry => entry.attribute)).toEqual(['content.title'])
  }, 60000)

  it('finds codec-written documents by a blinded term', async () => {
    // Written through the index-aware codec path, so each stored envelope
    // carries blinded `indexed` entries alongside its ciphertext.
    for (const note of [...matching, other]) {
      await collectionHandle().add(note)
    }

    const page = await remoteStore.queryCollectionByEquality({
      collectionId: PRIVATE_ID,
      equals: { title: SHARED_TITLE }
    })
    expect(page.hasMore).toBe(false)
    expect(page.documents.map(document => document.data)).toEqual(
      expect.arrayContaining(matching)
    )
    expect(page.documents).toHaveLength(matching.length)

    // A non-matching term answers an empty page, not an error.
    const empty = await remoteStore.queryCollectionByEquality({
      collectionId: PRIVATE_ID,
      equals: { title: 'no such title' }
    })
    expect(empty).toEqual({ documents: [], hasMore: false })

    // An undeclared attribute fails closed client-side.
    await expect(
      remoteStore.queryCollectionByEquality({
        collectionId: PRIVATE_ID,
        equals: { writerId: matching[0]!.writerId }
      })
    ).rejects.toThrow(/not declared/)
  }, 60000)

  it('walks the matches a page at a time', async () => {
    const first = await remoteStore.queryCollectionByEquality({
      collectionId: PRIVATE_ID,
      equals: { title: SHARED_TITLE },
      limit: 1
    })
    expect(first.documents).toHaveLength(1)
    expect(first.hasMore).toBe(true)
    expect(typeof first.cursor).toBe('string')

    const second = await remoteStore.queryCollectionByEquality({
      collectionId: PRIVATE_ID,
      equals: { title: SHARED_TITLE },
      limit: 1,
      cursor: first.cursor as string
    })
    expect(second.documents).toHaveLength(1)
    expect(second.hasMore).toBe(false)
    // The two pages cover the match set exactly once each.
    expect([
      ...first.documents.map(document => document.data),
      ...second.documents.map(document => document.data)
    ]).toEqual(expect.arrayContaining(matching))
  }, 60000)

  it('indexes documents written through the local sync path', async () => {
    // The bootstrap installed the collection's persisted schema on the
    // replica's cipher, so an ordinary local write carries blinded `indexed`
    // entries and reaches the server findable.
    const note = makeNote('a locally written title')
    await localStore.insertEntity('notes', note)

    const envelopeId = localStore.envelopeIdFor('notes', note.id)
    expect(envelopeId).toBeDefined()
    const row = await localStore
      .rxCollection('notes')
      .findOne(envelopeId as string)
      .exec()
    const envelope = row?.toMutableJSON().data as
      { indexed?: unknown[] } | undefined
    expect(envelope?.indexed).toHaveLength(1)

    // Once replication has pushed it, the blinded query finds it like any
    // codec-written document.
    const deadline = Date.now() + 30000
    let found: unknown[] = []
    while (Date.now() < deadline && found.length === 0) {
      const page = await remoteStore.queryCollectionByEquality({
        collectionId: PRIVATE_ID,
        equals: { title: note.title }
      })
      found = page.documents
      if (found.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    expect(found).toHaveLength(1)
  }, 60000)

  it('re-reads the metadata only after a declaration that wrote', async () => {
    // A second bring-up over the same Space, watched: every granted
    // collection's object is read once by the pass, and the install re-reads
    // it only for the collection whose declaration replaced `custom`. The
    // collection with no blinding key gets the pass read and nothing more.
    const order: string[] = []
    const readMeta = PwsRemoteStore.prototype.readCollectionMeta
    const declared = vi
      .spyOn(PwsRemoteStore.prototype, 'declareBlindedIndexes')
      .mockImplementation(async function (
        this: PwsRemoteStore,
        collectionId: string
      ) {
        order.push(`declare:${collectionId}`)
        return { collectionId, ok: true, wrote: true }
      })
    const read = vi
      .spyOn(PwsRemoteStore.prototype, 'readCollectionMeta')
      .mockImplementation(async function (
        this: PwsRemoteStore,
        collectionId: string
      ) {
        order.push(`meta:${collectionId}`)
        return readMeta.call(this, collectionId)
      })
    const applied = vi.spyOn(LocalStore.prototype, 'applyCollectionMeta')

    const watchedController = new SyncController({
      collections: REGISTRY,
      syncStatus: createSyncStatusStore(),
      sync: { pollMs: 500, retryMs: 500 }
    })
    const watchedStore = await LocalStore.init({
      ...identityKeys,
      collections: REGISTRY,
      dbName: 'blinded-index-bootstrap'
    })
    try {
      await startPwsSync({
        parsed,
        zcapClient,
        collections: REGISTRY,
        localStore: watchedStore,
        syncController: watchedController,
        onRemoteChange: () => {},
        identityKeys
      })
      expect(order).toContain(`declare:${PRIVATE_ID}`)
      const privateReads = order.filter(step => step === `meta:${PRIVATE_ID}`)
      expect(privateReads).toHaveLength(2)
      expect(order.lastIndexOf(`meta:${PRIVATE_ID}`)).toBeGreaterThan(
        order.indexOf(`declare:${PRIVATE_ID}`)
      )
      // No blinding key on the second collection: the pass read only.
      expect(order.filter(step => step === `meta:${PLAIN_ID}`)).toHaveLength(1)
      expect(
        applied.mock.calls.map(([options]) => options.collectionId)
      ).toEqual([PRIVATE_ID])
    } finally {
      await watchedController.stop()
      await watchedStore.remove()
      declared.mockRestore()
      read.mockRestore()
      applied.mockRestore()
    }
  }, 60000)

  it('warns and continues when the schema install fails', async () => {
    // The pass's read is genuine (the descriptor must be real); only the
    // envelope it carries is replaced with something the cipher cannot decode.
    const readMeta = PwsRemoteStore.prototype.readCollectionMeta
    const read = vi
      .spyOn(PwsRemoteStore.prototype, 'readCollectionMeta')
      .mockImplementation(async function (
        this: PwsRemoteStore,
        collectionId: string
      ) {
        const genuine = await readMeta.call(this, collectionId)
        return (
          genuine && {
            ...genuine,
            description: {
              ...genuine.description,
              custom: { not: 'an envelope' } as unknown as NonNullable<
                typeof genuine.description.custom
              >
            }
          }
        )
      })
    const applied = vi
      .spyOn(LocalStore.prototype, 'applyCollectionMeta')
      .mockRejectedValue(new Error('undecodable metadata envelope'))
    const capture = captureLogger('pr')
    const previous = setLogger(capture.logger)

    const watchedController = new SyncController({
      collections: REGISTRY,
      syncStatus: createSyncStatusStore(),
      sync: { pollMs: 500, retryMs: 500 }
    })
    const watchedStore = await LocalStore.init({
      ...identityKeys,
      collections: REGISTRY,
      dbName: 'blinded-index-bootstrap-failure'
    })
    try {
      // The bootstrap still resolves: the install is best-effort like every
      // other declaration on this pass.
      const bootstrap = await startPwsSync({
        parsed,
        zcapClient,
        collections: REGISTRY,
        localStore: watchedStore,
        syncController: watchedController,
        onRemoteChange: () => {},
        identityKeys
      })
      expect(bootstrap.remoteStore).toBeDefined()
      expect(
        capture.events.some(event =>
          event.msg.includes('Blinded-index schema install failed')
        )
      ).toBe(true)
    } finally {
      await watchedController.stop()
      await watchedStore.remove()
      read.mockRestore()
      applied.mockRestore()
      setLogger(previous)
    }
  }, 60000)

  it('answers the entity-store query verb end to end', async () => {
    // The app-facing verb, through the storage context: key routing, the
    // blinded query, and the decrypted-payload mapping.
    const context = new StorageContext({
      registry: {},
      writerId: 'test-writer'
    })
    context.attachStore(localStore)
    context.attachRemoteStore(remoteStore)
    try {
      const notes = createEntityStore<NoteDoc>('notes')
      const result = await notes
        .getState()
        .query({ equals: { title: SHARED_TITLE } })
      expect(result.hasMore).toBe(false)
      expect(result.docs).toEqual(expect.arrayContaining(matching))
      expect(result.docs).toHaveLength(matching.length)
    } finally {
      context.detachStore()
      context.detachRemoteStore()
      deactivateStorageContext(context)
    }
  }, 60000)
})
