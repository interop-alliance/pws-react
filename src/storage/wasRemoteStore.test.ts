/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ZcapClient } from '@interop/ezcap'
import type {
  IKeyAgreementKey,
  IKeyResolver,
  IZcap
} from '@interop/data-integrity-core'
import { NotImplementedError, WasServerError } from '@interop/was-client'
import type { CollectionMetadata } from '@interop/was-client'
import { WasRemoteStore } from './wasRemoteStore.js'
import { createSpaceTrust } from './spaceTrust.js'
import type { ParsedGrants } from '../grants.js'
import { resolveSpaceOwner } from '../identity/spaceOwner.js'

// The source builder is captured so its `resolveController` and `pinStore`
// wiring can be exercised without a log to read.
vi.mock('@interop/wallet-core/descriptors', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@interop/wallet-core/descriptors')>()
  return {
    ...actual,
    logGovernedDescriptorSource: vi.fn(actual.logGovernedDescriptorSource)
  }
})
vi.mock('../identity/spaceOwner.js', () => ({ resolveSpaceOwner: vi.fn() }))

const parsed: ParsedGrants = {
  baseUrl: 'https://was.example',
  spaceId: 'space-1',
  byCollectionId: {
    'microblog-posts': { id: 'urn:zcap:pub' } as unknown as IZcap,
    notes: { id: 'urn:zcap:priv' } as unknown as IZcap
  }
}

const zcapClient = {} as unknown as ZcapClient

/**
 * The service description a v0.5 server publishes, answered by a stubbed
 * global `fetch`. From was-client 0.62 on, every signed request first
 * discovers the server's version through an unsigned `HEAD` of the server URL
 * and an unsigned `GET` of the linked document, neither of which goes through
 * the stubbed `ZcapClient`; an earlier client never calls `fetch` here, and
 * the stub is idle.
 */
const serviceDescription = {
  url: 'https://was.example',
  specs: { 'https://w3id.org/pws': [{ version: '0.5' }] }
}

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        init?.method === 'HEAD' ? null : JSON.stringify(serviceDescription),
        {
          status: 200,
          headers: {
            link: '<https://was.example/service>; rel="service"',
            'content-type': 'application/json'
          }
        }
      )
  )
})

afterAll(() => {
  vi.unstubAllGlobals()
})

/**
 * A stub ZcapClient capturing every signed request and answering each with the
 * queued responses (the last one repeating). A response's `etag` is served as
 * its `ETag` header, the validator a metadata read hands back.
 */
function stubZcapClient(
  responses: Array<{
    status: number
    data?: unknown
    etag?: string
    error?: unknown
  }>
) {
  const calls: Array<{
    url: string
    method?: string
    action?: string
    capability?: unknown
    json?: unknown
    headers?: Record<string, string>
  }> = []
  let callIndex = 0
  const client = {
    invocationSigner: { id: 'did:key:zStubController#zStubController' },
    request: async (options: (typeof calls)[number]) => {
      calls.push(options)
      const response = responses[Math.min(callIndex, responses.length - 1)]
      callIndex += 1
      if (response?.error !== undefined) {
        throw response.error
      }
      return {
        ...response,
        headers: new Headers(
          response?.etag !== undefined ? { etag: response.etag } : {}
        )
      }
    }
  }
  return { calls, zcapClient: client as unknown as ZcapClient }
}

/**
 * A Collection Metadata object as the read pass hands it to a declaration:
 * the stored object plus the validator the write pins to (`null` for a
 * backend that serves none).
 */
function metaRead(
  description: Record<string, unknown>,
  etag: string | null = '"v1"'
) {
  return {
    description: description as unknown as CollectionMetadata,
    ...(etag !== null && { etag })
  }
}

/**
 * Fake identity keys: `fromGrants` only records whether they were supplied (the
 * real ones are only ever consumed by the EDV codec, which these tests fake
 * out below).
 */
const identityKeys = {
  keyAgreementKey: { id: 'did:key:zKak#zKak' },
  keyResolver: async () => ({})
} as unknown as {
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
}

/**
 * Replaces the store's `WasClient` with a stand-in whose
 * `space().collection()` chain answers from `handlers`, capturing the handle
 * arguments and every `find` / `declareIndexes` call. The codec is what would
 * blind the terms and decrypt the results; faking at the handle boundary keeps
 * the assertions on this library's own routing.
 */
