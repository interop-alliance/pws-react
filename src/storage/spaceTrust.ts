/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * What every governed log read of one connected activation checks against,
 * held once per Space rather than once per `PwsRemoteStore`: the Space
 * owner's verified did:webvh controller view ({@link resolveSpaceOwner}, one
 * fetch and one log verification), and the chain-head pins continuity is
 * checked against. An activation builds more than one store over the same
 * grants (the login-time descriptor read, then the sync bootstrap), so the
 * auth store creates one of these and hands it to each; a store built without
 * one gets a private one.
 */
import {
  memoryResourceLogPinStore,
  type ResourceLogPinStore
} from '@interop/vh-resource-log'
import { webvhResourceLogController } from '@interop/wallet-core/resourceLog'
import type { WebvhResourceLogController } from '@interop/wallet-core/resourceLog'
import { resolveSpaceOwner } from '../identity/spaceOwner.js'

export interface SpaceTrust {
  /**
   * The chain-head pins every governed log read checks continuity against.
   * In memory: continuity is checked within a session, and a reload trusts
   * the served head afresh.
   */
  readonly pinStore: ResourceLogPinStore
  /**
   * The Space owner's verified controller view, resolved on first use and
   * kept only when the resolution succeeds. A failed fetch is not remembered:
   * the next read resolves again, so one outage (a restore while the server
   * is briefly unreachable) does not leave every later read rejecting with
   * the stale error.
   *
   * @returns {Promise<WebvhResourceLogController>}
   */
  owner(): Promise<WebvhResourceLogController>
}

/**
 * Creates the trust state for one Space.
 *
 * @param options {object}
 * @param options.spaceUrl {string}   the Space's absolute URL
 *   (`ParsedGrants.spaceUrl`); the owner's log is read beneath it
 * @returns {SpaceTrust}
 */
export function createSpaceTrust({
  spaceUrl
}: {
  spaceUrl: string
}): SpaceTrust {
  let resolved: Promise<WebvhResourceLogController> | undefined
  // The owner's own log is pinned in the same store the collection logs are:
  // a resolution retried after a failed one must continue the chain the
  // first pinned, not adopt whatever the host serves next.
  const pinStore = memoryResourceLogPinStore()
  return {
    pinStore,
    owner() {
      const owner =
        resolved ??
        resolveSpaceOwner({ spaceUrl, pinStore }).then(
          webvhResourceLogController
        )
      resolved = owner
      // Only a fulfilled resolution is kept; the caller still sees the
      // rejection through `owner` itself.
      owner.catch(() => {
        if (resolved === owner) {
          resolved = undefined
        }
      })
      return owner
    }
  }
}
