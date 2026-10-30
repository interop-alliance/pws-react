/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The requester-side resolution of a Space's owner: the did:webvh whose
 * account log is published in the Space's `id` collection and whose
 * identifier maps back to that location. Against a real server the dev
 * provisioner's Space resolves to the DID it promoted the controller to; a
 * log served under a location its DID does not name is refused.
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
import { logToJsonlString } from '@interop/did-method-webvh'
import { provisionDevGrants } from '../../src/dev/provisionDevGrants.js'
import { resolveSpaceOwner } from '../../src/identity/spaceOwner.js'

const SEED = new Uint8Array(32).map((_, index) => (index * 13 + 5) & 0xff)

let server: Awaited<ReturnType<typeof startTestServer>> | undefined
let provisioned: Awaited<ReturnType<typeof provisionDevGrants>>

beforeAll(async () => {
  server = await startTestServer({
    backend: await openTempBackend({
      prefix: 'was-react-owner-',
      capacityBytes: Infinity
    })
  })
  provisioned = await provisionDevGrants({
    baseServerUrl: server.baseServerUrl,
    seed: SEED,
    collections: ['notes']
  })
})

afterAll(async () => {
  await server?.fastify.close()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveSpaceOwner', () => {
  it('resolves the published account log to the promoted controller', async () => {
    const owner = await resolveSpaceOwner({
      spaceUrl: provisioned.spaceUrl
    })
    expect(owner.did).toBe(provisioned.provisionerDid)
    expect(owner.log.length).toBeGreaterThan(0)
  })

  it('refuses a log whose DID names another location', async () => {
    // The genuine log, served from a different Space's `id` collection: a
    // host answering one account's log under another Space's URL.
    const { log } = await resolveSpaceOwner({
      spaceUrl: provisioned.spaceUrl
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(logToJsonlString(log), { status: 200 })
    )
    await expect(
      resolveSpaceOwner({
        spaceUrl: `${server!.baseServerUrl}space/another-space/`
      })
    ).rejects.toThrow(/not where it was served from/)
  })

  it('refuses a Space that publishes no account log', async () => {
    await expect(
      resolveSpaceOwner({
        spaceUrl: `${server!.baseServerUrl}space/no-such-space/`
      })
    ).rejects.toThrow(/publishes no readable account log/)
  })
})
