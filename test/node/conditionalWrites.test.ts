/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Conditional-write (`If-Match` / `If-None-Match`) coverage for the push side of
 * the sync adapter, driven against a REAL in-process web-spaces-server and a
 * REAL encrypted collection: a dev Space is provisioned with a private
 * (EDV-encrypted) collection, every pushed body is a genuine EDV envelope sealed
 * under the collection's key epoch, and the sync port is the one the sync
 * controller builds (`createPwsSyncPort` wrapped in `withFeedPrimaryRead`).
 *
 * The assumption under test, in one line: a write precondition APPLIES on an
 * encrypted collection, so a lost race answers `412` and `pushWrites` turns it
 * into an RxDB conflict entry carrying the current primary state. The fake-port
 * unit suite lives in `@interop/pws-sync`; these tests
 * assert that a real encrypted collection actually produces the `412` the
 * mapping is written for.
 *
 * A note on where `@interop/was-client` 0.42.0 fits, since its release notes
 * name this behavior: what 0.42.0 fixed is the CODEC-driven handle API
 * (`Resource.put({ ifMatch })`), which used to drop the caller's precondition
 * on an encrypted collection. Replication never travels that path -- the sync
 * port writes verbatim through `pws.request()` with the precondition headers
 * set directly, and the server evaluates them without regard to encryption.
 * These tests are what establishes that, rather than leaving the two paths
 * conflated.
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openTempBackend,
  startTestServer
} from '@interop/web-spaces-server/testing'
import type { WithDeleted } from 'rxdb/plugins/core'
import { provisionDevGrants } from '../../src/dev/provisionDevGrants.js'
import { parseGrants } from '../../src/grants.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { PwsRemoteStore } from '../../src/storage/pwsRemoteStore.js'
import {
  makeLwwConflictHandler,
  type Json,
  type SyncedDoc,
  // pws-sync still exports this type under its former prefix.
  type WasSyncPort as PwsSyncPort
} from '@interop/pws-sync'
import type { WriteAck } from '@interop/pws-client/sync'
import {
  createPushHandler,
  withFeedPrimaryRead,
  type PushWriteAck
} from '@interop/pws-sync/rxdb'
import { hasKeyEpochs } from '@interop/pws-client/edv'
import { createDocCipher, type DocCipher } from '../../src/storage/docCipher.js'
import { createPwsSyncPort } from '../../src/storage/pwsSyncPort.js'
import type { PwsCollectionConfig } from '../../src/config.js'

const PRIVATE_ID = 'conflict-notes'
const REGISTRY: PwsCollectionConfig[] = [{ key: 'notes', id: PRIVATE_ID }]

// A fixed 32-byte app (relying party) master seed, distinct from the other
// integration suites' so the two never share a provisioned Space.
const SEED = new Uint8Array(32).map((_, index) => (index * 17 + 3) & 0xff)

const WRITER_ID = 'writer-conditional'

/**
 * A push row as RxDB hands one to the push handler: the new local state, plus
 * the master state the replica believes it is editing (absent on a create).
 */
interface PushRow {
  newDocumentState: WithDeleted<SyncedDoc>
  assumedMasterState?: WithDeleted<SyncedDoc>
}

/**
 * A sealed payload as the document cipher returns it: the random envelope id,
 * the EDV envelope that travels as the stored body, and the key epoch it was
 * sealed under.
 */
interface Sealed {
  id: string
  envelope: Json
  epoch?: string
}

let server: Awaited<ReturnType<typeof startTestServer>> | undefined
let remoteStore: PwsRemoteStore
let cipher: DocCipher
let port: PwsSyncPort

beforeAll(async () => {
  // The server owns the temp backend, so closing it removes the data dir.
  // Zcap invocation targets embed the port, so every client is built from the
  // `baseServerUrl` the boot returns.
  server = await startTestServer({
    backend: await openTempBackend({
      prefix: 'was-react-conditional-',
      capacityBytes: Infinity
    })
  })
  const { baseServerUrl } = server

  const provisioned = await provisionDevGrants({
    baseServerUrl,
    seed: SEED,
    collections: [{ id: PRIVATE_ID, visibility: 'private' }]
  })
  const parsed = parseGrants(provisioned.grants)
  const { zcapClient, keyAgreementKey, keyResolver } = await deriveIdentity({
    seed: SEED
  })
  remoteStore = PwsRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections: REGISTRY,
    keys: { keyAgreementKey, keyResolver }
  })

  // The collection is genuinely encrypted: it carries a key-epoch roster from
  // provisioning, and the cipher below seals every body under it.
  const encryption = await remoteStore.descriptorSource.collectionEncryption({
    collectionId: PRIVATE_ID
  })
  expect(encryption).toBeDefined()
  expect(hasKeyEpochs(encryption)).toBe(true)
  cipher = await createDocCipher({
    keyAgreementKey,
    keyResolver,
    collectionId: PRIVATE_ID,
    encryption: encryption!
  })

  // The exact port the sync controller builds for a granted collection.
  port = withFeedPrimaryRead(
    createPwsSyncPort({
      pws: remoteStore.pws,
      spaceUrl: remoteStore.spaceUrl,
      collectionId: PRIVATE_ID,
      capability: remoteStore.collectionCapability(PRIVATE_ID)!
    })
  )
}, 60000)

