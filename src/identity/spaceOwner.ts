/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Resolves the did:webvh that owns a WAS Space, from the requester's side.
 *
 * A requester holds per-collection grants and nothing that names the Space's
 * controller: the grant chain's root is an opaque URN, and the Space
 * Description needs a Space-scoped capability App Connect never delegates.
 * What it can reach is the account log the owner publishes world-readable at
 * `/space/{spaceId}/id/did.jsonl`. That log is self-certifying: the DID it
 * resolves to encodes the host and path it is published under, so the owner
 * of a Space is the DID whose log is published in that Space and whose
 * identifier maps back to that very URL. A host serving some other account's
 * log there fails the location check, and a log it tampered with fails
 * resolution.
 *
 * The fetch, the resolution, and the location check are wallet-core's
 * `discoverAccountLog`, the same reader its ceremonies verify an account log
 * with; this module only names the absent-log case after the Space it was
 * asked about.
 *
 * The resolved `{ did, log }` is what wallet-core's
 * `webvhResourceLogController` takes as the verified controller view every
 * log-governed descriptor read is checked against.
 */
import type { DIDLog } from '@interop/did-method-webvh'
import type { ResourceLogPinStore } from '@interop/vh-resource-log'
import { discoverAccountLog } from '@interop/wallet-core/webvh'

/**
 * Fetches and resolves the account log published in a Space's `id`
 * collection, and checks that the resolved DID names that location. Given a
 * `pinStore`, the log is also checked for continuity against the chain-head
 * pinned there and refused on a rollback, a fork, or an SCID switch, so a
 * host cannot swap the owner's log out between two resolutions in one
 * session.
 *
 * @param options {object}
 * @param options.baseUrl {string}   the WAS server base URL
 * @param options.spaceId {string}
 * @param [options.pinStore] {ResourceLogPinStore}   this session's chain-head
 *   pins
 * @returns {Promise<{ did: string, log: DIDLog }>}   the owner's did:webvh and
 *   its verified log
 */
export async function resolveSpaceOwner({
  baseUrl,
  spaceId,
  pinStore
}: {
  baseUrl: string
  spaceId: string
  pinStore?: ResourceLogPinStore
}): Promise<{ did: string; log: DIDLog }> {
  try {
    const { did, log } = await discoverAccountLog({
      spaceId,
      host: baseUrl,
      ...(pinStore && { pinStore })
    })
    return { did, log }
  } catch (err) {
    if ((err as { name?: string }).name === 'AccountLogMissingError') {
      throw new Error(
        `The Space "${spaceId}" publishes no readable account log.`,
        { cause: err }
      )
    }
    throw err
  }
}
