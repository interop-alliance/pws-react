/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * loginWithWallet tests for the one-popup App Connect flow. A mock "wallet"
 * (its own did:key holder identity) signs a single response VP the way
 * freewallet does -- the app-key credential embedded in `verifiableCredential`,
 * the delegated zcaps in a top-level `zcap` array, and the wallet-provided
 * `appConnect.firstRun` member -- and the RP-side login is driven against it
 * with the CHAPI `get` mocked.
 *
 * Covered: a returning login (firstRun false), a first-run login (firstRun read
 * from `presentation.appConnect`), the fail-closed old-wallet case (a VP with no
 * app key surfaces `WalletUnsupportedError`, not a generic verification error),
 * and a user cancel (a null CHAPI response surfaces `LoginCancelledError`).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import type { LoginConfig } from './loginFlow.js'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../log.js'

// The login flow reads `window.location.origin` for the request domain; this
// suite runs in the default node environment (crypto/VP signing), so stub a
// minimal window before importing the flow.
const ORIGIN = 'http://localhost:3000'
;(globalThis as { window?: unknown }).window = {
  location: { origin: ORIGIN }
}

vi.mock('./chapi.js', () => ({ chapiGet: vi.fn() }))

const { chapiGet } = await import('./chapi.js')
const { loginWithWallet, LoginCancelledError, WalletUnsupportedError } =
  await import('./loginFlow.js')

const mockGet = vi.mocked(chapiGet)

const SERVER_URL = 'http://localhost:3999'
const SPACE_URL = `${SERVER_URL}/space/e2e-space`
const APP_URL = `${ORIGIN}/test-app`
const COLLECTIONS = [{ id: 'notes' }, { id: 'projects' }]
const documentLoader = createDocumentLoader()

// The hosted App Connect context defines the response VP's `zcap` and
// `appConnect` terms (and the app-key credential's), exactly as the wallet
// emits them; the document loader resolves it statically.
const APP_CONNECT_CONTEXT_URL = 'https://w3id.org/byoe/app-connect/v1'

interface WalletIdentity {
  holder: string
  suite: Ed25519Signature2020
}

let wallet: WalletIdentity
let appDid: string
let appSeed: Uint8Array

const loginConfig: LoginConfig = {
  appOrigin: ORIGIN,
  appName: 'Test App',
  appUrl: APP_URL,
  collections: COLLECTIONS,
  documentLoader
}

beforeAll(async () => {
  const agent = await CapabilityAgent.fromSeed({
    seed: crypto.getRandomValues(new Uint8Array(32)),
    handle: 'mock-wallet',
    keyName: 'wallet-key'
  })
  wallet = {
    holder: agent.id,
    suite: new Ed25519Signature2020({ signer: agent.getSigner() })
  }
  appSeed = crypto.getRandomValues(new Uint8Array(32))
  appDid = (await deriveIdentity({ seed: appSeed })).controllerDid
})

beforeEach(() => {
  mockGet.mockReset()
})

/**
 * An UNSIGNED structural grant (checkGrants is structural, not cryptographic).
 */
function grantFor(
  collectionId: string,
  actions: string[] = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE']
): IZcap {
  return {
    '@context': 'https://w3id.org/zcap/v1',
    id: `urn:zcap:${crypto.randomUUID()}`,
    controller: appDid,
    parentCapability: `urn:zcap:root:${encodeURIComponent(SPACE_URL)}`,
    invocationTarget: `${SPACE_URL}/${collectionId}`,
    allowedAction: actions,
    expires: new Date(Date.now() + 86_400_000).toISOString()
  } as unknown as IZcap
}

/**
 * Signs a wallet-style App Connect response VP: an optional embedded app-key
 * credential, the delegated zcaps, and an optional `appConnect` member.
 */