function fakeCollectionHandle(
  store: WasRemoteStore,
  handlers: {
    find?: (options: Record<string, unknown>) => Promise<unknown>
    indexes?: () => Promise<Array<{ attribute: string | string[] }>>
    declareIndexes?: (options: {
      indexes: Array<{ attribute: string }>
    }) => Promise<unknown>
  }
) {
  const calls: {
    spaceId?: string
    collectionId?: string
    capability?: unknown
    find: Array<Record<string, unknown>>
    declared: string[]
    declareCalls: number
  } = { find: [], declared: [], declareCalls: 0 }
  const collection = {
    find: async (options: Record<string, unknown>) => {
      calls.find.push(options)
      return await (handlers.find?.(options) ?? Promise.resolve({}))
    },
    indexes: async () => await (handlers.indexes?.() ?? Promise.resolve([])),
    declareIndexes: async ({
      indexes
    }: {
      indexes: Array<{ attribute: string }>
    }) => {
      calls.declared.push(...indexes.map(({ attribute }) => attribute))
      calls.declareCalls += 1
      return await (handlers.declareIndexes?.({ indexes }) ??
        Promise.resolve({ revision: 1, indexes: [] }))
    }
  }
  const was = {
    space: (spaceId: string) => {
      calls.spaceId = spaceId
      return {
        collection: (
          collectionId: string,
          options?: { capability?: unknown }
        ) => {
          calls.collectionId = collectionId
          calls.capability = options?.capability
          return collection
        }
      }
    }
  }
  ;(store as unknown as { was: unknown }).was = was
  return calls
}

/**
 * The options the store handed `logGovernedDescriptorSource` on its last
 * build.
 */
async function sourceOptions() {
  const { logGovernedDescriptorSource } =
    await import('@interop/wallet-core/descriptors')
  const calls = vi.mocked(logGovernedDescriptorSource).mock.calls
  return calls[calls.length - 1]![0]
}

describe('WasRemoteStore.descriptorSource', () => {
  it('is a verifying source, built once per store', () => {
    const remoteStore = WasRemoteStore.fromGrants({ parsed, zcapClient })
    const source = remoteStore.descriptorSource
    expect(source.verifiesHistory).toBe(true)
    expect(remoteStore.descriptorSource).toBe(source)
  })

  it('resolves the Space owner once, but retries a failed resolution', async () => {
    const owner = vi.mocked(resolveSpaceOwner)
    owner.mockReset()
    owner
      .mockRejectedValueOnce(new Error('server unreachable'))
      .mockResolvedValue({ did: 'did:webvh:x', log: [] } as never)
    void WasRemoteStore.fromGrants({ parsed, zcapClient }).descriptorSource
    const { resolveController } = await sourceOptions()
    await expect(resolveController()).rejects.toThrow('server unreachable')
    // The rejection is not remembered: the next read resolves again.
    await resolveController()
    await resolveController()
    expect(owner).toHaveBeenCalledTimes(2)
  })

  it('shares the owner resolution and the pins of the trust it was given', async () => {
    const owner = vi.mocked(resolveSpaceOwner)
    owner.mockReset()
    owner.mockResolvedValue({ did: 'did:webvh:x', log: [] } as never)
    const trust = createSpaceTrust(parsed)
    void WasRemoteStore.fromGrants({ parsed, zcapClient, trust })
      .descriptorSource
    const first = await sourceOptions()
    void WasRemoteStore.fromGrants({ parsed, zcapClient, trust })
      .descriptorSource
    const second = await sourceOptions()
    expect(first.pinStore).toBe(trust.pinStore)
    expect(second.pinStore).toBe(trust.pinStore)
    await first.resolveController()
    await second.resolveController()
    expect(owner).toHaveBeenCalledTimes(1)
  })
})

describe('WasRemoteStore.readCollectionMeta', () => {
  it('returns the whole stored object, custom raw, with its validator', async () => {
    // The stored (opaque) envelope, NOT the decoded plaintext: it is what the
    // local store's cipher decodes itself to recover the index schema.
    const stored = { jwe: { protected: 'opaque' } }
    const { calls, zcapClient: stub } = stubZcapClient([
      {
        status: 200,
        etag: '"v7"',
        data: {
          id: 'notes',
          type: ['Collection'],
          encryption: { scheme: 'edv' },
          custom: stored
        }
      }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionMeta('notes')).toEqual({
      description: {
        id: 'notes',
        type: ['Collection'],
        encryption: { scheme: 'edv' },
        custom: stored
      },
      etag: '"v7"'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'https://was.example/space/space-1/notes/meta',
      method: 'GET',
      capability: { id: 'urn:zcap:priv' }
    })
  })

  it('returns undefined when no capability covers the collection', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 200 }])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionMeta('ungranted')).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('returns undefined for a not-found response', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 404, error: notFound }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionMeta('notes')).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('returns undefined for a backend without metadata support', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 501, error: new NotImplementedError('no meta') }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionMeta('notes')).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('rethrows a transient failure, wrapped with the collection id', async () => {
    const badGateway = Object.assign(new Error('Bad Gateway'), { status: 502 })
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 502, error: badGateway }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    const err = (await store.readCollectionMeta('notes').then(
      () => undefined,
      (err: unknown) => err
    )) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('"notes"')
    expect(err.cause).toBeInstanceOf(WasServerError)
    expect((err.cause as WasServerError).status).toBe(502)
    expect(calls).toHaveLength(1)
  })
})

