/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
// @vitest-environment node
/**
 * Counterpart tests: both halves of the App Connect contract, run against
 * `@interop/wallet-request`'s REAL wallet-side implementation rather than
 * against a fixture of it. The request this library builds must be one the
 * wallet pipeline accepts, and the app-key credential it mints must be one
 * this library locates and parses.
 */
import { describe, expect, it } from 'vitest'
import {
  appConnectRequestOf,
  composeVp,
  mintAppKeyCredential
} from '@interop/wallet-request'
import { agentsFromSeed } from '@interop/was-client/identity'
import type {
  IVerifiableCredential,
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'
import { createDocumentLoader } from '../identity/documentLoader.js'
import {
  findSeedCredential,
  parseSeedCredential
} from '../identity/seedCredential.js'
import { buildAppConnectVpr } from './loginRequest.js'
import {
  checkGrants,
  grantsOf,
  verifyLoginPresentation
} from './verifyResponse.js'
import type { IAppConnectQuery } from './walletRequestTypes.js'

const ORIGIN = 'https://app.example'
const APP_URL = `${ORIGIN}/notes-app`
const APP_NAME = 'Example Notes'

/**
 * Wraps credentials in a minimal (unsigned) response presentation, which is
 * all the locate step reads.
 */
function presentationWith(
  credentials: IVerifiableCredential[]
): IVerifiablePresentation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiablePresentation'],
    verifiableCredential: credentials
  } as unknown as IVerifiablePresentation
}

describe('the request half, against wallet-core', () => {
  it('builds a VPR wallet-core accepts, with the app block intact', () => {
    const vpr = buildAppConnectVpr({
      challenge: crypto.randomUUID(),
      domain: ORIGIN,
      appName: APP_NAME,
      appUrl: APP_URL,
      collections: [
        { id: 'notes' },
        { id: 'microblog-posts', visibility: 'public' }
      ],
      sharedCollections: ['private-credentials']
    })
    const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
    const parsed = appConnectRequestOf({
      queries: queries as never,
      origin: ORIGIN
    })

    expect(parsed).toBeDefined()
    expect(parsed?.app).toEqual({ name: APP_NAME, appUrl: APP_URL })
    // Every descriptor survives the wallet's normalization unchanged.
    expect(parsed?.capabilityQueries).toEqual([
      {
        referenceId: 'notes',
        allowedAction: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        invocationTarget: {
          type: 'https://w3id.org/byoe#private-collection',
          name: 'notes'
        }
      },
      {
        referenceId: 'microblog-posts',
        allowedAction: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        invocationTarget: {
          type: 'https://w3id.org/byoe#public-collection',
          name: 'microblog-posts'
        }
      },
      {
        referenceId: 'private-credentials',
        allowedAction: ['GET', 'HEAD'],
        invocationTarget: {
          type: 'https://w3id.org/byoe#shared-wallet-collection',
          name: 'private-credentials'
        }
      }
    ])
  })

  it('sends the appUrl in the serialization the wallet compares on', () => {
    const vpr = buildAppConnectVpr({
      challenge: crypto.randomUUID(),
      domain: ORIGIN,
      appName: APP_NAME,
      appUrl: `${ORIGIN}:443/a/../notes-app`,
      collections: []
    })
    const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
    const sent = (
      queries.find(entry => entry.type === 'AppConnectQuery') as
        IAppConnectQuery | undefined
    )?.app.appUrl
    const parsed = appConnectRequestOf({
      queries: queries as never,
      origin: ORIGIN
    })
    expect(sent).toBe(APP_URL)
    expect(parsed?.app.appUrl).toBe(sent)
  })
})