afterAll(async () => {
  await server?.fastify.close()
}, 60000)

/**
 * An LWW-stamped app payload (the plaintext that goes inside an envelope).
 *
 * @param options {object}
 * @param options.title {string}
 * @param options.updatedAt {string}
 * @returns {Json}
 */
function payload({
  title,
  updatedAt
}: {
  title: string
  updatedAt: string
}): Json {
  return { id: crypto.randomUUID(), title, updatedAt, writerId: WRITER_ID }
}

/**
 * Runs one push batch through a fresh push handler, collecting the write acks
 * the handler reports out-of-band.
 *
 * @param rows {PushRow[]}
 * @returns {Promise<{ conflicts: WithDeleted<SyncedDoc>[], acks: PushWriteAck[] }>}
 */
async function runPush(rows: PushRow[]): Promise<{
  conflicts: WithDeleted<SyncedDoc>[]
  acks: PushWriteAck[]
}> {
  const acks: PushWriteAck[] = []
  const push = createPushHandler({
    port,
    async onWriteAccepted(ack) {
      acks.push(ack)
    }
  })
  const conflicts = await push(rows)
  return { conflicts, acks }
}

/**
 * The local row shape a sealed envelope travels in.
 *
 * @param options {object}
 * @param options.sealed {Sealed}
 * @param options.updatedAt {string}
 * @param [options.etag] {string}   the opaque content validator the push
 *   handler echoes as `If-Match`; a row without one pushes unconditionally
 * @param [options.custom] {Json}
 * @returns {WithDeleted<SyncedDoc>}
 */
function row({
  sealed,
  updatedAt,
  etag,
  custom
}: {
  sealed: Sealed
  updatedAt: string
  etag?: string
  custom?: Json
}): WithDeleted<SyncedDoc> {
  return {
    id: sealed.id,
    updatedAt,
    _deleted: false,
    data: sealed.envelope,
    ...(sealed.epoch !== undefined && { epoch: sealed.epoch }),
    ...(etag !== undefined && { etag }),
    ...(custom !== undefined && { custom })
  }
}

/**
 * Creates one resource through the push handler (the `If-None-Match: *` create
 * path) and returns the sealed body plus the content ack: the server's write
 * stamp and the opaque `ETag` a later conditional write echoes back.
 *
 * @param options {object}
 * @param options.title {string}
 * @param options.updatedAt {string}
 * @returns {Promise<{ sealed: Sealed, ack: WriteAck }>}
 */
async function createRow({
  title,
  updatedAt
}: {
  title: string
  updatedAt: string
}): Promise<{ sealed: Sealed; ack: WriteAck }> {
  const sealed = await cipher.encrypt({ data: payload({ title, updatedAt }) })
  const { conflicts, acks } = await runPush([
    { newDocumentState: row({ sealed, updatedAt }) }
  ])
  expect(conflicts).toEqual([])
  const ack = acks[0]?.content
  expect(ack?.updatedAtCounter).toBeTypeOf('number')
  expect(ack?.originId).toBeTypeOf('string')
  expect(ack?.etag).toBeTypeOf('string')
  return { sealed, ack: ack! }
}

/**
 * A sealed metadata body. On an encrypted collection the server requires the
 * user-writable `custom` to be a structurally valid encryption envelope, so a
 * `/meta` body is sealed exactly like a content body. Returns the id it was
 * sealed under alongside the envelope, since a later decrypt of it must be
 * addressed under that same id.
 *
 * @param label {string}
 * @returns {Promise<{ id: string; envelope: Json }>}
 */
async function sealedMeta(
  label: string
): Promise<{ id: string; envelope: Json }> {
  return await cipher.encrypt({ data: { label } })
}

