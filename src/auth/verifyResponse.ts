/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Requester-side verification of a wallet's Login-With-Wallet response VP.
 * The requester (an app, service, or agent) is the party that sent the
 * request; here it is the app running this library.
 *
 * Layered checks:
 * 1. Cryptographic: `@interop/verifier-core` `verifyPresentation` (the VP's
 *    DIDAuth proof plus every embedded VC proof; the default crypto service
 *    covers Ed25519Signature2020 and eddsa-rdfc-2022, the two suites the
 *    wallet mints). `registries: []` disables issuer-registry lookup (the
 *    app-key credential is self-issued by design).
 * 2. Manual proof checks verifier-core does not make: `proofPurpose` is
 *    `authentication`, `domain` equals what this app sent (its origin), and
 *    the `challenge` echoes this request's fresh nonce.
 * 3. Grant structure: every zcap is controlled by OUR seed-derived DID, carries
 *    a single non-empty string `invocationTarget`, targets a collection (never
 *    the Space itself or a reserved sub-endpoint) in a single space on a single
 *    WAS host, is unexpired, and the collection set is fully covered with
 *    sufficient actions -- where "sufficient" is capped at each collection
 *    class's allowed actions (the App Connect spec's "Allowed actions" table).
 *    Both collection classes allow the full vocabulary today, so the cap bounds
 *    nothing at present; it stays because the spec forbids failing a connection
 *    over an action the requested class never allows, which a correct wallet
 *    would be obliged to withhold.
 *    Chain depth, the parent capability, and the delegator's DID form are
 *    deliberately not inspected here; validity at invocation is the storage
 *    server's decision. ARCHITECTURE.md's "Grant checks and the skip
 *    condition" section states that intent and its consequences.
 *
 * Note on holder binding: for an ordinary DIDAuth request the wallet signs
 * the VP as ITS holder DID -- did:webvh, did:web (the did:webvh log's
 * projection id, same key), or did:key -- chosen by the wallet from the
 * request's `acceptedMethods`. An App Connect response is pinned to the
 * wallet client's did:key by construction, so it never dispatches on
 * `acceptedMethods`. Either way the holder is not this app's controller DID,
 * which never leaves this app. The seed-to-identity binding is enforced
 * instead by `parseSeedCredential` (issuer === subject === DID derived from
 * the embedded seed) and by every grant's `controller` being the requested
 * controller DID.
 */