describe('WasRemoteStore.declareCollectionIndexes', () => {
  const collections = [
    {
      key: 'posts',
      id: 'microblog-posts',
      visibility: 'public' as const,
      indexes: ['author', 'inReplyTo']
    }
  ]

  it('skips a private collection and a public one without indexes', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'posts', id: 'microblog-posts', visibility: 'public' },
        { key: 'notes', id: 'notes' }
      ]
    })
    expect(await store.declareCollectionIndexes('notes', {})).toEqual({
      collectionId: 'notes',
      ok: true,
      skipped: true
    })
    expect(await store.declareCollectionIndexes('microblog-posts', {})).toEqual(
      {
        collectionId: 'microblog-posts',
        ok: true,
        skipped: true
      }
    )
  })

  it('merges the indexes into the object it was handed, pinned to its validator', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 204 }])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    const result = await store.declareCollectionIndexes('microblog-posts', {
      current: metaRead({
        id: 'microblog-posts',
        type: ['Collection'],
        name: 'Posts',
        custom: { name: 'Posts', tags: { topic: 'birds' } },
        url: 'https://was.example/space/space-1/microblog-posts/',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z'
      })
    })
    expect(result).toEqual({ collectionId: 'microblog-posts', ok: true })
    // One PUT at `meta` through `Collection.configure`, no read of its own:
    // the stored `name` and `custom` are carried forward beside the
    // declaration, the server-managed members stay out of the body, and
    // `If-Match` pins the write to the read's validator.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'https://was.example/space/space-1/microblog-posts/meta',
      method: 'PUT',
      capability: { id: 'urn:zcap:pub' },
      headers: { 'if-match': '"v1"' }
    })
    expect(calls[0]?.json).toEqual({
      id: 'microblog-posts',
      name: 'Posts',
      custom: { name: 'Posts', tags: { topic: 'birds' } },
      plaintext: { indexes: ['author', 'inReplyTo'] }
    })
  })

  it('skips the write when the stored declaration already matches', async () => {
    // The server may echo the expanded form of a bare-string entry; that is
    // the same declaration, not drift.
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 204 }])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    expect(
      await store.declareCollectionIndexes('microblog-posts', {
        current: metaRead({
          id: 'microblog-posts',
          type: ['Collection'],
          plaintext: {
            indexes: ['author', { name: 'inReplyTo', source: 'content' }]
          }
        })
      })
    ).toEqual({
      collectionId: 'microblog-posts',
      ok: true,
      skipped: true
    })
    expect(calls).toHaveLength(0)
  })

  it('writes over a stale declaration, keeping the rest of plaintext', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 204 }])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    expect(
      await store.declareCollectionIndexes('microblog-posts', {
        current: metaRead({
          id: 'microblog-posts',
          type: ['Collection'],
          plaintext: { indexes: ['author'], other: 'kept' }
        })
      })
    ).toEqual({ collectionId: 'microblog-posts', ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.json).toEqual({
      id: 'microblog-posts',
      plaintext: { indexes: ['author', 'inReplyTo'], other: 'kept' }
    })
    expect(calls[0]?.headers?.['if-match']).toBe('"v1"')
  })

  it('refuses the write when the read served no validator', async () => {
    // An unpinned write could silently overwrite a concurrent change.
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 204 }])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    const result = await store.declareCollectionIndexes('microblog-posts', {
      current: metaRead(
        {
          id: 'microblog-posts',
          type: ['Collection'],
          plaintext: { indexes: ['author'], other: 'kept' }
        },
        null
      )
    })
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses the write when the metadata object was not read', async () => {
    // Writing the list alone would replace the whole object with it.
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 204 }])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    const result = await store.declareCollectionIndexes('microblog-posts', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/was not read/)
    expect(calls).toHaveLength(0)
  })

  it('rebases a lost race on a fresh read and writes again', async () => {
    // was-client's compare-and-swap: the pinned PUT loses (412), the object
    // is re-read, and the declaration is merged over what landed meanwhile.
    const stale = Object.assign(new Error('Precondition Failed'), {
      status: 412
    })
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 412, error: stale },
      {
        status: 200,
        etag: '"v2"',
        data: {
          id: 'microblog-posts',
          type: ['Collection'],
          name: 'Renamed meanwhile',
          custom: { tags: { topic: 'birds' } }
        }
      },
      { status: 204, etag: '"v3"' }
    ])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    const result = await store.declareCollectionIndexes('microblog-posts', {
      current: metaRead({ id: 'microblog-posts', type: ['Collection'] })
    })
    expect(result).toEqual({ collectionId: 'microblog-posts', ok: true })
    expect(calls.map(call => call.method)).toEqual(['PUT', 'GET', 'PUT'])
    expect(calls[0]?.headers?.['if-match']).toBe('"v1"')
    expect(calls[2]?.headers?.['if-match']).toBe('"v2"')
    expect(calls[2]?.json).toEqual({
      id: 'microblog-posts',
      name: 'Renamed meanwhile',
      custom: { tags: { topic: 'birds' } },
      plaintext: { indexes: ['author', 'inReplyTo'] }
    })
  })

  it('reports a race lost repeatedly rather than throwing', async () => {
    const stale = Object.assign(new Error('Precondition Failed'), {
      status: 412
    })
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 412, error: stale }
    ])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    const result = await store.declareCollectionIndexes('microblog-posts', {
      current: metaRead({ id: 'microblog-posts', type: ['Collection'] })
    })
    expect(result.ok).toBe(false)
    // The compare-and-swap gives up after its attempt budget; the exhaustion
    // error names the race (it carries the last 412 as its cause, not as a
    // status of its own).
    expect(result.error).toMatch(/compare-and-swap race/)
    expect(calls.length).toBeGreaterThan(1)
  })
})