describe('conditional writes against an encrypted collection', () => {
  it('reports a stale If-Match as a conflict carrying the current master', async () => {
    // Protects: since was-client 0.42.0 an `If-Match` precondition APPLIES on an
    // encrypted collection. A stale baseline must lose the write and come back
    // as an RxDB conflict entry -- not throw, and not silently overwrite the
    // winner (the pre-0.42.0 last-write-wins degradation).
    const base = await createRow({
      title: 'the original',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })

    // Another replica commits an update against the current baseline.
    const winnerPayload = payload({
      title: 'the winner',
      updatedAt: '2026-01-01T00:02:00.000Z'
    })
    const winner = await cipher.encryptUpdate({
      id: base.sealed.id,
      data: winnerPayload,
      current: base.sealed.envelope
    })
    const winnerAck = await port.putContent({
      id: winner.id,
      data: winner.envelope,
      ifMatch: base.ack.etag,
      ...(winner.epoch !== undefined && { epoch: winner.epoch })
    })
    expect(winnerAck.updatedAtCounter).toBeTypeOf('number')

    // This replica still believes the baseline it created, and pushes over it.
    const loser = await cipher.encryptUpdate({
      id: base.sealed.id,
      data: payload({
        title: 'the loser',
        updatedAt: '2026-01-01T00:01:00.000Z'
      }),
      current: base.sealed.envelope
    })
    const assumed = row({
      sealed: base.sealed,
      updatedAt: '2026-01-01T00:00:00.000Z',
      etag: base.ack.etag
    })
    const { conflicts } = await runPush([
      {
        newDocumentState: row({
          sealed: loser,
          updatedAt: '2026-01-01T00:01:00.000Z'
        }),
        assumedMasterState: assumed
      }
    ])

    expect(conflicts).toHaveLength(1)
    const conflict = conflicts[0]!
    expect(conflict.id).toBe(base.sealed.id)
    expect(conflict._deleted).toBe(false)
    expect(conflict.updatedAtCounter).toBe(winnerAck.updatedAtCounter)
    expect(conflict.originId).toBe(winnerAck.originId)
    // The conflict entry carries the WINNER's envelope, which decrypts under
    // this app's identity key: the stale write did not land.
    expect(
      await cipher.decrypt({ id: conflict.id, envelope: conflict.data! })
    ).toEqual(winnerPayload)
  }, 60000)

  it('reports a second create-if-absent as a conflict', async () => {
    // Protects: the `If-None-Match: *` half of the same assumption. A second
    // create of an id that already exists must be refused by the server (412)
    // and surface as a conflict entry, rather than clobbering the existing row.
    const base = await createRow({
      title: 'created once',
      updatedAt: '2026-02-01T00:00:00.000Z'
    })
    const original = await cipher.decrypt({
      id: base.sealed.id,
      envelope: base.sealed.envelope
    })

    // A second replica that has never seen this resource pushes it as a create.
    const duplicate = await cipher.encryptUpdate({
      id: base.sealed.id,
      data: payload({
        title: 'created twice',
        updatedAt: '2026-02-01T00:01:00.000Z'
      }),
      current: base.sealed.envelope
    })
    const { conflicts } = await runPush([
      {
        newDocumentState: row({
          sealed: duplicate,
          updatedAt: '2026-02-01T00:01:00.000Z'
        })
      }
    ])

    expect(conflicts).toHaveLength(1)
    const conflict = conflicts[0]!
    expect(conflict.id).toBe(base.sealed.id)
    expect(conflict._deleted).toBe(false)
    expect(conflict.updatedAtCounter).toBe(base.ack.updatedAtCounter)
    expect(conflict.originId).toBe(base.ack.originId)
    expect(
      await cipher.decrypt({ id: conflict.id, envelope: conflict.data! })
    ).toEqual(original)
  }, 60000)

  it('reports a rejected /meta precondition as a conflict, not a throw', async () => {
    // Protects: the metadata half of a synced document is independently
    // versioned and carries its OWN precondition (`pushWrites.ts` lines
    // 237-239), which since was-client 0.42.0 applies on an encrypted
    // collection like the content half's. Both forms -- `If-None-Match: *`
    // when the replica believes no metadata exists, and a stale `If-Match` on
    // the metadata validator -- must come back as conflict entries rather than
    // propagating an error out of the push handler.
    const base = await createRow({
      title: 'with metadata',
      updatedAt: '2026-03-01T00:00:00.000Z'
    })
    const assumedNoMeta = row({
      sealed: base.sealed,
      updatedAt: '2026-03-01T00:00:00.000Z',
      etag: base.ack.etag
    })
    // On an encrypted collection the server refuses a plaintext `custom`, so
    // every metadata body here is a sealed envelope like the content bodies.
    const [first, second, third, stale] = await Promise.all([
      sealedMeta('first'),
      sealedMeta('second'),
      sealedMeta('third'),
      sealedMeta('stale')
    ])

    // First metadata write: the content half is unchanged, so only `/meta` is
    // written, with `If-None-Match: *`.
    const written = await runPush([
      {
        newDocumentState: { ...assumedNoMeta, custom: first.envelope },
        assumedMasterState: assumedNoMeta
      }
    ])
    expect(written.conflicts).toEqual([])
    const metaStamp = written.acks[0]?.meta?.meta
    expect(metaStamp?.generation).toBeTypeOf('string')
    const metaEtag = written.acks[0]?.meta?.etag
    expect(metaEtag).toBeTypeOf('string')

    // A replica that still believes there is no metadata: `If-None-Match: *`
    // now fails against the metadata just written.
    const duplicate = await runPush([
      {
        newDocumentState: { ...assumedNoMeta, custom: second.envelope },
        assumedMasterState: assumedNoMeta
      }
    ])
    expect(duplicate.conflicts).toHaveLength(1)
    expect(duplicate.conflicts[0]!.meta).toEqual(metaStamp)
    expect(
      await cipher.decrypt({
        id: first.id,
        envelope: duplicate.conflicts[0]!.custom!
      })
    ).toEqual({ label: 'first' })

    // Another replica commits a metadata update, moving the `/meta` stamp on.
    const bumped = (
      await port.putMeta({
        id: base.sealed.id,
        custom: third.envelope,
        ifMatch: metaEtag!
      })
    )?.meta
    expect(bumped?.generation).toBeTypeOf('string')

    // A stale `If-Match` on the metadata validator is refused the same way.
    const assumedStaleMeta: WithDeleted<SyncedDoc> = {
      ...assumedNoMeta,
      meta: metaStamp!,
      metaEtag: metaEtag!,
      custom: first.envelope
    }
    const lost = await runPush([
      {
        newDocumentState: { ...assumedStaleMeta, custom: stale.envelope },
        assumedMasterState: assumedStaleMeta
      }
    ])
    expect(lost.conflicts).toHaveLength(1)
    expect(lost.conflicts[0]!.meta).toEqual(bumped)
    expect(
      await cipher.decrypt({
        id: third.id,
        envelope: lost.conflicts[0]!.custom!
      })
    ).toEqual({ label: 'third' })
  }, 60000)

  it('settles a concurrent push race into one resolvable conflict', async () => {
    // Protects: two replicas pushing the same baseline concurrently must
    // produce exactly one 412, reported as a conflict entry RxDB's conflict
    // handler can resolve -- never an unhandled rejection out of the push
    // handler. Both pushes go through the same port, as two replication cycles
    // of one session would.
    const base = await createRow({
      title: 'contested',
      updatedAt: '2026-04-01T00:00:00.000Z'
    })
    const assumed = row({
      sealed: base.sealed,
      updatedAt: '2026-04-01T00:00:00.000Z',
      etag: base.ack.etag
    })

    const earlierAt = '2026-04-01T00:01:00.000Z'
    const laterAt = '2026-04-01T00:02:00.000Z'
    const [earlier, later] = await Promise.all([
      cipher.encryptUpdate({
        id: base.sealed.id,
        data: payload({ title: 'earlier edit', updatedAt: earlierAt }),
        current: base.sealed.envelope
      }),
      cipher.encryptUpdate({
        id: base.sealed.id,
        data: payload({ title: 'later edit', updatedAt: laterAt }),
        current: base.sealed.envelope
      })
    ])

    const rows: PushRow[] = [
      {
        newDocumentState: row({
          sealed: earlier,
          updatedAt: earlierAt
        }),
        assumedMasterState: assumed
      },
      {
        newDocumentState: row({
          sealed: later,
          updatedAt: laterAt
        }),
        assumedMasterState: assumed
      }
    ]
    const results = await Promise.all(rows.map(async each => runPush([each])))
    const conflicts = results.flatMap(result => result.conflicts)

    // Exactly one of the two writes won; the other came back as a conflict.
    expect(conflicts).toHaveLength(1)
    const loserIndex = results.findIndex(result => result.conflicts.length > 0)
    const conflict = conflicts[0]!
    expect(conflict.id).toBe(base.sealed.id)

    // The conflict entry is the input RxDB's LWW handler is written for: it
    // resolves to a real document rather than throwing. The closure is called
    // with each side's own row id (never one read out of the decrypted
    // payload), the same shape `localStore.ts`'s conflict handler wires.
    const handler = makeLwwConflictHandler(({ id, envelope }) =>
      cipher.decrypt({ id, envelope })
    )
    const resolved = await handler.resolve({
      realMasterState: conflict,
      newDocumentState: rows[loserIndex]!.newDocumentState,
      assumedMasterState: assumed
    })
    // Later `updatedAt` wins, whichever push lost the race.
    const winning = await cipher.decrypt({
      id: resolved.id,
      envelope: resolved.data!
    })
    expect((winning as { title: string }).title).toBe('later edit')
  }, 60000)
})