import { verifyPresentation } from '@interop/verifier-core'
import type {
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'
import type { DocumentLoader } from '../identity/documentLoader.js'
import { parseGrants, type ParsedGrants } from '../grants.js'
import { earliestExpiry, isExpired } from '../identity/appSession.js'
import { asArray } from '../jsonLd.js'
import {
  actionCeiling,
  RW_ACTIONS,
  type GrantRequestCollection
} from './loginRequest.js'
import { log } from '../log.js'

/**
 * Verifies a login response VP cryptographically and structurally (steps 1-2
 * above). Throws on any failure.
 *
 * @param options {object}
 * @param options.presentation {IVerifiablePresentation}
 * @param options.challenge {string}   the fresh nonce this app sent
 * @param options.domain {string}      the domain this app sent (its origin)
 * @param options.documentLoader {DocumentLoader}
 * @returns {Promise<void>}
 */
export async function verifyLoginPresentation({
  presentation,
  challenge,
  domain,
  documentLoader
}: {
  presentation: IVerifiablePresentation
  challenge: string
  domain: string
  documentLoader: DocumentLoader
}): Promise<void> {
  const result = await verifyPresentation({
    presentation,
    challenge,
    registries: [],
    documentLoader
  })
  if (!result.verified) {
    const failures = [
      ...result.presentationResults,
      ...result.credentialResults.flatMap(c => c.results)
    ].flatMap(check =>
      check.outcome.status === 'failure'
        ? [{ check: check.id, problems: check.outcome.problems }]
        : []
    )
    // The thrown message surfaces in the login UI; the per-check problem
    // details are diagnostics. The presentation itself is NOT logged: it
    // carries credential contents (an App Connect response embeds the app key
    // and its seed), which no log sink may receive.
    log.error('Wallet presentation failed verification.')
    log.error('Failing checks.', { failures })
    const summary = failures
      .map(failure => {
        const detail = failure.problems
          .map(problem => problem.detail || problem.title)
          .filter(Boolean)
          .join('; ')
        return detail ? `${failure.check}: ${detail}` : failure.check
      })
      .join(', ')
    throw new Error(
      `Wallet presentation failed verification (${summary || 'unknown check'}).`
    )
  }

  // The presentation-level proofs (a VP may carry one object or several).
  const proofs = asArray((presentation as { proof?: unknown }).proof) as Array<{
    proofPurpose?: string
    challenge?: string
    domain?: string
  }>
  if (proofs.length === 0) {
    throw new Error('Wallet presentation carries no authentication proof.')
  }
  // Belt-and-suspenders against a mixed proof set: the crypto layer selects ONE
  // purpose for the whole set and skips non-matching proofs, so a proof under
  // any OTHER purpose is one this verification may never have signature-checked
  // -- and the challenge/domain checks below are only meaningful on a proof
  // that provably verified. Requiring every presentation-level proof to be an
  // authentication proof keeps this library failing closed even against an
  // older `@interop/verifier-core` whose purpose selection reads `proof[0]`
  // alone (a VP ordered `[assertionMethod, authentication]` would otherwise
  // verify under AssertionProofPurpose with the authentication proof -- the
  // only freshness bind -- never touched by a signature check).
  if (proofs.some(proof => proof.proofPurpose !== 'authentication')) {
    throw new Error(
      'Wallet presentation carries a non-authentication proof; every ' +
        'presentation-level proof must be an authentication proof.'
    )
  }
  // Every proof in the set was verified under AuthenticationProofPurpose, so
  // require the fresh challenge and this app's domain on each of them.
  for (const proof of proofs) {
    if (proof.challenge !== challenge) {
      throw new Error('Wallet presentation challenge does not match.')
    }
    if (proof.domain !== domain) {
      throw new Error(
        `Wallet presentation domain "${proof.domain ?? ''}" does not match "${domain}".`
      )
    }
  }
}

/**
 * Extracts the delegated zcaps from a wallet response VP (`zcap` array).
 */
export function grantsOf(presentation: IVerifiablePresentation): IZcap[] {
  const zcap = (presentation as { zcap?: unknown }).zcap
  if (!Array.isArray(zcap)) {
    return []
  }
  return zcap as IZcap[]
}

/**
 * A validated grant set: parsed topology plus the earliest expiry.
 */
export interface CheckedGrants {
  /**
   * The storage topology the grants name. Absent for a grant-less login (an
   * app requesting no collections, or a shared-only app whose user declined
   * every share): such a session names no server and no Space.
   */
  parsed?: ParsedGrants
  grants: IZcap[]
  /**
   * ISO timestamp: the earliest expiry across the grants.
   */
  expires: string
}

/**
 * The actions a grant allows, normalized to an array.
 */
function actionsOf(zcap: IZcap): string[] {
  return asArray((zcap as { allowedAction?: string | string[] }).allowedAction)
}

/**
 * Structural validation of the granted zcaps (step 3 above). Throws on any
 * failure; returns the parsed topology and the earliest expiry on success.
 *
 * @param options {object}
 * @param options.grants {IZcap[]}
 * @param options.controllerDid {string}   this app's seed-derived DID
 * @param options.collections {GrantRequestCollection[]}   the collections that
 *   must be covered (WAS collection id + visibility; the visibility selects
 *   the class's allowed actions the required actions are capped at)
 * @param [options.requiredActions] {string[]}   the actions each collection
 *   grant must allow, capped per collection at its class's allowed actions
 *   (defaults to `RW_ACTIONS`, so each collection requires exactly them)
 * @returns {CheckedGrants}
 */
export function checkGrants({
  grants,
  controllerDid,
  collections,
  requiredActions = RW_ACTIONS
}: {
  grants: IZcap[]
  controllerDid: string
  collections: GrantRequestCollection[]
  requiredActions?: string[]
}): CheckedGrants {
  if (grants.length === 0) {
    throw new Error('The wallet returned no storage grants.')
  }
  for (const grant of grants) {
    const controller = (grant as { controller?: unknown }).controller
    if (controller !== controllerDid) {
      throw new Error(
        `A grant is controlled by "${String(controller)}", not this app's DID.`
      )
    }
    const expires = (grant as { expires?: unknown }).expires
    if (typeof expires !== 'string' || isExpired(expires)) {
      throw new Error('A grant is missing an expiry or is already expired.')
    }
  }

  // Asserts a single server (base URL, sub-path mount included) and a single
  // space across all grants, and builds the per-collection routing table. The
  // wallet decides where the user's Space lives; the sync layer derives its
  // target from the grants.
  const parsed = parseGrants(grants)

  for (const { id, visibility } of collections) {
    const grant = parsed.byCollectionId[id]
    if (!grant) {
      throw new Error(`No grant covers the "${id}" collection.`)
    }
    const actions = actionsOf(grant)
    // The requirement is capped at the class's allowed actions: an app must
    // never fail a connection over an action its requested class never allows,
    // since a conformant wallet is obliged to withhold it.
    const required = actionCeiling(visibility).filter(action =>
      requiredActions.includes(action)
    )
    const missing = required.filter(action => !actions.includes(action))
    if (missing.length > 0) {
      throw new Error(
        `The "${id}" grant lacks required actions: ${missing.join(', ')}.`
      )
    }
  }

  const expires = earliestExpiry(grants)
  if (!expires) {
    throw new Error('No grant carries a parseable expiry.')
  }
  return { parsed, grants, expires }
}