describe('WasRemoteStore.queryCollectionByEquality', () => {
  const collections = [
    {
      key: 'posts',
      id: 'microblog-posts',
      visibility: 'public' as const,
      indexes: ['author', 'inReplyTo']
    },
    { key: 'notes', id: 'notes' }
  ]

  it('issues the canonical sorted filter GET and parses the page', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([
      {
        status: 200,
        data: {
          documents: [
            { id: 'post-1', data: { id: 'post-1', title: 'One' } },
            { id: 'post-2', data: { id: 'post-2', title: 'Two' } }
          ],
          hasMore: true,
          cursor: 'next-page'
        }
      }
    ])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    const page = await store.queryCollectionByEquality({
      collectionId: 'microblog-posts',
      // Deliberately unsorted terms + a value that needs percent-encoding.
      equals: { inReplyTo: 'urn:uuid:1', author: 'did:key:z6Mk' },
      limit: 2
    })
    expect(page).toEqual({
      documents: [
        { id: 'post-1', data: { id: 'post-1', title: 'One' } },
        { id: 'post-2', data: { id: 'post-2', title: 'Two' } }
      ],
      hasMore: true,
      cursor: 'next-page'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url:
        'https://was.example/space/space-1/microblog-posts/' +
        '?filter[author]=did%3Akey%3Az6Mk' +
        '&filter[inReplyTo]=urn%3Auuid%3A1&limit=2',
      method: 'GET'
    })
  })

  it('passes the continuation cursor through', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 200, data: { documents: [], hasMore: false } }
    ])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    const page = await store.queryCollectionByEquality({
      collectionId: 'microblog-posts',
      equals: { author: 'did:key:z6Mk' },
      cursor: 'next-page'
    })
    expect(page).toEqual({ documents: [], hasMore: false })
    expect(calls[0]?.url).toContain('&cursor=next-page')
  })

  it('fails closed before any request on invalid queries', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 200 }])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'unregistered',
        equals: { author: 'x' }
      })
    ).rejects.toThrow(/not in the collection registry/)
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'microblog-posts',
        equals: {}
      })
    ).rejects.toThrow(/at least one term/)
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'microblog-posts',
        equals: { undeclared: 'x' }
      })
    ).rejects.toThrow(/not declared/)
    expect(calls).toHaveLength(0)
  })

  it('rejects a malformed response page', async () => {
    const { zcapClient: stub } = stubZcapClient([
      { status: 200, data: { items: [] } }
    ])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'microblog-posts',
        equals: { author: 'x' }
      })
    ).rejects.toThrow(/Malformed equality query response/)
  })
})