describe('the credential half, against wallet-core', () => {
  it('locates and parses a credential wallet-core minted', async () => {
    const { credential, subjectDid } = await mintAppKeyCredential({
      app: { name: APP_NAME, appUrl: APP_URL },
      origin: ORIGIN
    })
    const located = findSeedCredential({
      presentation: presentationWith([credential]),
      appUrl: APP_URL
    })
    expect(located).toBe(credential)

    const parsed = await parseSeedCredential({
      credential: located as IVerifiableCredential,
      origin: ORIGIN,
      appUrl: APP_URL
    })
    expect(parsed.controllerDid).toBe(subjectDid)
    expect(parsed.seed).toHaveLength(32)
  })

  it('is located inside a wallet-core-composed, signed response VP', async () => {
    const { credential, subjectDid } = await mintAppKeyCredential({
      app: { name: APP_NAME, appUrl: APP_URL },
      origin: ORIGIN
    })
    // The wallet's holder identity, derived the way the wallet derives it (the
    // response VP's holder is the wallet, never the app).
    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    const wallet = await agentsFromSeed({ seed: walletSeed })
    const challenge = crypto.randomUUID()
    // A structural grant, the shape a wallet delegates to the app's controller
    // DID; the VP proof covers it, and the RP checks grant structure rather
    // than the delegation proof, so no proof of its own is needed here.
    const grant = {
      '@context': 'https://w3id.org/zcap/v1',
      id: `urn:zcap:${crypto.randomUUID()}`,
      controller: subjectDid,
      parentCapability: 'urn:zcap:root:https%3A%2F%2Fwas.example%2Fspace%2Fs1',
      invocationTarget: 'https://was.example/space/s1/notes',
      allowedAction: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
      expires: new Date(Date.now() + 86_400_000).toISOString()
    } as unknown as IZcap

    // The REAL response composition: DIDAuth-signed, grants and the App
    // Connect marker embedded before signing.
    const presentation = await composeVp({
      presentationSigner: {
        signer: wallet.keyAgent.getSigner(),
        holder: wallet.controllerDid
      },
      selectedVcs: [credential],
      challenge,
      domain: ORIGIN,
      sign: true,
      zcaps: [grant],
      appConnect: { firstRun: true }
    })

    // This library's own verification accepts wallet-core's signature ...
    await verifyLoginPresentation({
      presentation,
      challenge,
      domain: ORIGIN,
      documentLoader: createDocumentLoader()
    })

    // ... the members the login flow reads survive composition and signing ...
    expect((presentation as { appConnect?: unknown }).appConnect).toEqual({
      firstRun: true
    })
    expect(grantsOf(presentation)).toEqual([grant])

    // ... and its locate + parse recover the identity from inside the VP.
    const located = findSeedCredential({
      presentation,
      appUrl: APP_URL
    })
    expect(located).not.toBeNull()
    const parsed = await parseSeedCredential({
      credential: located!,
      origin: ORIGIN,
      appUrl: APP_URL
    })
    expect(parsed.controllerDid).toBe(subjectDid)
  })

  /**
   * The standing-credential arrangement, composed through the SAME real
   * wallet-core path. Two things differ from the baseline case above, and
   * this library deliberately inspects neither:
   *
   * - The holder is an ephemeral per-visit did:key, minted for this visit
   *   alone. It is neither the account's did:webvh nor the transient
   *   session's client-annex DID (app-connect-spec decision 0004).
   * - The grant chains one link deeper. Its parent is the generation
   *   delegation a transient session invokes under, so the chain is depth 3
   *   -- Space root, generation delegation, app grant -- delegated by an
   *   annex key that appears in no account document, and its expiry is
   *   clamped to the delegation's. Chain validity is the storage server's
   *   decision at invocation; the RP checks grant structure only.
   *
   * The adjacent did:webvh holder cases in
   * `src/identity/documentLoader.test.ts` sign their VP from a local
   * fixture rather than through wallet-core's composition, so they are
   * document-loader coverage and not counterpart coverage.
   */
  it('accepts a wallet-composed response with an annex-shaped grant', async () => {
    const { credential, subjectDid } = await mintAppKeyCredential({
      app: { name: APP_NAME, appUrl: APP_URL },
      origin: ORIGIN
    })

    // The per-visit holder: a fresh did:key, unrelated to any durable client
    // and not stable across visits.
    const visitSeed = crypto.getRandomValues(new Uint8Array(32))
    const visitor = await agentsFromSeed({ seed: visitSeed })
    const challenge = crypto.randomUUID()

    // The account Space, its root capability id, and the annex DID the
    // generation delegation is controlled by, in their wire serializations.
    const spaceUrl = 'https://was.example/space/s1'
    const spaceRootId = `urn:zcap:root:${encodeURIComponent(spaceUrl)}`
    const annexDid =
      'did:webvh:zSCID:was.example:space:annex-aux:gen-AbCdEfGhIjKlMnOp'

    // Link two of the chain: the generation delegation, rooted directly in
    // the Space root and targeting the Space's items subtree (the trailing
    // slash is what keeps the bare Space URL outside it).
    const delegationExpires = new Date(
      Date.now() + 30 * 86_400_000
    ).toISOString()
    const generationDelegation = {
      '@context': 'https://w3id.org/zcap/v1',
      id: `urn:zcap:delegated:${crypto.randomUUID()}`,
      controller: annexDid,
      parentCapability: spaceRootId,
      invocationTarget: `${spaceUrl}/`,
      allowedAction: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
      expires: delegationExpires
    }

    // Link three: the app's own grant, parented on the delegation rather
    // than on the Space root. The requested TTL outruns the delegation, so
    // the minted expiry is the clamped one.
    const requestedTtlMs = 365 * 86_400_000
    const grantExpires = new Date(
      Math.min(Date.now() + requestedTtlMs, Date.parse(delegationExpires))
    ).toISOString()
    const grant = {
      '@context': 'https://w3id.org/zcap/v1',
      id: `urn:zcap:delegated:${crypto.randomUUID()}`,
      controller: subjectDid,
      parentCapability: generationDelegation.id,
      capabilityChain: [spaceRootId, generationDelegation],
      invocationTarget: `${spaceUrl}/notes`,
      allowedAction: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
      expires: grantExpires
    } as unknown as IZcap

    const presentation = await composeVp({
      presentationSigner: {
        signer: visitor.keyAgent.getSigner(),
        holder: visitor.controllerDid
      },
      selectedVcs: [credential],
      challenge,
      domain: ORIGIN,
      sign: true,
      zcaps: [grant],
      appConnect: { firstRun: false }
    })

    // The ephemeral holder verifies like any other: nothing about it is
    // retained, and no check binds it to the account.
    await verifyLoginPresentation({
      presentation,
      challenge,
      domain: ORIGIN,
      documentLoader: createDocumentLoader()
    })
    expect((presentation as { holder?: string }).holder).toBe(
      visitor.controllerDid
    )
    expect(visitor.controllerDid.startsWith('did:key:')).toBe(true)

    // The depth-3 chain survives composition and signing verbatim.
    const returned = grantsOf(presentation)
    expect(returned).toEqual([grant])
    expect(
      (returned[0] as unknown as { capabilityChain: unknown[] }).capabilityChain
    ).toEqual([spaceRootId, generationDelegation])

    // Locate and parse recover the app's identity, and the grant checks pass
    // against it: a deeper chain and an annex delegator are non-events.
    const located = findSeedCredential({ presentation, appUrl: APP_URL })
    expect(located).not.toBeNull()
    const parsed = await parseSeedCredential({
      credential: located!,
      origin: ORIGIN,
      appUrl: APP_URL
    })
    expect(parsed.controllerDid).toBe(subjectDid)

    const checked = checkGrants({
      grants: returned,
      controllerDid: parsed.controllerDid,
      collections: [{ id: 'notes' }]
    })
    expect(checked.parsed?.baseUrl).toBe('https://was.example')
    expect(checked.parsed?.spaceId).toBe('s1')
    expect(checked.parsed?.byCollectionId['notes']).toEqual(grant)
    // The clamped expiry is what the session runs on, short of the TTL the
    // app would have asked for.
    expect(checked.expires).toBe(grantExpires)
    expect(Date.parse(checked.expires)).toBeLessThan(
      Date.now() + requestedTtlMs
    )
  })

  it('does not locate a legacy credential (it carries no appUrl)', () => {
    const legacy = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'AppKeyCredential', 'ExampleNotesAppKey'],
      issuer: 'did:example:legacy',
      credentialSubject: { id: 'did:example:legacy', origin: ORIGIN }
    } as unknown as IVerifiableCredential
    expect(
      findSeedCredential({
        presentation: presentationWith([legacy]),
        appUrl: APP_URL
      })
    ).toBeNull()
  })
})
