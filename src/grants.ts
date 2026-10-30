/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Grant parsing and per-collection capability routing for the delegated sync
 * model, where the app is the requester (an app, service, or agent) the wallet
 * grants capabilities to. The app never provisions the Space and never holds
 * a server of its own; instead it receives a set of wallet-delegated zcaps --
 * minted by a provisioning script during development, or returned by the
 * wallet through CHAPI -- and reads the PWS topology (the Space URL and the
 * per-collection routing) out of them.
 *
 * A grant names its Space through its delegation chain: the chain of a
 * Space-rooted capability starts at the Space's root capability, whose id
 * encodes the Space URL (`spaceUrlOf` from `@interop/pws-client/paths`). The
 * grant's `invocationTarget` is then classified beneath that Space URL
 * (`parseSpaceTarget`), and only a collection-scoped target is routed. Nothing
 * here assembles a Space URL from a server it inferred, and nothing above the
 * Space is read: a grants-only app needs no base server URL. All grants MUST
 * resolve to a single Space; a mismatch aborts (a grant set spanning two
 * Spaces is never expected and would silently split writes).
 */
import { ValidationError } from '@interop/pws-client'
import { parseSpaceTarget, spaceUrlOf } from '@interop/pws-client/paths'
import type { IZcap } from '@interop/data-integrity-core'

/**
 * The topology parsed out of a delegated grant set: the one Space URL every
 * grant is rooted in (canonical form, trailing slash), and the per-collection
 * capability keyed by PWS collection id.
 */
export interface ParsedGrants {
  spaceUrl: string
  /**
   * Keyed by PWS collection id (e.g. `action-items`).
   */
  byCollectionId: Record<string, IZcap>
}

/**
 * Locates a single grant: the Space URL its delegation chain is rooted in,
 * and the collection its `invocationTarget` names beneath that Space (every
 * routed grant is collection-scoped, so `collectionId` is always present).
 * Both reads are `@interop/pws-client`'s own, which owns the chain-root rule
 * and the path grammar. The Space URL the root names is taken as given, in
 * whatever form (the spec's received-URL rule): a Space has no URL shape of
 * its own, and whether a chain roots exactly at the Space is the server's to
 * decide at invocation. A collection- or resource-depth target contributes
 * its collection; a Space-scoped or reserved sub-endpoint target (the bare
 * Space, or `{space}policy`) carries no collection and is rejected -- login
 * only ever requests collection-scoped capabilities. A target outside the
 * Space the chain roots in is rejected too. pws-client's refusal of a chain
 * that roots in no Space is rethrown as this module's grant error, with the
 * original as `cause`.
 *
 * @param zcap {IZcap}   a delegated capability
 * @returns {{ spaceUrl: string, collectionId: string }}
 */
export function parseGrantTarget(zcap: IZcap): {
  spaceUrl: string
  collectionId: string
} {
  const target = invocationTargetOf(zcap)
  let spaceUrl: string
  try {
    spaceUrl = spaceUrlOf(zcap)
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      throw err
    }
    throw new Error(
      `Grant "${String(zcap.id)}" is not rooted in a Space: ${err.message}`,
      { cause: err }
    )
  }
  const path = parseSpaceTarget({ spaceUrl, target })
  if (path === null) {
    throw new Error(
      `Grant invocationTarget "${target}" is not beneath the Space its ` +
        `chain is rooted in ("${spaceUrl}").`
    )
  }
  if (!('collectionId' in path)) {
    throw new Error(
      `Grant invocationTarget is not collection-scoped: "${target}".`
    )
  }
  return { spaceUrl, collectionId: path.collectionId }
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
 * Parses a delegated grant set into the sync topology. Asserts a single Space
 * across every grant, and routes each collection-scoped grant to its PWS
 * collection id. Every grant must be collection-scoped; a space-scoped grant
 * (no collection segment) is rejected.
 *
 * @param zcaps {IZcap[]}   the delegated capabilities
 * @returns {ParsedGrants}
 */
export function parseGrants(zcaps: IZcap[]): ParsedGrants {
  const [head, ...rest] = zcaps
  if (head === undefined) {
    throw new Error('No grants to parse.')
  }
  // The first grant's Space is the set's; every later grant is checked
  // against it.
  const first = parseGrantTarget(head)
  const byCollectionId: Record<string, IZcap> = { [first.collectionId]: head }

  for (const zcap of rest) {
    const parsed = parseGrantTarget(zcap)
    if (first.spaceUrl !== parsed.spaceUrl) {
      throw new Error(
        `Grants span two Spaces: "${first.spaceUrl}" vs "${parsed.spaceUrl}".`
      )
    }
    byCollectionId[parsed.collectionId] = zcap
  }

  return { spaceUrl: first.spaceUrl, byCollectionId }
}