async function walletVp({
  challenge,
  credential,
  zcaps,
  appConnect
}: {
  challenge: string
  credential?: IVerifiableCredential
  zcaps?: IZcap[]
  appConnect?: { firstRun: boolean }
}): Promise<IVerifiablePresentation> {
  const presentation = vc.createPresentation({
    holder: wallet.holder,
    ...(credential && { verifiableCredential: [credential] }),
    verify: false,
    version: 1.0
  }) as {
    '@context': unknown
    zcap?: IZcap[]
    appConnect?: { firstRun: boolean }
  }
  const contexts: unknown[] = []
  if (zcaps && zcaps.length > 0) {
    contexts.push(APP_CONNECT_CONTEXT_URL)
    presentation.zcap = zcaps
  }
  if (appConnect && !contexts.includes(APP_CONNECT_CONTEXT_URL)) {
    contexts.push(APP_CONNECT_CONTEXT_URL)
  }
  if (appConnect) {
    presentation.appConnect = appConnect
  }
  if (contexts.length > 0) {
    const base = presentation['@context']
    presentation['@context'] = [
      ...(Array.isArray(base) ? base : [base]),
      ...contexts
    ]
  }
  return (await vc.signPresentation({
    presentation: presentation as unknown as vc.Presentation,
    challenge,
    domain: ORIGIN,
    documentLoader,
    suite: wallet.suite
  })) as IVerifiablePresentation
}

async function appKeyCredential(): Promise<IVerifiableCredential> {
  return issueSeedCredential({
    seed: appSeed,
    origin: ORIGIN,
    appUrl: APP_URL,
    appName: 'Test App',
    documentLoader
  })
}

describe('loginWithWallet (App Connect)', () => {
  it('completes a returning login and reports firstRun false', async () => {
    const credential = await appKeyCredential()
    mockGet.mockImplementation(async ({ vpr }) =>
      walletVp({
        challenge: vpr.challenge as string,
        credential,
        zcaps: COLLECTIONS.map(collection => grantFor(collection.id))
      })
    )
    const outcome = await loginWithWallet({ config: loginConfig })
    expect(outcome.firstRun).toBe(false)
    expect(outcome.identity.controllerDid).toBe(appDid)
    expect(outcome.seed).toEqual(appSeed)
    expect(Object.keys(outcome.parsed!.byCollectionId)).toEqual(
      COLLECTIONS.map(collection => collection.id)
    )
    expect(typeof outcome.expires).toBe('string')
  })

  it('reads firstRun true from presentation.appConnect', async () => {
    const credential = await appKeyCredential()
    mockGet.mockImplementation(async ({ vpr }) =>
      walletVp({
        challenge: vpr.challenge as string,
        credential,
        zcaps: COLLECTIONS.map(collection => grantFor(collection.id)),
        appConnect: { firstRun: true }
      })
    )
    const outcome = await loginWithWallet({ config: loginConfig })
    expect(outcome.firstRun).toBe(true)
  })

  it('treats appConnect.firstRun false as a returning login', async () => {
    const credential = await appKeyCredential()
    mockGet.mockImplementation(async ({ vpr }) =>
      walletVp({
        challenge: vpr.challenge as string,
        credential,
        zcaps: COLLECTIONS.map(collection => grantFor(collection.id)),
        appConnect: { firstRun: false }
      })
    )
    const outcome = await loginWithWallet({ config: loginConfig })
    expect(outcome.firstRun).toBe(false)
  })

  it('fails closed on an old wallet that returns no app key', async () => {
    mockGet.mockImplementation(async ({ vpr }) =>
      walletVp({ challenge: vpr.challenge as string })
    )
    await expect(
      loginWithWallet({ config: loginConfig })
    ).rejects.toBeInstanceOf(WalletUnsupportedError)
  })

  it('surfaces a user cancel (null CHAPI response) as LoginCancelledError', async () => {
    mockGet.mockResolvedValue(null)
    await expect(
      loginWithWallet({ config: loginConfig })
    ).rejects.toBeInstanceOf(LoginCancelledError)
  })
})

