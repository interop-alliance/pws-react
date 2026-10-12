/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Grant parsing and per-collection capability routing for the delegated sync
 * model, where the app is the requester (an app, service, or agent) the wallet
 * grants capabilities to. The app never provisions the Space and never
 * derives the spaceId itself; instead it receives a set of wallet-delegated
 * zcaps -- minted by a provisioning script during development, or returned by
 * the wallet through CHAPI -- and reads the WAS topology (server URL, space id,
 * per-collection routing) straight out of their `invocationTarget` URLs.
 *
 * Every grant's `invocationTarget` is an absolute WAS URL of the form
 * `<baseUrl>/space/<spaceId>/<collectionId>` (a trailing slash is tolerated),
 * where the base URL may carry a sub-path mount (`https://host/was`). The
 * `WasClient` built over a grant set takes the Spaces Repository URL beneath
 * that base (`spacesUrl` from `@interop/was-client/paths`), a URL the WAS
 * server itself answers, which the bare origin need not be. All grants MUST
 * resolve to a single server and a single space; a mismatch aborts (a grant
 * set spanning two spaces is never expected and would silently split writes).
 */
import { parseAbsoluteSpaceTarget } from '@interop/was-client/paths'
import type { IZcap } from '@interop/data-integrity-core'

/**
 * The topology parsed out of a delegated grant set: the WAS server's base URL
 * (origin plus any sub-path mount, read off the grant targets), the single
 * space id, and the per-collection capability keyed by WAS collection id.
 */
export interface ParsedGrants {
  baseUrl: string
  spaceId: string
  /**
   * Keyed by WAS collection id (e.g. `action-items`).
   */
  byCollectionId: Record<string, IZcap>
}

/**
 * Parses a single `invocationTarget` URL into its WAS components: the server's
 * base URL, the space id, and the collection (every routed grant is
 * collection-scoped, so `collectionId` is always present). The base URL is
 * read off the target itself, sub-path mount included, by
 * `@interop/was-client`'s `parseAbsoluteSpaceTarget`, which also owns the path
 * grammar. A collection- or resource-depth target contributes its collection; a
 * space-scoped or reserved sub-endpoint target (e.g. bare `/space/:id` or
 * `/space/:id/policy`) carries no collection and is rejected -- login only
 * ever requests collection-scoped capabilities.
 *
 * @param target {string}   an absolute WAS URL
 * @returns {{ baseUrl: string, spaceId: string, collectionId: string }}
 */
export function parseInvocationTarget(target: string): {
  baseUrl: string
  spaceId: string
  collectionId: string
} {
  const parsed = parseAbsoluteSpaceTarget(target)
  if (parsed === null) {
    throw new Error(
      `Grant invocationTarget is not an absolute WAS space URL: "${target}".`
    )
  }
  const { path } = parsed
  if (!('collectionId' in path)) {
    throw new Error(
      `Grant invocationTarget is not collection-scoped: "${target}".`
    )
  }
  return {
    baseUrl: parsed.baseUrl,
    spaceId: path.spaceId,
    collectionId: path.collectionId
  }
}

/**
 * Reads a grant's single `invocationTarget` string. `@interop` zcaps carry it as
 * a string; guard defensively (an array or missing target is a malformed grant).
 *
 * @param zcap {IZcap}
 * @returns {string}
 */
function invocationTargetOf(zcap: IZcap): string {
  const target = (zcap as { invocationTarget?: unknown }).invocationTarget
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('Grant is missing a string invocationTarget.')
  }
  return target
}

/**
 * Parses a delegated grant set into the sync topology. Asserts a single server
 * (base URL, sub-path mount included) and a single space across every grant,
 * and routes each collection-scoped grant to its WAS collection id. Every
 * grant must be collection-scoped; a space-scoped grant (no collection
 * segment) is rejected.
 *
 * @param zcaps {IZcap[]}   the delegated capabilities
 * @returns {ParsedGrants}
 */
export function parseGrants(zcaps: IZcap[]): ParsedGrants {
  const [head, ...rest] = zcaps
  if (head === undefined) {
    throw new Error('No grants to parse.')
  }
  // The first target's server and space are the set's; every later target is
  // checked against them.
  const first = parseInvocationTarget(invocationTargetOf(head))
  const byCollectionId: Record<string, IZcap> = { [first.collectionId]: head }

  for (const zcap of rest) {
    const parsed = parseInvocationTarget(invocationTargetOf(zcap))
    if (first.baseUrl !== parsed.baseUrl) {
      throw new Error(
        `Grants span two servers: "${first.baseUrl}" vs "${parsed.baseUrl}".`
      )
    }
    if (first.spaceId !== parsed.spaceId) {
      throw new Error(
        `Grants span two spaces: "${first.spaceId}" vs "${parsed.spaceId}".`
      )
    }
    byCollectionId[parsed.collectionId] = zcap
  }

  const { baseUrl, spaceId } = first
  return { baseUrl, spaceId, byCollectionId }
}
