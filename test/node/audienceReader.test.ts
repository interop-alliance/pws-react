/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * `AudienceReader` against a real in-process web-spaces-server: an owner
 * provisions a plaintext audience collection in its own Space, delegates a
 * GET and HEAD zcap on it to a subscriber, and the subscriber's reader follows
 * the collection's `changes` feed through the GET form, falls back to the
 * listing when the feed is refused, and pauses and resumes across a cut.
 *
 * The audience lives on a server of its own, separate from the one the app's
 * own grants name, since a subscriber reads another owner's Space.
 *
 * @vitest-environment node
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import {
  openTempBackend,
  startTestServer
} from '@interop/web-spaces-server/testing'
import {
  PwsClient,
  type ActionInput,
  type Collection,
  type IDelegatedZcap,
  type ISigner,
  type IZcap
} from '@interop/pws-client'
import {
  collectionUrl,
  rootCapability,
  rootCapabilityId
} from '@interop/pws-client/paths'
import { CapabilityAgent } from '@interop/capability-agent'
import { captureLogger } from '@interop/logger'
import { provisionDevGrants } from '../../src/dev/provisionDevGrants.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { parseGrants } from '../../src/grants.js'
import { AudienceReader } from '../../src/storage/audienceReader.js'
import { setLogger } from '../../src/log.js'

function testSeed(step: number, offset: number): Uint8Array {
  return new Uint8Array(32).map((_, index) => (index * step + offset) & 0xff)
}

const OWNER_SEED = testSeed(5, 11)
const SUBSCRIBER_SEED = testSeed(7, 3)
const APP_SEED = testSeed(13, 5)

type TestServer = Awaited<ReturnType<typeof startTestServer>>

let audienceServer: TestServer | undefined
let appServer: TestServer | undefined
let appServerUrl: string
let owner: PwsClient
let ownerDid: string
let spaceUrl: string
let signer: ISigner
let subscriberDid: string
let audienceCount = 0

beforeAll(async () => {
  ;[audienceServer, appServer] = await Promise.all([
    startTestServer({
      backend: await openTempBackend({
        prefix: 'pws-react-audience-',
        capacityBytes: Infinity
      })
    }),
    startTestServer({
      backend: await openTempBackend({
        prefix: 'pws-react-audience-app-',
        capacityBytes: Infinity
      })
    })
  ])
  appServerUrl = appServer.baseServerUrl
  const ownerAgent = await CapabilityAgent.fromSeed({
    seed: OWNER_SEED,
    handle: 'audience-owner',
    keyName: 'owner-key'
  })
  ownerDid = ownerAgent.id
  owner = PwsClient.fromSigner({
    baseServerUrl: audienceServer.baseServerUrl,
    signer: ownerAgent.getSigner()
  })
  const space = await owner.createSpace({
    name: 'Audience Space',
    controller: ownerDid
  })
  spaceUrl = space.url
  const subscriber = await deriveIdentity({ seed: SUBSCRIBER_SEED })
  signer = subscriber.keyAgent.getSigner()
  subscriberDid = subscriber.controllerDid
}, 60000)

afterAll(async () => {
  await Promise.all([
    audienceServer?.fastify.close(),
    appServer?.fastify.close()
  ])
}, 60000)

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Creates a fresh plaintext audience collection in the owner's Space and
 * delegates a GET and HEAD zcap on it to the subscriber.
 */
async function provisionAudience(): Promise<{
  collection: Collection
  collectionId: string
  target: string
  grant: () => Promise<IDelegatedZcap>
}> {
  const collectionId = `audience-${audienceCount++}`
  const collection = await owner
    .spaceAt(spaceUrl)
    .createCollection({ id: collectionId, name: collectionId })
  const target = collectionUrl({ spaceUrl, collectionId })
  const spaceRoot = rootCapability({
    target: spaceUrl,
    controller: ownerDid
  })
  const grant = () =>
    owner.grant({
      to: subscriberDid,
      // The server accepts HEAD even though storage-core's ActionInput union
      // omits it, hence the assertion.
      actions: ['GET', 'HEAD'] as ActionInput[],
      target,
      capability: spaceRoot
    })
  return { collection, collectionId, target, grant }
}

/**
 * Runs `run` with the library's logger captured, restoring the previous one
 * afterwards.
 */
