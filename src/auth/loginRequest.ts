/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Requester-side VPR construction for Login With Wallet: the one-popup App
 * Connect request. The requester (an app, service, or agent) is the party that
 * asks the wallet for grants; in the App Connect exchange it is the app running
 * this library.
 *
 * A single CHAPI `get` carries DIDAuthentication plus an `AppConnectQuery` that
 * names the app (its display name for the wallet's consent screen and the
 * canonical `appUrl` the wallet needs to MATCH an existing app key or MINT a
 * fresh one), and one collection-scoped capabilityQuery per requested
 * collection. The wallet responds -- in the same round -- with the app-key
 * credential and the delegated zcaps embedded in the response VP, so first-run
 * and returning are a single request/response with no store popup and no
 * separate grants popup.
 *
 * Only collection-scoped capabilities are requested (no whole-space grant),
 * and each request stays within the ALLOWED ACTIONS of the descriptor class it
 * uses (the App Connect spec's "Allowed actions" table): both collection
 * classes -- private and public -- allow the full action vocabulary
 * ({@link RW_ACTIONS}), since a published collection is still the app's own
 * data and un-publishing and revision are data management like any other
 * write. A share is read-only ({@link SHARED_ACTIONS}). A configured action set
 * naming an action above a requested collection's allowed set is a
 * configuration error thrown here, at build time -- a conformant wallet can
 * never grant it, so letting it ride would surface later as a failed login
 * instead.
 *
 * A `visibility: 'public'` collection is requested with the distinct descriptor
 * type `https://w3id.org/byoe#public-collection` (the wallet provisions it plaintext with a
 * collection-level public-read policy and renders a world-readable consent
 * warning); wallets that predate the type render it UNSATISFIABLE, which is the
 * intended fail-closed behavior -- an older wallet must not silently provision a
 * private collection the app believes is public. The App Connect query as a
 * whole is likewise unsatisfiable on a wallet that predates it, so an old wallet
 * fails closed rather than degrading into a partial generic flow.
 *
 * A SHARED collection -- one the wallet already owns and encrypts, which the app
 * asks to read and decrypt -- uses the
 * `https://w3id.org/byoe#shared-wallet-collection` descriptor type, and the
 * actions are read-only by construction ({@link SHARED_ACTIONS}):
 * the app never requests writes on a wallet collection. Exactly like
 * `https://w3id.org/byoe#public-collection`, a wallet that predates the type resolves the
 * descriptor UNSATISFIABLE and fails closed -- which is the point here. A share
 * fuses two axes (a read zcap AND an entry in the collection's key-epoch
 * roster), so a wallet that granted only the zcap would hand the app ciphertext
 * it cannot decrypt; that would surface as corrupt data rather than as a wallet
 * that needs updating.
 *
 * `domain` must host-match the CHAPI requesting origin or the wallet refuses
 * to sign; `challenge` must be fresh per request (echoed into the DIDAuth
 * proof and checked in verifyResponse).
 */
import { serializedAppUrl } from '@interop/wallet-request'
import type {
  IAppConnectCapabilityQuery,
  IVPRDetails
} from './walletRequestTypes.js'

/**
 * The full PWS action vocabulary, in the order of the App Connect spec's
 * "Allowed actions" table -- also the allowed-action set of BOTH collection
 * classes, `https://w3id.org/byoe#private-collection` and
 * `https://w3id.org/byoe#public-collection`.
 */
export const RW_ACTIONS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']

/**
 * The actions requested on a SHARED (wallet-owned) collection: read-only, and
 * not configurable. A shared collection belongs to the wallet, so an app never
 * asks to write it.
 */
export const SHARED_ACTIONS = ['GET', 'HEAD']

/**
 * The allowed actions of the descriptor class a collection is requested with
 * (the App Connect spec's "Allowed actions" table). Both collection classes --
 * public and private -- allow the full action vocabulary: published content is
 * still the application's own data, and un-publishing and revision are data
 * management like any other write, so an app may `PUT` or `DELETE` what it
 * published. Shares have their own fixed {@link SHARED_ACTIONS} and never
 * consult a configured action set.
 *
 * @param [_visibility] {'private' | 'public'}
 * @returns {string[]}
 */
export function actionCeiling(_visibility?: 'private' | 'public'): string[] {
  // Both classes currently allow the full vocabulary; the parameter stays so a
  // future class that DOES bound actions has one place to bound them.
  return RW_ACTIONS
}

/**
 * One collection to request a grant for: the PWS collection id plus its
 * declared visibility (`'private'`, the default, or `'public'`).
 */
export interface GrantRequestCollection {
  /**
   * PWS collection id (the unprefixed, cross-app generic name).
   */
  id: string
  /**
   * Who can read the collection; selects the descriptor type
   * (`https://w3id.org/byoe#private-collection` for `'private'`/unset,
   * `https://w3id.org/byoe#public-collection` for `'public'`).
   */
  visibility?: 'private' | 'public'
}

/**
 * A fresh nonce for a VPR challenge.
 */
export function newChallenge(): string {
  return crypto.randomUUID()
}

/**
 * The actions to request for one collection: the configured set capped at the
 * collection class's allowed actions, kept in table order. When no set is
 * configured the whole allowed set is requested; a narrower subset stays legal
 * and is passed through as asked. An EXPLICIT set naming an action OUTSIDE the
 * class's allowed actions is a configuration error thrown here, at request
 * build time: a conformant wallet can never grant it, so silently capping
 * would leave the app believing it asked for more than any correct wallet
 * returns, and the mismatch would surface later as a failed login instead of
 * as the config bug it is.
 *
 * @param options {object}
 * @param options.id {string}   the PWS collection id (for error messages)
 * @param [options.visibility] {'private' | 'public'}
 * @param [options.actions] {string[]}   the configured action set
 * @returns {string[]}
 */
function requestedActions({
  id,
  visibility,
  actions
}: {
  id: string
  visibility?: 'private' | 'public'
  actions?: string[]
}): string[] {
  const ceiling = actionCeiling(visibility)
  if (actions === undefined) {
    return ceiling
  }
  const excess = actions.filter(action => !ceiling.includes(action))
  if (excess.length > 0) {
    throw new Error(
      `Collection "${id}" cannot request action(s) outside its class's ` +
        `allowed actions: ${excess.join(', ')} (the allowed actions are ` +
        `${ceiling.join(', ')}).`
    )
  }
  const capped = ceiling.filter(action => actions.includes(action))
  if (capped.length === 0) {
    // An empty allowedAction array means EVERY action in the zcap model, so an
    // action-less request must never be built.
    throw new Error(`Collection "${id}" requests no actions.`)
  }
  return capped
}

/**
 * The one-popup App Connect VPR: DIDAuthentication + a single `AppConnectQuery`.
 *
 * The `app` block names the app -- `name` for the wallet's consent screen, and
 * `appUrl`, the application's canonical URL, which the wallet needs to MATCH an
 * existing app key or MINT a fresh one. The `appUrl` is validated and
 * serialized here against `domain` (this app's own live browser origin): it
 * must be an absolute, query- and fragment-less, same-origin URL, and the serialization is
 * what everything downstream stores and compares. `capabilityQuery` holds one
 * collection-scoped grant request per app collection -- the existing capability
 * shape MINUS `controller` (the wallet fills it with the app-key subject DID)
 * and MINUS `reason` (the App Connect consent screen supersedes per-grant
 * reasons). A `visibility: 'public'` collection uses the
 * `https://w3id.org/byoe#public-collection` descriptor type; everything else
 * uses `https://w3id.org/byoe#private-collection`.
 *
 * @param options {object}
 * @param options.challenge {string}
 * @param options.domain {string}
 * @param options.appName {string}   human-readable app name for the consent
 *   screen
 * @param options.appUrl {string}   the application's canonical URL, same-origin
 *   with `domain`, query- and fragment-less; emitted in its serialized form
 * @param options.collections {GrantRequestCollection[]}   the collections to
 *   request (PWS collection id + visibility)
 * @param [options.sharedCollections] {string[]}   PWS collection ids of
 *   wallet-owned collections to request read-and-decrypt access to; each gets
 *   a `https://w3id.org/byoe#shared-wallet-collection` descriptor with
 *   {@link SHARED_ACTIONS}
 * @param [options.actions] {string[]}   the action set to request on each app
 *   collection; when omitted each collection requests exactly its class's
 *   allowed actions ({@link actionCeiling}). An explicit set naming an action
 *   outside them throws (a configuration error, surfaced at build time rather
 *   than as a failed login)
 * @returns {IVPRDetails}
 */
export function buildAppConnectVpr({
  challenge,
  domain,
  appName,
  appUrl,
  collections,
  sharedCollections = [],
  actions
}: {
  challenge: string
  domain: string
  appName: string
  appUrl: string
  collections: GrantRequestCollection[]
  sharedCollections?: string[]
  actions?: string[]
}): IVPRDetails {
  const capabilityQuery: IAppConnectCapabilityQuery[] = collections.map(
    ({ id, visibility }) => ({
      referenceId: id,
      allowedAction: requestedActions({ id, visibility, actions }),
      invocationTarget: {
        type:
          visibility === 'public'
            ? 'https://w3id.org/byoe#public-collection'
            : 'https://w3id.org/byoe#private-collection',
        name: id
      }
    })
  )
  for (const id of sharedCollections) {
    capabilityQuery.push({
      referenceId: id,
      allowedAction: SHARED_ACTIONS,
      invocationTarget: {
        type: 'https://w3id.org/byoe#shared-wallet-collection',
        name: id
      }
    })
  }
  return {
    query: [
      {
        type: 'DIDAuthentication',
        acceptedMethods: [{ method: 'key' }]
      },
      {
        type: 'AppConnectQuery',
        app: {
          name: appName,
          appUrl: serializedAppUrl({ appUrl, origin: domain })
        },
        capabilityQuery
      }
    ],
    challenge,
    domain
  }
}
