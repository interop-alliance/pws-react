/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * verifyResponse tests. A mock "wallet" (its own did:key identity, distinct
 * from the app's) signs presentations exactly the way freewallet does --
 * Ed25519Signature2020 DIDAuth proof over a VP with the app-key VC embedded
 * and/or a `zcap` grant array (bare term added to the context) -- and the
 * RP-side checks are exercised against good and crafted-bad inputs.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { rootCapabilityId } from '@interop/pws-client/paths'
import * as vc from '@interop/vc'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { CapabilityAgent } from '@interop/capability-agent'
import type {
  IVerifiableCredential,
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'
import { issueSeedCredential } from '../identity/seedCredential.js'
import { createDocumentLoader } from '../identity/documentLoader.js'
import { deriveIdentity } from '../identity/agents.js'
import {
  checkGrants,
  grantsOf,
  verifyLoginPresentation
} from './verifyResponse.js'

const ORIGIN = 'http://localhost:5173'
const APP_NAME = 'Test App'
const SERVER_URL = 'http://localhost:3999'
const SPACE_URL = `${SERVER_URL}/space/e2e-space`
const APP_URL = `${ORIGIN}/test-app`
const TEST_COLLECTIONS = [
  'action-items',
  'projects',
  'goals',
  'questions',
  'answers',
  'web-links',
  'thoughts',
  'current-focus'
]
// The same collections in the shape checkGrants takes (id + visibility; all
// private here, so each requires the full RW ceiling).
const TEST_COLLECTION_REQUESTS = TEST_COLLECTIONS.map(id => ({ id }))
const documentLoader = createDocumentLoader()

// The hosted App Connect context defines the response VP's `zcap` term
// exactly as the wallet emits it; the document loader resolves it statically.
const APP_CONNECT_CONTEXT_URL = 'https://w3id.org/byoe/app-connect/v1'

interface WalletIdentity {
  holder: string
  suite: Ed25519Signature2020
}

let wallet: WalletIdentity
// A second, attacker-minted did:key: a signer that is NOT the wallet, used to
// mint the validly-signed non-authentication proof of the mixed-proof tests.
let attacker: WalletIdentity
let appDid: string
let appSeed: Uint8Array

/**
 * Mints a fresh did:key identity plus its Ed25519Signature2020 suite.
 */
async function mockIdentity(handle: string): Promise<WalletIdentity> {
  const agent = await CapabilityAgent.fromSeed({
    seed: crypto.getRandomValues(new Uint8Array(32)),
    handle,
    keyName: 'wallet-key'
  })
  return {
    holder: agent.id,
    suite: new Ed25519Signature2020({ signer: agent.getSigner() })
  }
}

beforeAll(async () => {
  wallet = await mockIdentity('mock-wallet')
  attacker = await mockIdentity('mock-attacker')
  appSeed = crypto.getRandomValues(new Uint8Array(32))
  appDid = (await deriveIdentity({ seed: appSeed })).controllerDid
})

/**
 * An UNSIGNED structural grant (checkGrants is structural, not cryptographic).
 */
function grantFor({
  collectionId,
  controller = appDid,
  expires = new Date(Date.now() + 86_400_000).toISOString(),
  actions = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'],
  spaceUrl = SPACE_URL
}: {
  collectionId?: string
  controller?: string
  expires?: string
  actions?: string[]
  spaceUrl?: string
}): IZcap {
  return {
    '@context': 'https://w3id.org/zcap/v1',
    id: `urn:zcap:${crypto.randomUUID()}`,
    controller,
    parentCapability: rootCapabilityId(spaceUrl),
    invocationTarget: collectionId ? `${spaceUrl}/${collectionId}` : spaceUrl,
    allowedAction: actions,
    expires
  } as unknown as IZcap
}

/**
 * The full wallet-shaped grant set: one RW collection grant per collection.
 */
function fullGrantSet(): IZcap[] {
  return TEST_COLLECTIONS.map(id => grantFor({ collectionId: id }))
}

/**
 * Builds the UNSIGNED wallet-style VP with an optional embedded VC and zcap
 * array. Split out of {@link walletVp} so one document can be signed more than
 * once (the mixed-proof-set tests).
 */
function unsignedVp({
  credential,
  zcaps
}: {
  credential?: IVerifiableCredential
  zcaps?: IZcap[]
}): vc.Presentation {
  const presentation = vc.createPresentation({
    holder: wallet.holder,
    ...(credential && { verifiableCredential: [credential] }),
    verify: false,
    version: 1.0
  }) as { '@context': unknown; zcap?: IZcap[] }
  if (zcaps && zcaps.length > 0) {
    const base = presentation['@context']
    presentation['@context'] = [
      ...(Array.isArray(base) ? base : [base]),
      APP_CONNECT_CONTEXT_URL
    ]
    presentation.zcap = zcaps
  }
  return presentation as unknown as vc.Presentation
}

/**
 * Signs a wallet-style VP with optional embedded VC and zcap array.
 */
async function walletVp({
  challenge,
  domain = ORIGIN,
  credential,
  zcaps
}: {
  challenge: string
  domain?: string
  credential?: IVerifiableCredential
  zcaps?: IZcap[]
}): Promise<IVerifiablePresentation> {
  return (await vc.signPresentation({
    presentation: unsignedVp({
      ...(credential && { credential }),
      ...(zcaps && { zcaps })
    }),
    challenge,
    domain,
    documentLoader,
    suite: wallet.suite
  })) as IVerifiablePresentation
}

/**
 * The proof (or proof set) on a signed presentation.
 */
function proofOf(presentation: unknown): Record<string, unknown> {
  return (presentation as { proof: Record<string, unknown> }).proof
}

describe('verifyLoginPresentation', () => {
  it('accepts a wallet-signed VP with an embedded app key and grants', async () => {
    const challenge = crypto.randomUUID()
    const credential = await issueSeedCredential({
      seed: appSeed,
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const presentation = await walletVp({
      challenge,
      credential,
      zcaps: fullGrantSet()
    })
    await expect(
      verifyLoginPresentation({
        presentation,
        challenge,
        domain: ORIGIN,
        documentLoader
      })
    ).resolves.toBeUndefined()
    expect(grantsOf(presentation)).toHaveLength(TEST_COLLECTIONS.length)
  })

  it('accepts a single authentication proof', async () => {
    const challenge = crypto.randomUUID()
    const presentation = await walletVp({ challenge })
    expect(Array.isArray(proofOf(presentation))).toBe(false)
    expect(proofOf(presentation).proofPurpose).toBe('authentication')
    await expect(
      verifyLoginPresentation({
        presentation,
        challenge,
        domain: ORIGIN,
        documentLoader
      })
    ).resolves.toBeUndefined()
  })

  it('rejects a proof set led by an attacker-signed assertion proof', async () => {
    // The mixed-proof attack: a VALIDLY SIGNED assertionMethod proof (minted
    // by an attacker's own did:key) FIRST, and a fabricated authentication
    // proof -- right challenge and domain, garbage signature -- second. A
    // crypto layer that read `proof[0]` alone would select
    // AssertionProofPurpose for the whole set and never signature-check the
    // fabricated proof; verifier-core >= 3.5.3 scans every proof, selects
    // AuthenticationProofPurpose, and the garbage signature fails the
    // presentation at the crypto layer. (The library's own purpose backstop
    // is exercised by the trailing-assertion test below, where crypto
    // passes.)
    const challenge = crypto.randomUUID()
    const unsigned = unsignedVp({ zcaps: fullGrantSet() })
    const assertionSigned = await vc.signPresentation({
      presentation: structuredClone(unsigned),
      documentLoader,
      purpose: new vc.CredentialIssuancePurpose(),
      suite: attacker.suite
    })
    const authSigned = await vc.signPresentation({
      presentation: structuredClone(unsigned),
      challenge,
      domain: ORIGIN,
      documentLoader,
      suite: attacker.suite
    })
    const fabricated = {
      ...proofOf(authSigned),
      proofValue: `z${'3'.repeat(86)}`
    }
    const mixed = {
      ...(authSigned as object),
      proof: [proofOf(assertionSigned), fabricated]
    } as unknown as IVerifiablePresentation

    await expect(
      verifyLoginPresentation({
        presentation: mixed,
        challenge,
        domain: ORIGIN,
        documentLoader
      })
    ).rejects.toThrow(/Invalid signature/)
  })

  it('rejects a proof set with a trailing assertion proof', async () => {
    // The same set the other way round: the authentication proof leads (so the
    // crypto layer selects AuthenticationProofPurpose and the set verifies),
    // and the non-authentication proof still fails the set closed.
    const challenge = crypto.randomUUID()
    const unsigned = unsignedVp({ zcaps: fullGrantSet() })
    const authSigned = await vc.signPresentation({
      presentation: structuredClone(unsigned),
      challenge,
      domain: ORIGIN,
      documentLoader,
      suite: wallet.suite
    })
    const assertionSigned = await vc.signPresentation({
      presentation: structuredClone(unsigned),
      documentLoader,
      purpose: new vc.CredentialIssuancePurpose(),
      suite: attacker.suite
    })
    const mixed = {
      ...(authSigned as object),
      proof: [proofOf(authSigned), proofOf(assertionSigned)]
    } as unknown as IVerifiablePresentation

    await expect(
      verifyLoginPresentation({
        presentation: mixed,
        challenge,
        domain: ORIGIN,
        documentLoader
      })
    ).rejects.toThrow(/non-authentication proof/)
  })

  it('rejects a challenge mismatch', async () => {
    const presentation = await walletVp({ challenge: 'sent-nonce' })
    await expect(
      verifyLoginPresentation({
        presentation,
        challenge: 'other-nonce',
        domain: ORIGIN,
        documentLoader
      })
    ).rejects.toThrow()
  })

  it('rejects a domain mismatch', async () => {
    const challenge = crypto.randomUUID()
    const presentation = await walletVp({
      challenge,
      domain: 'https://evil.example'
    })
    await expect(
      verifyLoginPresentation({
        presentation,
        challenge,
        domain: ORIGIN,
        documentLoader
      })
    ).rejects.toThrow(/domain/)
  })

  it('rejects a tampered presentation', async () => {
    const challenge = crypto.randomUUID()
    const presentation = await walletVp({
      challenge,
      zcaps: fullGrantSet()
    })
    const tampered = {
      ...presentation,
      zcap: [
        ...(presentation as unknown as { zcap: IZcap[] }).zcap.slice(1),
        grantFor({
          collectionId: 'injected',
          controller: 'did:example:mallory'
        })
      ]
    } as IVerifiablePresentation
    await expect(
      verifyLoginPresentation({
        presentation: tampered,
        challenge,
        domain: ORIGIN,
        documentLoader
      })
    ).rejects.toThrow()
  })

  it('rejects an unsigned presentation', async () => {
    const presentation = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation']
    } as unknown as IVerifiablePresentation
    await expect(
      verifyLoginPresentation({
        presentation,
        challenge: 'x',
        domain: ORIGIN,
        documentLoader
      })
    ).rejects.toThrow()
  })

  it('rejects a tampered embedded credential', async () => {
    const challenge = crypto.randomUUID()
    const credential = await issueSeedCredential({
      seed: appSeed,
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const subject = credential.credentialSubject as Record<string, unknown>
    const tamperedVc = {
      ...credential,
      credentialSubject: { ...subject, origin: 'https://evil.example' }
    } as IVerifiableCredential
    const presentation = await walletVp({ challenge })
    ;(presentation as { verifiableCredential?: unknown }).verifiableCredential =
      [tamperedVc]
    await expect(
      verifyLoginPresentation({
        presentation,
        challenge,
        domain: ORIGIN,
        documentLoader
      })
    ).rejects.toThrow()
  })
})

describe('checkGrants', () => {
  it('accepts the full wallet grant set and reports topology + expiry', () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    const later = new Date(Date.now() + 86_400_000).toISOString()
    const grants = TEST_COLLECTIONS.map((id, index) =>
      grantFor({ collectionId: id, expires: index === 0 ? soon : later })
    )
    const checked = checkGrants({
      grants,
      controllerDid: appDid,
      collections: TEST_COLLECTION_REQUESTS
    })
    expect(checked.parsed?.spaceUrl).toBe(`${SPACE_URL}/`)
    expect(Object.keys(checked.parsed!.byCollectionId)).toHaveLength(
      TEST_COLLECTIONS.length
    )
    expect(checked.expires).toBe(soon)
  })

  it('rejects an empty grant set', () => {
    expect(() =>
      checkGrants({
        grants: [],
        controllerDid: appDid,
        collections: TEST_COLLECTION_REQUESTS
      })
    ).toThrow(/no storage grants/)
  })

  it('rejects a grant controlled by another DID', () => {
    const grants = fullGrantSet()
    ;(grants[0] as { controller: string }).controller = 'did:example:mallory'
    expect(() =>
      checkGrants({
        grants,
        controllerDid: appDid,
        collections: TEST_COLLECTION_REQUESTS
      })
    ).toThrow(/controlled by/)
  })

  it('rejects an expired grant', () => {
    const grants = fullGrantSet()
    ;(grants[2] as { expires: string }).expires = new Date(
      Date.now() - 1000
    ).toISOString()
    expect(() =>
      checkGrants({
        grants,
        controllerDid: appDid,
        collections: TEST_COLLECTION_REQUESTS
      })
    ).toThrow(/expired/)
  })

  it('rejects a grant set spanning two spaces', () => {
    const grants = fullGrantSet()
    grants.push(
      grantFor({
        collectionId: 'projects',
        spaceUrl: `${SERVER_URL}/space/other-space`
      })
    )
    expect(() =>
      checkGrants({
        grants,
        controllerDid: appDid,
        collections: TEST_COLLECTION_REQUESTS
      })
    ).toThrow(/two Spaces/)
  })

  it('rejects a set missing a collection', () => {
    const grants = TEST_COLLECTIONS.slice(1).map(id =>
      grantFor({ collectionId: id })
    )
    expect(() =>
      checkGrants({
        grants,
        controllerDid: appDid,
        collections: TEST_COLLECTION_REQUESTS
      })
    ).toThrow(new RegExp(`No grant covers the "${TEST_COLLECTIONS[0]}"`))
  })

  it('rejects a collection grant with insufficient actions', () => {
    const grants = fullGrantSet()
    ;(grants[0] as { allowedAction: string[] }).allowedAction = ['GET', 'HEAD']
    expect(() =>
      checkGrants({
        grants,
        controllerDid: appDid,
        collections: TEST_COLLECTION_REQUESTS
      })
    ).toThrow(/lacks required actions/)
  })

  it('accepts a full-vocabulary grant on a public collection', () => {
    // A public collection allows the same actions as a private one, so the
    // default RW requirement is met outright.
    const grants = [
      grantFor({
        collectionId: 'posts',
        actions: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']
      })
    ]
    const checked = checkGrants({
      grants,
      controllerDid: appDid,
      collections: [{ id: 'posts', visibility: 'public' }]
    })
    expect(Object.keys(checked.parsed!.byCollectionId)).toEqual(['posts'])
  })

  it('rejects a public-collection grant missing a required write action', () => {
    const grants = [
      grantFor({ collectionId: 'posts', actions: ['GET', 'HEAD', 'POST'] })
    ]
    expect(() =>
      checkGrants({
        grants,
        controllerDid: appDid,
        collections: [{ id: 'posts', visibility: 'public' }]
      })
    ).toThrow(/lacks required actions: PUT, DELETE/)
  })

  it('accepts an add-only public grant when only add-only is required', () => {
    // The requirement is the app's own; a narrower one is met by the narrower
    // grant a wallet returned for it.
    const grants = [
      grantFor({ collectionId: 'posts', actions: ['GET', 'HEAD', 'POST'] })
    ]
    expect(() =>
      checkGrants({
        grants,
        controllerDid: appDid,
        collections: [{ id: 'posts', visibility: 'public' }],
        requiredActions: ['GET', 'HEAD', 'POST']
      })
    ).not.toThrow()
  })
})