describe('App Connect grant checking', () => {
  it('completes a shared-only login whose share the user declined', async () => {
    // No app-owned collections, one requested share -- and the wallet returned
    // no grants at all (the user declined the share). Declining is not a login
    // failure: the login completes with no remote storage.
    const credential = await appKeyCredential()
    mockGet.mockImplementation(async ({ vpr }) =>
      walletVp({ challenge: vpr.challenge as string, credential })
    )
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)

    const outcome = await loginWithWallet({
      config: {
        ...loginConfig,
        collections: [],
        sharedCollections: ['wallet-notes']
      }
    })

    expect(outcome.identity.controllerDid).toBe(appDid)
    expect(outcome.grants).toEqual([])
    expect(outcome.parsed).toBeUndefined()
    // A nominal far-future expiry, so the near-expiry watch never fires.
    expect(new Date(outcome.expires).getTime()).toBeGreaterThan(Date.now())
    expect(
      capture.events.some(
        event =>
          event.level === 'warn' &&
          Array.isArray(event.data?.sharedCollections) &&
          (event.data.sharedCollections as string[]).includes('wallet-notes')
      )
    ).toBe(true)
    setLogger(previous)
  })

  it('completes a login that requests nothing, without warning', async () => {
    const credential = await appKeyCredential()
    mockGet.mockImplementation(async ({ vpr }) =>
      walletVp({ challenge: vpr.challenge as string, credential })
    )
    // A capture logger of this test's own, so an earlier test's events cannot
    // reach the assertion below.
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)

    const outcome = await loginWithWallet({
      config: { ...loginConfig, collections: [] }
    })

    expect(outcome.grants).toEqual([])
    expect(capture.events).toEqual([])
    setLogger(previous)
  })

  it('still rejects when app-owned collections came back with no grants', async () => {
    const credential = await appKeyCredential()
    mockGet.mockImplementation(async ({ vpr }) =>
      walletVp({ challenge: vpr.challenge as string, credential })
    )

    await expect(loginWithWallet({ config: loginConfig })).rejects.toThrow(
      /no storage grants/
    )
  })

  it('still rejects when an app-owned collection is uncovered', async () => {
    // Not the empty-grant shortcut: grants came back, just not for `projects`.
    const credential = await appKeyCredential()
    mockGet.mockImplementation(async ({ vpr }) =>
      walletVp({
        challenge: vpr.challenge as string,
        credential,
        zcaps: [grantFor('notes')]
      })
    )

    await expect(loginWithWallet({ config: loginConfig })).rejects.toThrow(
      /No grant covers the "projects"/
    )
  })

  it('completes a public-collection login on the full action vocabulary', async () => {
    // A public collection now allows the same actions as a private one, so the
    // request asks for the whole vocabulary on both and the wallet grants it.
    const credential = await appKeyCredential()
    mockGet.mockImplementation(async ({ vpr }) => {
      const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
      const appConnect = queries.find(
        entry => entry.type === 'AppConnectQuery'
      ) as { capabilityQuery: Array<{ allowedAction: string[] }> }
      expect(
        appConnect.capabilityQuery.map(entry => entry.allowedAction)
      ).toEqual([
        ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']
      ])
      return walletVp({
        challenge: vpr.challenge as string,
        credential,
        zcaps: [grantFor('microblog-posts'), grantFor('notes')]
      })
    })

    const outcome = await loginWithWallet({
      config: {
        ...loginConfig,
        collections: [
          { id: 'microblog-posts', visibility: 'public' },
          { id: 'notes' }
        ]
      }
    })

    expect(Object.keys(outcome.parsed!.byCollectionId).sort()).toEqual([
      'microblog-posts',
      'notes'
    ])
  })

  it('does not require a declined share to be covered', async () => {
    // The app-owned collections are granted; the requested share is not.
    const credential = await appKeyCredential()
    mockGet.mockImplementation(async ({ vpr }) =>
      walletVp({
        challenge: vpr.challenge as string,
        credential,
        zcaps: COLLECTIONS.map(collection => grantFor(collection.id))
      })
    )

    const outcome = await loginWithWallet({
      config: { ...loginConfig, sharedCollections: ['wallet-notes'] }
    })

    expect(outcome.grants).toHaveLength(COLLECTIONS.length)
    expect(outcome.parsed!.spaceId).toBe('e2e-space')
  })
})