describe('WasRemoteStore.queryCollectionByEquality (blinded)', () => {
  const collections = [
    { key: 'notes', id: 'notes', indexes: ['author', 'inReplyTo'] }
  ]

  it('runs the blinded find and maps the page', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections,
      keys: identityKeys
    })
    const blob = new Blob(['attachment'])
    const calls = fakeCollectionHandle(store, {
      find: async () => ({
        items: [
          { id: 'env-1', data: { id: 'note-1', author: 'did:key:z6Mk' } },
          { id: 'env-2', data: blob }
        ],
        hasMore: true,
        cursor: 'next-page'
      })
    })
    const page = await store.queryCollectionByEquality({
      collectionId: 'notes',
      equals: { author: 'did:key:z6Mk', inReplyTo: 'urn:uuid:1' },
      limit: 2,
      cursor: 'prior-page'
    })
    expect(page).toEqual({
      documents: [
        { id: 'env-1', data: { id: 'note-1', author: 'did:key:z6Mk' } },
        // A blob decrypts to a `Blob`, so only the id is reported.
        { id: 'env-2' }
      ],
      hasMore: true,
      cursor: 'next-page'
    })
    expect(calls.spaceId).toBe('space-1')
    expect(calls.collectionId).toBe('notes')
    expect(calls.capability).toEqual({ id: 'urn:zcap:priv' })
    // Attribute names are rooted at the EDV document's `content`.
    expect(calls.find).toEqual([
      {
        equals: {
          'content.author': 'did:key:z6Mk',
          'content.inReplyTo': 'urn:uuid:1'
        },
        limit: 2,
        cursor: 'prior-page'
      }
    ])
  })

  it('omits limit and cursor when they were not given', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections,
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {
      find: async () => ({ items: [], hasMore: false })
    })
    const page = await store.queryCollectionByEquality({
      collectionId: 'notes',
      equals: { author: 'x' }
    })
    expect(page).toEqual({ documents: [], hasMore: false })
    expect(calls.find[0]).toEqual({ equals: { 'content.author': 'x' } })
  })

  it('fails closed on an empty term set and an undeclared attribute', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections,
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {})
    await expect(
      store.queryCollectionByEquality({ collectionId: 'notes', equals: {} })
    ).rejects.toThrow(/at least one term/)
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'notes',
        equals: { undeclared: 'x' }
      })
    ).rejects.toThrow(/not declared/)
    expect(calls.find).toHaveLength(0)
  })

  it('fails closed when no identity keys were supplied', async () => {
    // No `keys`: the client's keystore cannot build a codec, so nothing could
    // blind the terms or decrypt the results.
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections
    })
    const calls = fakeCollectionHandle(store, {})
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'notes',
        equals: { author: 'x' }
      })
    ).rejects.toThrow(/identity keys/)
    expect(calls.find).toHaveLength(0)
  })

  it('fails closed when no grant covers the collection', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'other', id: 'ungranted', indexes: ['author'] }],
      keys: identityKeys
    })
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'ungranted',
        equals: { author: 'x' }
      })
    ).rejects.toThrow(/No delegated capability covers/)
  })
})