async function withCapturedLogs<T>(
  run: () => Promise<T>
): Promise<{ result: T; events: ReturnType<typeof captureLogger>['events'] }> {
  const capture = captureLogger('pr')
  const previous = setLogger(capture.logger)
  try {
    return { result: await run(), events: capture.events }
  } finally {
    setLogger(previous)
  }
}

/**
 * Records every request `fetch` sends while `run` executes, and optionally
 * answers the collection's `query` endpoint with `queryStatus` instead of
 * forwarding it.
 */
async function withFetchProbe<T>(
  run: () => Promise<T>,
  {
    queryStatus,
    queryStatusAt
  }: { queryStatus?: number; queryStatusAt?: number } = {}
): Promise<{ result: T; requests: Array<{ method: string; url: string }> }> {
  const requests: Array<{ method: string; url: string }> = []
  const realFetch = globalThis.fetch
  let queries = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase()
    requests.push({ method, url })
    if (queryStatus !== undefined && new URL(url).pathname.endsWith('/query')) {
      queries += 1
      if (queryStatusAt === undefined || queries === queryStatusAt) {
        return new Response(null, { status: queryStatus })
      }
    }
    return realFetch(input, init)
  })
  const result = await run()
  return { result, requests }
}

describe('AudienceReader.open', () => {
  it('refuses a zcap whose target is not a collection', async () => {
    const spaceZcap = {
      parentCapability: rootCapabilityId(spaceUrl),
      invocationTarget: spaceUrl
    } as IZcap
    expect(() => AudienceReader.open({ zcap: spaceZcap, signer })).toThrow(
      /must name a collection/
    )
    const resourceZcap = {
      parentCapability: rootCapabilityId(spaceUrl),
      invocationTarget: `${collectionUrl({ spaceUrl, collectionId: 'c' })}r`
    } as IZcap
    expect(() => AudienceReader.open({ zcap: resourceZcap, signer })).toThrow(
      /must name a collection/
    )
  })

  it('reads a target on a host other than the one the app is granted', async () => {
    const provisioned = await provisionDevGrants({
      baseServerUrl: appServerUrl,
      seed: APP_SEED,
      collections: [{ id: 'posts', visibility: 'public' }]
    })
    const appGrants = parseGrants(provisioned.grants)
    const { grant, collection } = await provisionAudience()
    await collection.put('p1', { postId: 'post-1', body: 'hello' })
    const reader = AudienceReader.open({ zcap: await grant(), signer })
    expect(reader.spaceUrl).toBe(spaceUrl)
    expect(reader.spaceUrl).not.toBe(appGrants.spaceUrl)
    const { changes } = await reader.pull()
    expect(changes).toEqual([
      { id: 'p1', deleted: false, data: { postId: 'post-1', body: 'hello' } }
    ])
  }, 60000)
})

describe('AudienceReader.pull (feed path)', () => {
  it('follows the GET-form feed from a checkpoint and keeps resources only', async () => {
    const { grant, collection } = await provisionAudience()
    await collection.put('p1', { postId: 'post-1', body: 'one' })
    await collection.put('p2', { postId: 'post-2', body: 'two' })
    const reader = AudienceReader.open({ zcap: await grant(), signer })

    const { result: first, requests } = await withFetchProbe(() =>
      reader.pull()
    )
    expect(first.snapshot).toBe(false)
    expect(first.paused).toBe(false)
    // The collection's own records ride the feed too; only resources surface.
    expect(first.changes).toEqual([
      { id: 'p1', deleted: false, data: { postId: 'post-1', body: 'one' } },
      { id: 'p2', deleted: false, data: { postId: 'post-2', body: 'two' } }
    ])
    const queries = requests.filter(req => req.url.includes('/query'))
    expect(queries.length).toBeGreaterThan(0)
    for (const query of queries) {
      expect(query.method).toBe('GET')
      expect(new URL(query.url).searchParams.get('profile')).toBe('changes')
    }
    expect(reader.checkpoint).not.toBeNull()

    // A second pull is a delta: the new post and the tombstone, nothing else.
    const checkpoint = reader.checkpoint
    await collection.put('p3', { postId: 'post-3', body: 'three' })
    await collection.resource('p1').delete()
    const second = await reader.pull()
    expect(second.changes.map(change => change.id).sort()).toEqual(['p1', 'p3'])
    expect(second.changes.find(change => change.id === 'p1')).toEqual({
      id: 'p1',
      deleted: true
    })
    expect(reader.checkpoint).not.toBe(checkpoint)

    // Nothing changed: an empty delta, and the checkpoint stands.
    const third = await reader.pull()
    expect(third.changes).toEqual([])
  }, 60000)

  it('resumes from a checkpoint handed to open()', async () => {
    const { grant, collection } = await provisionAudience()
    await collection.put('p1', { postId: 'post-1' })
    const zcap = await grant()
    const first = AudienceReader.open({ zcap, signer })
    await first.pull()
    await collection.put('p2', { postId: 'post-2' })
    const second = AudienceReader.open({
      zcap,
      signer,
      checkpoint: first.checkpoint
    })
    const { changes } = await second.pull()
    expect(changes.map(change => change.id)).toEqual(['p2'])
  }, 60000)

  it('pages through the feed with the configured page size', async () => {
    const { grant, collection } = await provisionAudience()
    for (const index of [1, 2, 3]) {
      await collection.put(`p${index}`, { postId: `post-${index}` })
    }
    const reader = AudienceReader.open({
      zcap: await grant(),
      signer,
      pageSize: 1
    })
    const { result, requests } = await withFetchProbe(() => reader.pull())
    expect(result.changes.map(change => change.id)).toEqual(['p1', 'p2', 'p3'])
    // One page per post, the Collection's own records on pages of their own,
    // and the empty page that ends the walk.
    expect(
      requests.filter(req => req.url.includes('/query')).length
    ).toBeGreaterThanOrEqual(4)
  }, 60000)
})

