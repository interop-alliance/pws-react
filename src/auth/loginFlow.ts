/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The Login-With-Wallet orchestration: one-popup App Connect.
 *
 * A single CHAPI `get` carries the {@link buildAppConnectVpr} request. The
 * wallet -- in the same round -- matches an existing app key or mints a fresh
 * one (the first-run branch is wallet-internal now), then returns the app-key
 * credential and the delegated zcaps embedded in one signed response VP. So
 * there is no second store popup and no separate grants popup:
 *
 * - Returning: the wallet returns the credential; we recover the seed and
 *   verify its self-issue/origin/DID binding.
 * - First run: the wallet mints the seed, self-issues the same-shaped
 *   credential, and marks `presentation.appConnect.firstRun`.
 *
 * A wallet that predates `AppConnectQuery` cannot satisfy it and returns no
 * app-key credential; that surfaces as {@link WalletUnsupportedError} (fail
 * closed, legibly), distinct from a user cancel (a null CHAPI response).
 *
 * Hot restore (seed + grants already persisted locally) never reaches this
 * module -- the caller's session restore short-circuits it.
 */
import type {
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'
import { serializedAppUrl } from '@interop/wallet-request'
import type { DocumentLoader } from '../identity/documentLoader.js'
import {
  findSeedCredential,
  parseSeedCredential
} from '../identity/seedCredential.js'
import { NO_EXPIRY_MS } from '../identity/appSession.js'
import type { IdentityAgents } from '../identity/agents.js'
import { chapiGet } from './chapi.js'
import {
  buildAppConnectVpr,
  newChallenge,
  type GrantRequestCollection
} from './loginRequest.js'
import {
  checkGrants,
  grantsOf,
  verifyLoginPresentation,
  type CheckedGrants
} from './verifyResponse.js'
import type { ParsedGrants } from '../grants.js'
import { log } from '../log.js'

/**
 * The cohesive configuration for a Login-With-Wallet flow. App-specific values
 * are injected here rather than baked in; this becomes part of the library's
 * central app config later.
 */
export interface LoginConfig {
  /**
   * This app's own web origin (the anti-phishing bind on the app key).
   */
  appOrigin: string
  /**
   * Human-readable app name, used in the wallet consent reason lines.
   */
  appName: string
  /**
   * This app's canonical URL: the application's identity among the
   * applications on its origin. It must be an absolute URL, carry no query or fragment,
   * and be same-origin with `appOrigin`; the flow serializes it once and uses
   * that serialization for the request, the credential lookup, and the parse
   * check alike.
   */
  appUrl: string
  /**
   * The collections to request read/write grants for (PWS collection id +
   * visibility; `'public'` selects the `https://w3id.org/byoe#public-collection` descriptor).
   */
  collections: GrantRequestCollection[]
  /**
   * PWS collection ids of wallet-owned collections to request read-and-decrypt
   * access to (the `https://w3id.org/byoe#shared-wallet-collection` grant).
   * Read-only; never replicated.
   */
  sharedCollections?: string[]
  /**
   * The JSON-LD document loader (see `createDocumentLoader`).
   */
  documentLoader: DocumentLoader
  /**
   * The CHAPI mediator base URL (defaults to `DEFAULT_MEDIATOR_BASE`).
   */
  mediatorBase?: string
}

/**
 * A user-facing progress phase, for the login page's status line. The one-popup
 * App Connect flow has just two: `connecting` (building the request and awaiting
 * the wallet) and `verifying` (checking the wallet's response).
 */
export type LoginPhase = 'connecting' | 'verifying'

export interface LoginOutcome {
  seed: Uint8Array
  identity: IdentityAgents
  grants: IZcap[]
  /**
   * The storage topology the grants name; absent for a grant-less login (see
   * `CheckedGrants.parsed`).
   */
  parsed?: ParsedGrants
  /**
   * ISO timestamp: the earliest expiry across the grants.
   */
  expires: string
  /**
   * Whether this login created a brand-new app key (first run).
   */
  firstRun: boolean
}

/**
 * Thrown when the user cancels/dismisses a wallet popup.
 */
export class LoginCancelledError extends Error {
  constructor(step: string) {
    super(`The wallet request was cancelled (${step}).`)
    this.name = 'LoginCancelledError'
  }
}

/**
 * Thrown when the wallet answered but returned no app-key credential -- the
 * fail-closed signal that the wallet predates `AppConnectQuery` (it rendered the
 * query unsatisfiable). Distinct from a user cancel so the UI can prompt an
 * update instead of showing a generic verification error.
 */
export class WalletUnsupportedError extends Error {
  constructor() {
    super(
      'Your wallet does not support App Connect yet; update Freewallet to ' +
        'log in.'
    )
    this.name = 'WalletUnsupportedError'
  }
}

/**
 * Reads the wallet-provided `presentation.appConnect.firstRun` boolean. Anything
 * other than boolean `true` (including an absent member -- a returning login) is
 * treated as `false`.
 */
function appConnectFirstRun(presentation: IVerifiablePresentation): boolean {
  const appConnect = (presentation as { appConnect?: { firstRun?: unknown } })
    .appConnect
  return appConnect?.firstRun === true
}

/**
 * Structurally validates the grants embedded in the wallet response against the
 * requested collections. When the app requested no APP-OWNED collections and
 * the wallet returned no grants there is nothing to validate: `checkGrants`
 * (which rejects an empty grant set) is skipped and an empty grant set with a
 * far-future expiry is returned instead. That covers both the app that
 * requests nothing at all and the shared-only app (`collections: []`, some
 * `sharedCollections`) whose user declined every share -- a declined share is
 * not a login failure, so such a login completes with no remote storage and
 * the missing readers are warned about downstream.
 *
 * Only the app-owned collections are REQUIRED to be covered, each at its own
 * class ceiling: the collections are passed to `checkGrants` with their
 * declared visibility (both classes allow the full action vocabulary, so the
 * ceiling narrows only what the app itself requested). A shared collection the
 * wallet declined to grant is not a login failure -- the reader for it is simply not
 * opened, with a warning -- so it is not passed to `checkGrants`; it still
 * reaches the routing table through `parseGrants`.
 *
 * @param options {object}
 * @param options.presentation {IVerifiablePresentation}
 * @param options.controllerDid {string}   the app-key subject DID grants must
 *   be controlled by
 * @param options.collections {GrantRequestCollection[]}
 * @param [options.sharedCollections] {string[]}
 * @returns {CheckedGrants}
 */
function checkGrantsForCollections({
  presentation,
  controllerDid,
  collections,
  sharedCollections = []
}: {
  presentation: IVerifiablePresentation
  controllerDid: string
  collections: GrantRequestCollection[]
  sharedCollections?: string[]
}): CheckedGrants {
  const grants = grantsOf(presentation)
  if (collections.length === 0 && grants.length === 0) {
    if (sharedCollections.length > 0) {
      log.warn(
        'The wallet returned no storage grants; the requested shared ' +
          'collections were declined, so no shared reader will be opened.',
        { sharedCollections }
      )
    }
    return {
      grants: [],
      expires: new Date(Date.now() + NO_EXPIRY_MS).toISOString()
    }
  }
  return checkGrants({
    grants,
    controllerDid,
    collections
  })
}

/**
 * This app's live browser origin: the value sent as the request `domain`, the
 * origin the `appUrl` is validated against, and the origin the returned
 * credential's `origin` claim is checked against. The App Connect spec requires
 * all three to be the same value, and requires it to be the origin the app is
 * actually running on rather than one taken from configuration -- so a
 * configured `appOrigin` that drifts from it is warned about here and never
 * used as the bind.
 *
 * @param config {LoginConfig}
 * @returns {string}
 */
function liveOrigin(config: LoginConfig): string {
  const origin = window.location.origin
  if (config.appOrigin !== origin) {
    log.warn(
      "The configured appOrigin differs from this app's live browser origin; " +
        'the live origin is what binds.',
      { appOrigin: config.appOrigin, origin }
    )
  }
  return origin
}

/**
 * Runs one App Connect round trip: builds the VPR, opens the single CHAPI `get`
 * popup, and verifies the response presentation (cryptographically, plus the
 * challenge/domain binds). Shared by the full login and the reconnect re-grant
 * -- the same request either way; they differ only in what they take from the
 * verified presentation, and in the step a user cancel names.
 *
 * The `challenge` is a fresh, unpredictable nonce per call (never reused), and
 * is retained for the response check. The serialized `appUrl` actually sent is
 * returned alongside the presentation, so the credential lookup and the parse
 * check compare against the very same string.
 *
 * @param options {object}
 * @param options.config {LoginConfig}
 * @param options.cancelStep {string}   the step a cancel is reported against
 * @param [options.onPhase] {Function}
 * @returns {Promise<{ presentation: IVerifiablePresentation, origin: string,
 *   appUrl: string }>}
 */
async function runAppConnect({
  config,
  cancelStep,
  onPhase
}: {
  config: LoginConfig
  cancelStep: string
  onPhase?: (phase: LoginPhase) => void
}): Promise<{
  presentation: IVerifiablePresentation
  origin: string
  appUrl: string
}> {
  onPhase?.('connecting')
  const challenge = newChallenge()
  const origin = liveOrigin(config)
  // Serialized once, here, and threaded to every comparison downstream.
  const appUrl = serializedAppUrl({ appUrl: config.appUrl, origin })
  const vpr = buildAppConnectVpr({
    challenge,
    domain: origin,
    appName: config.appName,
    appUrl,
    collections: config.collections,
    ...(config.sharedCollections && {
      sharedCollections: config.sharedCollections
    })
  })
  const presentation = await chapiGet({
    vpr,
    ...(config.mediatorBase !== undefined && {
      mediatorBase: config.mediatorBase
    })
  })
  if (!presentation) {
    throw new LoginCancelledError(cancelStep)
  }
  onPhase?.('verifying')
  await verifyLoginPresentation({
    presentation,
    challenge,
    domain: origin,
    documentLoader: config.documentLoader
  })
  return { presentation, origin, appUrl }
}

/**
 * Re-requests storage grants for `identity` over a fresh App Connect popup and
 * validates them. The expired-access reconnect path: the seed already exists, so
 * only the grants need renewing. The wallet matches the same app key and
 * re-delegates; the returned credential/`appConnect` marker are ignored here.
 *
 * @param options {object}
 * @param options.identity {IdentityAgents}
 * @param options.config {LoginConfig}
 * @param [options.onPhase] {Function}
 * @returns {Promise<CheckedGrants>}
 */
export async function requestGrants({
  identity,
  config,
  onPhase
}: {
  identity: IdentityAgents
  config: LoginConfig
  onPhase?: (phase: LoginPhase) => void
}): Promise<CheckedGrants> {
  const { presentation } = await runAppConnect({
    config,
    cancelStep: 'storage grants',
    ...(onPhase && { onPhase })
  })
  return checkGrantsForCollections({
    presentation,
    controllerDid: identity.controllerDid,
    collections: config.collections,
    ...(config.sharedCollections && {
      sharedCollections: config.sharedCollections
    })
  })
}

/**
 * Runs the one-popup Login-With-Wallet (App Connect) flow. A single CHAPI `get`
 * returns the app-key credential (matched or minted wallet-side) plus the
 * delegated grants in one signed VP. Throws `LoginCancelledError` on a user
 * cancel (a null CHAPI response), `WalletUnsupportedError` when the wallet
 * answered but returned no app key (an old wallet that could not satisfy
 * `AppConnectQuery`), and `Error` on any verification failure. Nothing is
 * persisted here (the caller persists).
 *
 * @param options {object}
 * @param options.config {LoginConfig}
 * @param [options.onPhase] {Function}
 * @returns {Promise<LoginOutcome>}
 */
export async function loginWithWallet({
  config,
  onPhase
}: {
  config: LoginConfig
  onPhase?: (phase: LoginPhase) => void
}): Promise<LoginOutcome> {
  const { presentation, origin, appUrl } = await runAppConnect({
    config,
    cancelStep: 'wallet login',
    ...(onPhase && { onPhase })
  })

  // The wallet mints the app key on first run, so a response with no app-key
  // credential is not first run -- it is a wallet that could not satisfy
  // `AppConnectQuery` at all. Fail closed, legibly, rather than as a generic
  // verification error. Located by the `appUrl` claim alone; a returned
  // credential that is wrong in any other way throws from the parse below
  // rather than reading here as "nothing returned".
  const credential = findSeedCredential({ presentation, appUrl })
  if (!credential) {
    throw new WalletUnsupportedError()
  }
  // Recover the seed, enforcing the marker type, the appUrl match, self-issue,
  // the origin bind, and the seed-to-DID binding (the same contract whether the
  // wallet matched or minted the credential).
  const parsedCredential = await parseSeedCredential({
    credential,
    origin,
    appUrl
  })
  const seed = parsedCredential.seed
  const firstRun = appConnectFirstRun(presentation)

  // The master identity comes off the parse, which already derived it from this
  // seed to check the seed-to-DID binding (the same `deriveIdentity` call, and
  // the same 32-byte seed rule, every other session path applies).
  const identity = parsedCredential.identity
  // Grants ride in the SAME response; validate them against the app-key subject
  // DID the wallet delegated to.
  const checked = checkGrantsForCollections({
    presentation,
    controllerDid: parsedCredential.controllerDid,
    collections: config.collections,
    ...(config.sharedCollections && {
      sharedCollections: config.sharedCollections
    })
  })
  return {
    seed,
    identity,
    grants: checked.grants,
    ...(checked.parsed && { parsed: checked.parsed }),
    expires: checked.expires,
    firstRun
  }
}
