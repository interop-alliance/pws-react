/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * PWS master-identity derivation from a 32-byte master seed.
 *
 * SEED-DERIVATION CONVENTION (pinned, part of the shared-key contract): the
 * pinned `@interop/capability-agent` exposes `CapabilityAgent.fromSeed({ seed })`,
 * which takes the raw 32 bytes AS-IS (no hashing). We use it for the master
 * identity, feeding raw bytes -- never `fromSecret`, which salt-hashes a STRING
 * and would derive a different key for a byte array vs its text form.
 *
 * WHAT SELECTS THE KEY (verified against `CapabilityAgent.fromSeed`): the key
 * material is derived from the `seed` bytes (the HMAC key) and the `keyName`
 * string (the HMAC message) alone. The `handle` is stored on the returned agent
 * as a cosmetic identifier and does NOT enter key derivation -- nor the derived
 * did:key id, which is the fingerprint of the seed+keyName key pair. So the
 * PINNED derivation inputs are the seed bytes and the `keyName` value
 * (`IDENTITY_KEY_NAME` below); changing THAT after first use is a data-migration
 * event. The `identityHandle` parameter is safe to change and exists only so an
 * app can supply a label for cosmetic continuity; it does not affect the
 * identity, keys, or any stored data.
 *
 * ONE KEY IDENTITY answers for encryption everywhere: the app's IDENTITY
 * key-agreement key (KAK), derived here as the X25519 (Montgomery) twin of the
 * did:key controller. One per app identity, and the single rule for every
 * key-epoch roster entry -- a recipient is always the X25519 twin of a
 * controller did:key, whether the collection is one the app provisioned or one
 * the wallet SHARED with it. Both sides of a share derive it independently, so
 * it never travels on the wire.
 *
 * Earlier versions used a second identity for app-provisioned collections: a
 * per-collection KAK, HKDF-derived from the master seed under the collection id
 * (`deriveCollectionKeys`, label `kak:v1:<collectionId>`). That derivation has
 * been removed from `@interop/wallet-core/identity`. Unifying cost
 * the HKDF domain separation between collections -- the identity KAK now reads
 * every collection the app touches. In the multi-recipient model that key only
 * unwraps an epoch secret rather than being the content key, and the seed it was
 * derived from is persisted in the same process anyway, so the separation bought
 * less than it looked like; what it genuinely served -- handing one collection's
 * key to a third party -- is what key-epoch rosters replaced.
 *
 * Not test-node-safe on React Native, but fine under Node/Vitest: the crypto
 * stack (`capability-agent`, `x25519-key-agreement-key`) runs on the standard Web
 * Crypto that Node 24 provides.
 */
import { CapabilityAgent } from '@interop/capability-agent'
import type { ZcapClient } from '@interop/ezcap'
import { agentsFromKeyAgent } from '@interop/pws-client/identity'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'

/**
 * Default cosmetic label for the master identity agent. Local naming only (does
 * not affect key material or the derived did:key); safe to override.
 */
export const DEFAULT_IDENTITY_HANDLE = 'was-react'

// PINNED key-derivation input (the HMAC message that, with the seed, selects
// the key). Changing it after first use is a data-migration event.
const IDENTITY_KEY_NAME = 'app-key'

/**
 * The agents derived from the master seed: the app's stable did:key controller,
 * its signing agent, a ZcapClient for signing storage requests later, and the
 * app's IDENTITY key-agreement key (KAK) plus its resolver.
 *
 * The identity KAK is the X25519 twin (Montgomery form) of the did:key
 * controller's Ed25519 key -- ONE key for the whole app identity, not one per
 * collection. It is the recipient identity a wallet writes into the key-epoch
 * roster of ANY collection this app reads: one it provisioned for the app, or
 * one of the wallet's own that it SHARES with the app (the wallet derives the
 * same key from the controller did:key alone, so the `id` /
 * `publicKeyMultibase` match byte-for-byte and nothing has to travel on the
 * wire). It is also what the local replica's EDV ciphers are built on.
 */
export interface IdentityAgents {
  controllerDid: string
  keyAgent: CapabilityAgent
  zcapClient: ZcapClient
  /**
   * The app's identity KAK: the X25519 twin of its did:key controller.
   */
  keyAgreementKey: IKeyAgreementKey
  /**
   * The one-key resolver answering for {@link IdentityAgents.keyAgreementKey}.
   */
  keyResolver: IKeyResolver
}

/**
 * Enforces the 32-byte master seed rule; the one check every seed consumer
 * (identity derivation, credential self-issue) runs before touching the bytes.
 */
export function assertSeedLength(seed: Uint8Array): void {
  if (seed.length !== 32) {
    throw new Error(`Master seed must be 32 bytes (got ${seed.length}).`)
  }
}

/**
 * Derives the master identity agents from the master seed. The did:key
 * controller is stable across devices for the same seed.
 *
 * @param options {object}
 * @param options.seed {Uint8Array}   the 32-byte master seed
 * @param [options.identityHandle] {string}   cosmetic agent label; does not
 *   affect keys or the derived DID (defaults to `DEFAULT_IDENTITY_HANDLE`)
 * @returns {Promise<IdentityAgents>}
 */
export async function deriveIdentity({
  seed,
  identityHandle = DEFAULT_IDENTITY_HANDLE
}: {
  seed: Uint8Array
  identityHandle?: string
}): Promise<IdentityAgents> {
  assertSeedLength(seed)
  const keyAgent = await CapabilityAgent.fromSeed({
    seed,
    handle: identityHandle,
    keyName: IDENTITY_KEY_NAME
  })
  // The assembly (signer, ZcapClient, the Ed25519-to-X25519 Montgomery
  // conversion of the controller key pair, key resolver) is shared with the
  // wallet side via `agentsFromKeyAgent`, so the conversion that both sides of
  // a share must agree on has exactly one implementation. Only the pinned
  // derivation inputs above (seed bytes + keyName) stay local.
  return { ...agentsFromKeyAgent({ keyAgent }), keyAgent }
}