describe('AudienceReader.pull (listing fallback)', () => {
  for (const status of [405, 501]) {
    it(`falls back to the listing on a ${status} from the feed`, async () => {
      const { grant, collection, collectionId } = await provisionAudience()
      await collection.put('p1', { postId: 'post-1' })
      await collection.put('p2', { postId: 'post-2' })
      const reader = AudienceReader.open({ zcap: await grant(), signer })
      const { result, events } = await withCapturedLogs(() =>
        withFetchProbe(
          async () => {
            const first = await reader.pull()
            const second = await reader.pull()
            return { first, second }
          },
          { queryStatus: status }
        )
      )
      const { result: pulls, requests } = result
      for (const pull of [pulls.first, pulls.second]) {
        expect(pull.snapshot).toBe(true)
        expect(pull.paused).toBe(false)
        expect(
          [...pull.changes].sort((left, right) =>
            left.id.localeCompare(right.id)
          )
        ).toEqual([
          { id: 'p1', deleted: false, data: { postId: 'post-1' } },
          { id: 'p2', deleted: false, data: { postId: 'post-2' } }
        ])
      }
      // The feed is tried once; the second pull goes to the listing.
      expect(requests.filter(req => req.url.includes('/query')).length).toBe(1)
      expect(reader.checkpoint).toBeNull()
      const warned = events.filter(
        event =>
          event.level === 'warn' && event.data?.collectionId === collectionId
      )
      expect(warned).toHaveLength(1)
      expect(warned[0]?.data?.status).toBe(status)
    }, 60000)
  }
})

