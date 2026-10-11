/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The dev provisioner against a real server: the Space it lays out ends up
 * controlled by the did:webvh it published, under the configured Space name
 * (the promotion runs through wallet-core's stage, which must not rename the
 * Space to the wallet's name).
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTempBackend, startTestServer } from 'was-teaching-server/testing'
import { CapabilityAgent } from '@interop/capability-agent'
import { WasClient } from '@interop/was-client'
import { webvhZcapClient } from '@interop/wallet-core/webvh'
import {
  DEFAULT_PROVISIONER_SEED,
  provisionDevGrants
} from '../../src/dev/provisionDevGrants.js'

const SEED = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff)

let server: Awaited<ReturnType<typeof startTestServer>> | undefined

beforeAll(async () => {
  server = await startTestServer({
    backend: await openTempBackend({
      prefix: 'was-react-provision-',
      capacityBytes: Infinity
    })
  })
})

afterAll(async () => {
  await server?.fastify.close()
})

/**
 * Reads the provisioned Space's Description as its owner: the did:webvh the
 * promotion moved the controller to, signing under the provisioner key.
 */
async function describeAsOwner({
  spaceId,
  did
}: {
  spaceId: string
  did: string
}) {
  const keyAgent = await CapabilityAgent.fromSeed({
    seed: DEFAULT_PROVISIONER_SEED,
    handle: 'dev-provisioner',
    keyName: 'provisioner-key'
  })
  const owner = new WasClient({
    serverUrl: server!.serverUrl,
    zcapClient: webvhZcapClient({ keyAgent, did })
  })
  return await owner.space(spaceId).describe()
}

describe('provisionDevGrants', () => {
  it('promotes the Space to the did:webvh under the default name', async () => {
    const provisioned = await provisionDevGrants({
      serverUrl: server!.serverUrl,
      seed: SEED,
      collections: ['notes']
    })
    const description = await describeAsOwner({
      spaceId: provisioned.spaceId,
      did: provisioned.provisionerDid
    })
    expect(description?.controller).toBe(provisioned.provisionerDid)
    expect(description?.name).toBe('Dev Space')
  })

  it('keeps a configured Space name through the promotion', async () => {
    const provisioned = await provisionDevGrants({
      serverUrl: server!.serverUrl,
      seed: SEED,
      collections: ['notes'],
      spaceName: 'Named Otherwise'
    })
    const description = await describeAsOwner({
      spaceId: provisioned.spaceId,
      did: provisioned.provisionerDid
    })
    expect(description?.controller).toBe(provisioned.provisionerDid)
    expect(description?.name).toBe('Named Otherwise')
  })
})
