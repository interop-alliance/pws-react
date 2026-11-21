/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The Space controller of a dev Space `provisionDevGrants` laid out, for the
 * node suites that stand in for the wallet. It invokes as the did:webvh the
 * promotion moved the controller to, signing under the provisioner key, with
 * no capability (a root invocation). That is what lets it write Collection
 * Metadata, which an app's Collection-scoped grant cannot.
 */
import { CapabilityAgent } from '@interop/capability-agent'
import { PwsClient } from '@interop/pws-client'
import { createEdvEncryption } from '@interop/pws-client/edv'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import { webvhZcapClient } from '@interop/wallet-core/webvh'
import { DEFAULT_PROVISIONER_SEED } from '../../src/dev/provisionDevGrants.js'

/**
 * Builds the Space controller's client.
 *
 * @param options {object}
 * @param options.baseServerUrl {string}   the test server's base URL
 * @param options.did {string}   the promoted controller (`provisionerDid`)
 * @param [options.keys] {object}   key-agreement keys a private collection's
 *   current epoch names, for a write that seals (the blinded-index schema).
 *   On a dev Space the app's identity key is the sole recipient, so the
 *   stand-in seals with it; a real wallet is a recipient in its own right
 * @param options.keys.keyAgreementKey {IKeyAgreementKey}
 * @param options.keys.keyResolver {IKeyResolver}
 * @returns {Promise<PwsClient>}
 */
export async function devSpaceOwner({
  baseServerUrl,
  did,
  keys
}: {
  baseServerUrl: string
  did: string
  keys?: { keyAgreementKey: IKeyAgreementKey; keyResolver: IKeyResolver }
}): Promise<PwsClient> {
  const keyAgent = await CapabilityAgent.fromSeed({
    seed: DEFAULT_PROVISIONER_SEED,
    handle: 'dev-provisioner',
    keyName: 'provisioner-key'
  })
  return new PwsClient({
    baseServerUrl,
    zcapClient: webvhZcapClient({ keyAgent, did }),
    ...(keys && {
      encryption: createEdvEncryption({ resolveKeys: async () => keys })
    })
  })
}