describe('AudienceReader cut and resume', () => {
  it('pauses on a revoked zcap, keeps the checkpoint, and resumes under a replacement', async () => {
    const { grant, collection, target } = await provisionAudience()
    await collection.put('p1', { postId: 'post-1' })
    const zcap = await grant()
    const reader = AudienceReader.open({ zcap, signer })
    await reader.pull()
    const checkpoint = reader.checkpoint
    expect(checkpoint).not.toBeNull()

    await owner.revoke(zcap)
    await collection.put('p2', { postId: 'post-2' })
    const { result: cut, events } = await withCapturedLogs(() => reader.pull())
    expect(cut).toEqual({ changes: [], snapshot: false, paused: true })
    // PWS masks a denial as a 404 and names the cause when the request
    // itself verified.
    expect(events.map(event => [event.level, event.data?.cause])).toEqual([
      ['warn', 'CapabilityRevokedError']
    ])
    expect(reader.paused).toBe(true)
    expect(reader.checkpoint).toBe(checkpoint)
    expect(await reader.get('p1')).toBeUndefined()

    // Paused: no request leaves until a replacement arrives.
    const { requests } = await withFetchProbe(() => reader.pull())
    expect(requests).toEqual([])

    const wrongTarget = { ...(await grant()), invocationTarget: `${target}x/` }
    expect(() => reader.replaceCapability({ zcap: wrongTarget })).toThrow(
      /must target/
    )
    expect(reader.paused).toBe(true)

    // Same target, but a chain rooted at the collection itself rather than
    // this reader's Space: refused before anything on the reader changes.
    const collectionRooted = {
      ...(await grant()),
      parentCapability: rootCapabilityId(target),
      proof: {}
    } as unknown as IZcap
    expect(() => reader.replaceCapability({ zcap: collectionRooted })).toThrow(
      /must root in the Space/
    )
    expect(reader.paused).toBe(true)
    expect(reader.checkpoint).toBe(checkpoint)

    reader.replaceCapability({ zcap: await grant() })
    expect(reader.paused).toBe(false)
    const resumed = await reader.pull()
    expect(resumed.paused).toBe(false)
    expect(resumed.changes.map(change => change.id)).toEqual(['p2'])
    expect(await reader.get('p1')).toEqual({ postId: 'post-1' })
  }, 60000)

  it('get() alone detects the masked-404 cut and pauses the reader', async () => {
    const { grant, collection } = await provisionAudience()
    await collection.put('p1', { postId: 'post-1' })
    const zcap = await grant()
    const reader = AudienceReader.open({ zcap, signer })
    expect(await reader.get('p1')).toEqual({ postId: 'post-1' })
    // A genuine miss stays a miss and pauses nothing.
    expect(await reader.get('nope')).toBeUndefined()
    expect(reader.paused).toBe(false)

    await owner.revoke(zcap)
    // pws-client answers the masked 404 of a body read as null; the reader
    // settles it against the container and pauses.
    expect(await reader.get('p1')).toBeUndefined()
    expect(reader.paused).toBe(true)
  }, 60000)

  it('a cut mid-walk returns the pages read with their checkpoint', async () => {
    const { grant, collection } = await provisionAudience()
    for (const index of [1, 2, 3]) {
      await collection.put(`p${index}`, { postId: `post-${index}` })
    }
    const zcap = await grant()
    const reader = AudienceReader.open({ zcap, signer, pageSize: 1 })
    // The third feed page is denied (the masked 404): the Collection's own
    // metadata record fills the first one-entry page, the first post the
    // second.
    const { result } = await withFetchProbe(() => reader.pull(), {
      queryStatus: 404,
      queryStatusAt: 3
    })
    expect(result.paused).toBe(true)
    expect(result.changes.map(change => change.id)).toEqual(['p1'])
    expect(reader.checkpoint).not.toBeNull()

    // The resumed walk picks up exactly after what was delivered.
    reader.replaceCapability({ zcap: await grant() })
    const resumed = await reader.pull()
    expect(resumed.changes.map(change => change.id)).toEqual(['p2', 'p3'])
  }, 60000)

  it('a non-cut failure mid-walk leaves the checkpoint where the pull began', async () => {
    const { grant, collection } = await provisionAudience()
    for (const index of [1, 2, 3]) {
      await collection.put(`p${index}`, { postId: `post-${index}` })
    }
    const reader = AudienceReader.open({
      zcap: await grant(),
      signer,
      pageSize: 1
    })
    // 418 is neither a cut, a feed refusal, nor a status the HTTP client
    // retries. It lands after the first post's page.
    await expect(
      withFetchProbe(() => reader.pull(), {
        queryStatus: 418,
        queryStatusAt: 3
      })
    ).rejects.toThrow()
    expect(reader.checkpoint).toBeNull()
    expect(reader.paused).toBe(false)
    const { changes } = await reader.pull()
    expect(changes.map(change => change.id)).toEqual(['p1', 'p2', 'p3'])
  }, 60000)

  it('the listing fallback detects the cut instead of answering an empty snapshot', async () => {
    const { grant, collection } = await provisionAudience()
    await collection.put('p1', { postId: 'post-1' })
    const zcap = await grant()
    const reader = AudienceReader.open({ zcap, signer })
    const { result: first } = await withFetchProbe(() => reader.pull(), {
      queryStatus: 501
    })
    expect(first.snapshot).toBe(true)
    expect(first.changes.map(change => change.id)).toEqual(['p1'])

    await owner.revoke(zcap)
    // A denied read is never a snapshot: a consumer applying one would
    // drop every post it holds.
    const cut = await reader.pull()
    expect(cut).toEqual({ changes: [], snapshot: false, paused: true })
    expect(reader.paused).toBe(true)

    reader.replaceCapability({ zcap: await grant() })
    const resumed = await reader.pull()
    expect(resumed.paused).toBe(false)
    expect(resumed.changes.map(change => change.id)).toEqual(['p1'])
  }, 60000)

  it('replays from the start when the server refuses the checkpoint', async () => {
    const { grant, collection } = await provisionAudience()
    await collection.put('p1', { postId: 'post-1' })
    const reader = AudienceReader.open({
      zcap: await grant(),
      signer,
      checkpoint: 'not-a-checkpoint-this-server-issued'
    })
    const { result: replay, events } = await withCapturedLogs(() =>
      reader.pull()
    )
    expect(replay.snapshot).toBe(true)
    expect(replay.paused).toBe(false)
    expect(replay.changes.map(change => change.id)).toEqual(['p1'])
    expect(reader.checkpoint).not.toBe('not-a-checkpoint-this-server-issued')
    expect(events.filter(event => event.level === 'warn')).toHaveLength(1)
  }, 60000)

  it('refuses a zcap that does not allow GET', async () => {
    const { grant } = await provisionAudience()
    const zcap = await grant()
    const headOnly = { ...zcap, allowedAction: ['HEAD'] }
    expect(() => AudienceReader.open({ zcap: headOnly, signer })).toThrow(
      /must allow GET/
    )
    const reader = AudienceReader.open({ zcap, signer })
    expect(() => reader.replaceCapability({ zcap: headOnly })).toThrow(
      /must allow GET/
    )
    expect(reader.paused).toBe(false)
  }, 60000)

  it('a denial of a request in flight under a replaced zcap pauses nothing', async () => {
    const { grant, collection } = await provisionAudience()
    await collection.put('p1', { postId: 'post-1' })
    const zcap = await grant()
    const reader = AudienceReader.open({ zcap, signer })
    const replacement = await grant()
    // The walk's first page is denied, and the replacement lands while that
    // request is in flight.
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).pathname.endsWith('/query')) {
        reader.replaceCapability({ zcap: replacement })
        return new Response(null, { status: 404 })
      }
      return realFetch(input, init)
    })
    const stale = await reader.pull()
    vi.restoreAllMocks()
    // The result agrees with the reader: nothing to ask the agent for.
    expect(stale.paused).toBe(false)
    expect(reader.paused).toBe(false)
    const { changes } = await reader.pull()
    expect(changes.map(change => change.id)).toEqual(['p1'])
  }, 60000)

  it('a replay cut by a stale denial is not a snapshot and keeps the pages read', async () => {
    const { grant, collection } = await provisionAudience()
    for (const index of [1, 2, 3]) {
      await collection.put(`p${index}`, { postId: `post-${index}` })
    }
    const zcap = await grant()
    const replacement = await grant()
    const reader = AudienceReader.open({
      zcap,
      signer,
      pageSize: 1,
      checkpoint: 'not-a-checkpoint-this-server-issued'
    })
    // Query 1 is the refused checkpoint (a real 400), so the reader replays
    // from the start: query 2 is the metadata record's page, query 3 the
    // first post's, during which a renewal lands. Query 4 left under the
    // superseded zcap and is denied: a cut that pauses nothing.
    const realFetch = globalThis.fetch
    let queries = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!new URL(url).pathname.endsWith('/query')) {
        return realFetch(input, init)
      }
      queries += 1
      if (queries === 3) {
        reader.replaceCapability({ zcap: replacement })
      }
      if (queries === 4) {
        return new Response(null, { status: 404 })
      }
      return realFetch(input, init)
    })
    const replay = await reader.pull()
    vi.restoreAllMocks()
    expect(queries).toBe(4)
    // Partial: a consumer applying it as a snapshot would drop p2 and p3,
    // and the checkpoint has moved past them.
    expect(replay.snapshot).toBe(false)
    expect(replay.paused).toBe(false)
    expect(replay.changes.map(change => change.id)).toEqual(['p1'])
    expect(reader.paused).toBe(false)
    expect(reader.checkpoint).not.toBeNull()
    expect(reader.checkpoint).not.toBe('not-a-checkpoint-this-server-issued')

    // The next pull resumes from the last fully read page.
    const resumed = await reader.pull()
    expect(resumed.snapshot).toBe(false)
    expect(resumed.changes.map(change => change.id)).toEqual(['p2', 'p3'])
  }, 60000)
})