describe('WasRemoteStore.declareBlindedIndexes', () => {
  const epochs = [{ id: 'did:key:zEpoch1', recipients: [] }]
  const withHmac = {
    scheme: 'edv' as const,
    currentEpoch: 'did:key:zEpoch1',
    epochs,
    hmac: { id: 'urn:hmac:1', type: 'Sha256HmacKey2019', recipients: [] }
  }

  it('skips a public collection and a private one without indexes', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        {
          key: 'posts',
          id: 'microblog-posts',
          visibility: 'public',
          indexes: ['author']
        },
        { key: 'notes', id: 'notes' }
      ],
      keys: identityKeys
    })
    expect(
      await store.declareBlindedIndexes('microblog-posts', {
        encryption: undefined
      })
    ).toEqual({ collectionId: 'microblog-posts', ok: true, skipped: true })
    expect(
      await store.declareBlindedIndexes('notes', { encryption: withHmac })
    ).toEqual({ collectionId: 'notes', ok: true, skipped: true })
  })

  it('reports a descriptor with no blinded-index key as not ok', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'notes', id: 'notes', indexes: ['author'] }],
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {})
    const result = await store.declareBlindedIndexes('notes', {
      encryption: { scheme: 'edv', currentEpoch: 'did:key:zEpoch1', epochs }
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/without a blinded-index key/)
    expect(calls.declared).toHaveLength(0)
  })

  it('declares only the attributes not already persisted', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'notes', id: 'notes', indexes: ['author', 'inReplyTo'] }
      ],
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {
      indexes: async () => [{ attribute: 'content.author' }]
    })
    expect(
      await store.declareBlindedIndexes('notes', { encryption: withHmac })
    ).toEqual({ collectionId: 'notes', ok: true, wrote: true })
    expect(calls.declared).toEqual(['content.inReplyTo'])
    expect(calls.capability).toEqual({ id: 'urn:zcap:priv' })
  })

  it('declares every missing attribute in one batch call', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'notes', id: 'notes', indexes: ['author', 'inReplyTo'] }
      ],
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {})
    expect(
      await store.declareBlindedIndexes('notes', { encryption: withHmac })
    ).toEqual({ collectionId: 'notes', ok: true, wrote: true })
    expect(calls.declareCalls).toBe(1)
    expect(calls.declared).toEqual(['content.author', 'content.inReplyTo'])
  })

  it('reports no write when every attribute is already persisted', async () => {
    // A returning session: the caller's pre-read `custom` is still current.
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'notes', id: 'notes', indexes: ['author', 'inReplyTo'] }
      ],
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {
      indexes: async () => [
        { attribute: 'content.author' },
        { attribute: 'content.inReplyTo' }
      ]
    })
    expect(
      await store.declareBlindedIndexes('notes', { encryption: withHmac })
    ).toEqual({ collectionId: 'notes', ok: true, wrote: false })
    expect(calls.declared).toEqual([])
  })

  it('reports a failed declaration rather than throwing', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'notes', id: 'notes', indexes: ['author'] }],
      keys: identityKeys
    })
    fakeCollectionHandle(store, {
      indexes: async () => {
        throw new Error('meta read refused')
      }
    })
    const result = await store.declareBlindedIndexes('notes', {
      encryption: withHmac
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/meta read refused/)
  })

  it('reports a missing capability and missing identity keys', async () => {
    const ungranted = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'other', id: 'ungranted', indexes: ['author'] }],
      keys: identityKeys
    })
    expect(
      await ungranted.declareBlindedIndexes('ungranted', {
        encryption: withHmac
      })
    ).toEqual({
      collectionId: 'ungranted',
      ok: false,
      error: 'no capability'
    })
    const keyless = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'notes', id: 'notes', indexes: ['author'] }]
    })
    expect(
      await keyless.declareBlindedIndexes('notes', { encryption: withHmac })
    ).toEqual({ collectionId: 'notes', ok: false, error: 'no identity keys' })
  })
})

describe('WasRemoteStore.publicUrlFor', () => {
  const collections = [
    { key: 'posts', id: 'microblog-posts', visibility: 'public' as const },
    { key: 'notes', id: 'notes' }
  ]

  it('composes the stable resource URL for a public collection', () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient, collections })
    expect(
      store.publicUrlFor({ collectionId: 'microblog-posts', id: 'post-1' })
    ).toBe('https://was.example/space/space-1/microblog-posts/post-1')
  })

  it('percent-encodes the resource id', () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient, collections })
    expect(
      store.publicUrlFor({
        collectionId: 'microblog-posts',
        id: 'urn:uuid:a/b'
      })
    ).toBe(
      'https://was.example/space/space-1/microblog-posts/urn%3Auuid%3Aa%2Fb'
    )
  })

  it('throws on a private / unregistered collection', () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient, collections })
    expect(() =>
      store.publicUrlFor({ collectionId: 'notes', id: 'post-1' })
    ).toThrow(/not registered as public/)
    expect(() =>
      store.publicUrlFor({ collectionId: 'unknown', id: 'post-1' })
    ).toThrow(/not registered as public/)
  })

  it('throws on an empty id', () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient, collections })
    expect(() =>
      store.publicUrlFor({ collectionId: 'microblog-posts', id: '' })
    ).toThrow(/non-empty document id/)
  })

  it('throws when no grant covers the collection', () => {
    // Registered public in the config, but no delegated capability covers it.
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'shared', id: 'shared-notes', visibility: 'public' as const }
      ]
    })
    expect(() =>
      store.publicUrlFor({ collectionId: 'shared-notes', id: 'post-1' })
    ).toThrow(/No delegated capability covers/)
  })
})
