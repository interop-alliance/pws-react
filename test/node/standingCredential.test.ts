/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The standing-credential account assumptions, made explicit.
 *
 * A wallet account may be anchored by a standing unlock credential -- a
 * passphrase or passkey holding a ladder seed and latent self-enrollment
 * authority -- with ZERO enrolled durable clients. Every new signup produces
 * such an account, and a browser the user has not remembered connects through
 * a transient session. Five things then differ in what the wallet hands an
 * app:
 *
 * 1. The grant chain is one link deeper: Space root, generation delegation,
 *    app grant (depth 3) rather than Space root, app grant.
 * 2. The delegator is an annex key that never appears in the account document.
 * 3. The response presentation's holder is a per-visit `did:key`, minted fresh
 *    and not stable across visits.
 * 4. The grant's `expires` is clamped to its parent's, so it can be far shorter
 *    than the TTL the app asked for.
 * 5. No login-time sweeps run, so a collection can sit on a key epoch this app
 *    holds no wrap for until some later durable login repairs it.
 *
 * This library tolerates all five today, because it never inspects the parts
 * that moved: it checks a grant's `controller` and `expires` and routes its
 * `invocationTarget`, and leaves chain validity to the storage server at
 * invocation. That tolerance is what these tests pin. Each case names the
 * assumption it protects, so an ordinary-looking future change -- adding chain
 * validation, binding something to the holder, treating an unopenable epoch as
 * fatal -- fails here rather than silently breaking connection to a
 * standing-credential account.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import * as vc from '@interop/vc'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { CapabilityAgent } from '@interop/capability-agent'
import {
  ownerRecipient,
  x25519RecipientFromDidKey
} from '@interop/pws-client/edv'
import type {
  IVerifiableCredential,
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'
import { fakeRemoteStore } from '../fixtures/remoteStore.js'
import { rejectingClient } from '../fixtures/rejectingClient.js'
import { mintRoster, rotateRoster } from '../fixtures/roster.js'
import { checkGrants, grantsOf } from '../../src/auth/verifyResponse.js'
import { RW_ACTIONS } from '../../src/auth/loginRequest.js'
import { parseGrants, parseGrantTarget } from '../../src/grants.js'
import {
  earliestExpiry,
  isExpired,
  isNearExpiry,
  persistAppSession
} from '../../src/identity/appSession.js'
import { createDocumentLoader } from '../../src/identity/documentLoader.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { issueSeedCredential } from '../../src/identity/seedCredential.js'
import {
  createSeedStore,
  type SeedStore
} from '../../src/identity/seedStore.js'
import {
  createAuthStore,
  type PwsAuthStore
} from '../../src/session/authStore.js'
import { startPwsSync } from '../../src/storage/pwsSync.js'
import { isAuthError } from '@interop/pws-sync/rxdb'
import { requireStore } from '../../src/storage/storageManager.js'
import { isUnknownEpochError, PwsSyncAuthError } from '@interop/pws-client/sync'
import { rootCapabilityId } from '@interop/pws-client/paths'
import {
  createDocCipher,
  createUnprovisionedDocCipher
} from '../../src/storage/docCipher.js'
import { createPwsSyncPort } from '../../src/storage/pwsSyncPort.js'
import { SharedCollectionReader } from '../../src/storage/sharedCollectionReader.js'
import type { StoreRegistry, PwsAppConfig } from '../../src/config.js'
import { chapiGet } from '../../src/auth/chapi.js'
import { loginWithWallet } from '../../src/auth/loginFlow.js'

// The CHAPI popup is the only network edge of the login flow; the wallet's
// response VP is composed in-test so the holder and the grant chain can be
// shaped exactly the way a standing-credential account produces them.
vi.mock('../../src/auth/chapi.js', () => ({ chapiGet: vi.fn() }))

// What the login-time descriptor read answers with, per test. Empty by
// default: no descriptor for a private collection at all, which is what an
// app-owned collection an unswept account never provisioned looks like.
const remoteDescriptors = vi.hoisted(() => ({
  value: {} as Record<string, unknown>
}))

// Inert replication: the session machine's activate / persist / teardown logic
// runs without opening any network or `window`-backed replication machinery.
vi.mock('../../src/storage/pwsSync.js', () => ({
  startPwsSync: vi.fn(async () => ({})),
  readRemoteDescriptors: vi.fn(async () => ({
    descriptors: remoteDescriptors.value,
    failures: []
  }))
}))

const ORIGIN = 'http://localhost:5173'
const APP_URL = `${ORIGIN}/test-app`
const APP_NAME = 'Test App'
const SERVER_URL = 'http://localhost:3999'
const SPACE_ID = 'account-space'
const SPACE_URL = `${SERVER_URL}/space/${SPACE_ID}`
const ROOT_CAPABILITY = rootCapabilityId(SPACE_URL)
const COLLECTION_ID = 'notes'
const SHARED_COLLECTION_ID = 'wallet-credentials'

// The login flow reads `window.location.origin` for the request domain, and
// the sync controller's online watch reads the listener pair. This suite runs
// in the node environment, so supply the minimum both need.
;(globalThis as { window?: unknown }).window = {
  location: { origin: ORIGIN },
  addEventListener() {},
  removeEventListener() {}
}

const documentLoader = createDocumentLoader()
const chapiGetMock = vi.mocked(chapiGet)
const startPwsSyncMock = vi.mocked(startPwsSync)

// The hosted App Connect context defines the response VP's `zcap` and
// `appConnect` terms exactly as the wallet emits them.
const APP_CONNECT_CONTEXT_URL = 'https://w3id.org/byoe/app-connect/v1'

// Well beyond the default one-hour near-expiry warning, so the watch never
// fires against it.
const FAR_FUTURE_MS = 4 * 60 * 60 * 1000
// The TTL an app asks for; a standing-credential grant is routinely clamped to
// something far shorter than this.
const REQUESTED_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000

/**
 * A per-visit wallet holder: a bare `did:key` minted fresh for one visit, which
 * is what a transient session presents. Nothing about it is stable, and nothing
 * in this library may retain it.
 */
interface EphemeralHolder {
  did: string
  suite: Ed25519Signature2020
}

/**
 * Mints one such holder.
 *
 * @returns {Promise<EphemeralHolder>}
 */
async function ephemeralHolder(): Promise<EphemeralHolder> {
  const agent = await CapabilityAgent.fromSeed({
    seed: crypto.getRandomValues(new Uint8Array(32)),
    handle: 'per-visit-holder',
    keyName: 'holder-key'
  })
  return {
    did: agent.id,
    suite: new Ed25519Signature2020({ signer: agent.getSigner() })
  }
}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

/**
 * The generation delegation a standing-credential account interposes between
 * the Space root and an app grant. Its target is the account Space's items
 * subtree, its controller is a client-annex key that never appears in the
 * account document, and it is signed by a ladder verification method. None of
 * that is shaped by this library's checks -- it exists only so the app grant
 * below has a realistic parent to chain through.
 *
 * @param options {object}
 * @param [options.expires] {string}   the parent expiry a child grant is
 *   clamped to
 * @returns {IZcap}
 */
function generationDelegation({
  expires = futureIso(FAR_FUTURE_MS)
}: {
  expires?: string
} = {}): IZcap {
  const annexDid = `did:key:z6Mk${'a'.repeat(41)}`
  return {
    '@context': 'https://w3id.org/zcap/v1',
    id: `urn:zcap:${crypto.randomUUID()}`,
    controller: annexDid,
    parentCapability: ROOT_CAPABILITY,
    // `/space/:id/` -- the Space's items subtree, one level above any
    // collection. A grant naming THIS target would be refused by
    // `parseGrantTarget` (it is not collection-scoped); it rides the
    // chain instead, where only the chain's root id is read.
    invocationTarget: `${SPACE_URL}/`,
    allowedAction: RW_ACTIONS,
    expires,
    proof: {
      type: 'Ed25519Signature2020',
      created: new Date().toISOString(),
      // The ladder verification method the account document does list.
      verificationMethod: `did:webvh:example:account#ladder-0`,
      proofPurpose: 'capabilityDelegation',
      capabilityChain: [ROOT_CAPABILITY],
      proofValue: `z${'1'.repeat(86)}`
    }
  } as unknown as IZcap
}

/**
 * An app grant as a standing-credential wallet mints it: chained through a
 * generation delegation (depth 3: root id, generation delegation, this grant),
 * signed by an annex key, and expiring no later than its parent.
 *
 * @param options {object}
 * @param options.controller {string}   the app-key subject DID
 * @param [options.collectionId] {string}
 * @param [options.expires] {string}   the CLAMPED expiry
 * @param [options.parent] {IZcap}   the generation delegation to chain through
 * @param [options.actions] {string[]}
 * @param [options.spaceUrl] {string}
 * @returns {IZcap}
 */
function annexGrantFor({
  controller,
  collectionId = COLLECTION_ID,
  expires = futureIso(FAR_FUTURE_MS),
  parent = generationDelegation(),
  actions = RW_ACTIONS,
  spaceUrl = SPACE_URL
}: {
  controller: string
  collectionId?: string
  expires?: string
  parent?: IZcap
  actions?: string[]
  spaceUrl?: string
}): IZcap {
  const annexDid = (parent as unknown as { controller: string }).controller
  return {
    '@context': 'https://w3id.org/zcap/v1',
    id: `urn:zcap:${crypto.randomUUID()}`,
    controller,
    parentCapability: (parent as unknown as { id: string }).id,
    invocationTarget: `${spaceUrl}/${collectionId}`,
    allowedAction: actions,
    expires,
    proof: {
      type: 'Ed25519Signature2020',
      created: new Date().toISOString(),
      // A transient session signs as an annex key: `<annexDid>#<vm>`, a DID
      // the account document never lists.
      verificationMethod: `${annexDid}#${annexDid.slice('did:key:'.length)}`,
      proofPurpose: 'capabilityDelegation',
      // Depth 3: the Space root by reference, then the generation delegation
      // embedded whole, then this grant.
      capabilityChain: [ROOT_CAPABILITY, parent],
      proofValue: `z${'2'.repeat(86)}`
    }
  } as unknown as IZcap
}

/**
 * Signs a wallet App Connect response VP under a PER-VISIT holder.
 *
 * @param options {object}
 * @param options.holder {EphemeralHolder}
 * @param options.challenge {string}
 * @param [options.credential] {IVerifiableCredential}
 * @param [options.zcaps] {IZcap[]}
 * @returns {Promise<IVerifiablePresentation>}
 */
async function walletVp({
  holder,
  challenge,
  credential,
  zcaps
}: {
  holder: EphemeralHolder
  challenge: string
  credential?: IVerifiableCredential
  zcaps?: IZcap[]
}): Promise<IVerifiablePresentation> {
  const presentation = vc.createPresentation({
    holder: holder.did,
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
  return (await vc.signPresentation({
    presentation: presentation as unknown as vc.Presentation,
    challenge,
    domain: ORIGIN,
    documentLoader,
    suite: holder.suite
  })) as IVerifiablePresentation
}

/**
 * The app-key credential the wallet custodies for this (user, origin, appUrl)
 * triple. It is minted from a seed the TEST holds, so two visits can return the
 * very same credential the way a wallet does.
 *
 * @param seed {Uint8Array}
 * @returns {Promise<IVerifiableCredential>}
 */
async function appKeyCredential(
  seed: Uint8Array
): Promise<IVerifiableCredential> {
  return issueSeedCredential({
    seed,
    origin: ORIGIN,
    appUrl: APP_URL,
    appName: APP_NAME,
    documentLoader
  })
}

function baseConfig(): PwsAppConfig {
  return {
    appName: APP_NAME,
    appOrigin: ORIGIN,
    appUrl: APP_URL,
    collections: [{ key: 'notes', id: COLLECTION_ID }],
    // A unique base name per config so the RxDB / IndexedDB databases never
    // collide across tests sharing the one process-wide fake-indexeddb.
    dbName: `was-react-${Math.random().toString(36).slice(2)}`
  }
}

function newSeedStore(): SeedStore {
  return createSeedStore({
    dbName: `was-react-session-${Math.random().toString(36).slice(2)}`,
    idb: new IDBFactory()
  })
}

const registry: StoreRegistry = {}

// Track created stores so their expiry-watch intervals never outlive a test.
const liveStores: PwsAuthStore[] = []

/**
 * Persists a session whose grants came from a standing-credential account
 * (depth 3, annex-signed, clamped expiry) and boots it to `connected`.
 *
 * @param options {object}
 * @param options.config {PwsAppConfig}
 * @param options.seedStore {SeedStore}
 * @param [options.expires] {string}   the CLAMPED expiry the wallet returned
 * @returns {Promise<{ store: PwsAuthStore, seed: Uint8Array, grants: IZcap[],
 *   controllerDid: string }>}
 */
async function connectedStore({
  config,
  seedStore,
  expires = futureIso(FAR_FUTURE_MS)
}: {
  config: PwsAppConfig
  seedStore: SeedStore
  expires?: string
}): Promise<{
  store: PwsAuthStore
  seed: Uint8Array
  grants: IZcap[]
  controllerDid: string
}> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const { controllerDid } = await deriveIdentity({ seed })
  const grants = [annexGrantFor({ controller: controllerDid, expires })]
  await persistAppSession({
    session: {
      seed,
      controllerDid,
      spaceUrl: `${SPACE_URL}/`,
      grants,
      // The persisted expiry is the one the clamp produced, not the one the
      // app asked for.
      expires: earliestExpiry(grants) as string
    },
    store: seedStore
  })
  const store = createAuthStore({ config, registry, seedStore })
  liveStores.push(store)
  await store.getState().boot()
  return { store, seed, grants, controllerDid }
}

beforeEach(() => {
  chapiGetMock.mockReset()
  // `.at(-1)` on this mock has to name THIS test's bring-up.
  startPwsSyncMock.mockClear()
  remoteDescriptors.value = {}
})

afterEach(async () => {
  while (liveStores.length > 0) {
    await liveStores.pop()!.getState().destroy()
  }
  vi.restoreAllMocks()
})

describe('a depth-3 grant from a standing-credential account', () => {
  // ASSUMPTION: this library never inspects the delegation chain. A grant
  // rooted at an intermediate generation delegation rather than at the Space
  // root is accepted and routed exactly as a root-rooted grant is. Breaking
  // this -- by adding chain-depth or parent validation -- would refuse every
  // account with no durable clients, since that is the only shape such an
  // account can mint.
  it('is accepted and routed exactly as a root-rooted grant is', async () => {
    const { controllerDid } = await deriveIdentity({
      seed: crypto.getRandomValues(new Uint8Array(32))
    })
    const parent = generationDelegation()
    const deep = annexGrantFor({ controller: controllerDid, parent })
    const chain = (deep as unknown as { proof: { capabilityChain: unknown[] } })
      .proof.capabilityChain
    expect(chain).toHaveLength(2)
    expect(chain[0]).toBe(ROOT_CAPABILITY)
    expect(chain[1]).toBe(parent)
    // The grant's parent is the generation delegation, not the Space root.
    expect(
      (deep as unknown as { parentCapability: string }).parentCapability
    ).not.toBe(ROOT_CAPABILITY)

    const checked = checkGrants({
      grants: [deep],
      controllerDid,
      collections: [{ id: COLLECTION_ID }]
    })
    expect(checked.parsed!.spaceUrl).toBe(`${SPACE_URL}/`)
    expect(checked.parsed!.byCollectionId[COLLECTION_ID]).toBe(deep)

    // Routing goes through `parseGrants` alone: the Space off the chain's
    // root, the collection off the invocation target.
    const parsed = parseGrants([deep])
    expect(Object.keys(parsed.byCollectionId)).toEqual([COLLECTION_ID])
    expect(parsed.spaceUrl).toBe(`${SPACE_URL}/`)
  })

  // ASSUMPTION: the chain's links are data the app moves, not data it
  // parses; only the root id is read, for the Space URL. The generation
  // delegation's own target is the Space items subtree, which
  // `parseGrantTarget` would REFUSE if it were ever treated as a grant. That
  // it rides the chain untouched is the proof that nothing walks the links.
  it('carries a parent whose target the router would refuse', () => {
    const parent = generationDelegation()
    expect(() => parseGrantTarget(parent)).toThrow(/not collection-scoped/)
  })

  // ASSUMPTION: `parseGrants`'s single-Space assertion still holds under the
  // deeper chain, because the generation delegation targets the ACCOUNT Space
  // rather than the auxiliary annex Space -- so every child grant still names
  // a collection in the one Space.
  it('keeps the whole grant set on a single server and space', async () => {
    const { controllerDid } = await deriveIdentity({
      seed: crypto.getRandomValues(new Uint8Array(32))
    })
    const parent = generationDelegation()
    const grants = ['notes', 'projects'].map(collectionId =>
      annexGrantFor({ controller: controllerDid, collectionId, parent })
    )
    const parsed = parseGrants(grants)
    expect(parsed.spaceUrl).toBe(`${SPACE_URL}/`)
    expect(Object.keys(parsed.byCollectionId).sort()).toEqual([
      'notes',
      'projects'
    ])
  })
})

describe('the response presentation holder', () => {
  // ASSUMPTION: nothing binds to the wallet's holder DID. A transient session
  // mints a fresh `did:key` per visit, so two logins by the same user through
  // the same wallet present two unrelated holders. Both must verify, and
  // neither may leave a trace in what the login returns -- an app that
  // remembered a holder would reject its own user on the next visit.
  it('may differ between visits, and is retained nowhere', async () => {
    const appSeed = crypto.getRandomValues(new Uint8Array(32))
    const credential = await appKeyCredential(appSeed)
    const { controllerDid } = await deriveIdentity({ seed: appSeed })
    const config = {
      appOrigin: ORIGIN,
      appName: APP_NAME,
      appUrl: APP_URL,
      collections: [{ id: COLLECTION_ID }],
      documentLoader
    }

    const first = await ephemeralHolder()
    const second = await ephemeralHolder()
    expect(first.did).not.toBe(second.did)

    const outcomes = []
    for (const holder of [first, second]) {
      chapiGetMock.mockImplementation(async ({ vpr }) =>
        walletVp({
          holder,
          challenge: vpr.challenge as string,
          credential,
          zcaps: [annexGrantFor({ controller: controllerDid })]
        })
      )
      outcomes.push(await loginWithWallet({ config }))
    }

    // Both visits verified and produced the same app identity.
    for (const outcome of outcomes) {
      expect(outcome.identity.controllerDid).toBe(controllerDid)
      expect(Object.keys(outcome.parsed!.byCollectionId)).toEqual([
        COLLECTION_ID
      ])
    }

    // Nothing about either holder survives into what the app persists: the
    // outcome carries the app's own identity, the grants, and the expiry.
    const persisted = JSON.stringify({
      controllerDid: outcomes[1]!.identity.controllerDid,
      grants: outcomes[1]!.grants,
      parsed: outcomes[1]!.parsed,
      expires: outcomes[1]!.expires,
      firstRun: outcomes[1]!.firstRun
    })
    expect(persisted).not.toContain(first.did)
    expect(persisted).not.toContain(second.did)
  })

  // ASSUMPTION: the presentation's `zcap` array is read for its grants alone;
  // the signer is checked cryptographically and then forgotten. A grant set
  // returned under an ephemeral holder validates against the APP's DID, never
  // against a DID taken from the response.
  it('is not the identity grants are validated against', async () => {
    const appSeed = crypto.getRandomValues(new Uint8Array(32))
    const { controllerDid } = await deriveIdentity({ seed: appSeed })
    const holder = await ephemeralHolder()
    const presentation = await walletVp({
      holder,
      challenge: crypto.randomUUID(),
      zcaps: [annexGrantFor({ controller: controllerDid })]
    })
    const grants = grantsOf(presentation)
    expect(grants).toHaveLength(1)

    // Checked against the app's own DID: the holder is not a party to this.
    expect(() =>
      checkGrants({
        grants,
        controllerDid,
        collections: [{ id: COLLECTION_ID }]
      })
    ).not.toThrow()
    expect(() =>
      checkGrants({
        grants,
        controllerDid: holder.did,
        collections: [{ id: COLLECTION_ID }]
      })
    ).toThrow(/not this app's DID/)
  })
})

describe('a grant expiry clamped to its parent', () => {
  // ASSUMPTION: the session's expiry is whatever the grant says, however short.
  // A standing-credential wallet clamps a grant to its generation delegation's
  // expiry, so the value the app asked for is an upper bound the wallet is free
  // to ignore. Every expiry computation must read the returned value.
  it('is what the earliest-expiry computation reports', async () => {
    const { controllerDid } = await deriveIdentity({
      seed: crypto.getRandomValues(new Uint8Array(32))
    })
    const requested = futureIso(REQUESTED_TTL_MS)
    const clamped = futureIso(FAR_FUTURE_MS)
    const parent = generationDelegation({ expires: clamped })
    const grants = [
      annexGrantFor({
        controller: controllerDid,
        expires: clamped,
        parent
      })
    ]

    expect(new Date(clamped).getTime()).toBeLessThan(
      new Date(requested).getTime()
    )
    expect(earliestExpiry(grants)).toBe(clamped)
    // And it is the value `checkGrants` hands the session, not the request's.
    const checked = checkGrants({
      grants,
      controllerDid,
      collections: [{ id: COLLECTION_ID }]
    })
    expect(checked.expires).toBe(clamped)
    expect(isExpired(checked.expires)).toBe(false)
  })

  // ASSUMPTION: the near-expiry watch reads the clamped value too. A clamp
  // shorter than the warning window must raise the reconnect banner; a clamp
  // that is merely shorter than the requested TTL must not.
  it('drives the near-expiry watch rather than the requested TTL', () => {
    const requested = futureIso(REQUESTED_TTL_MS)
    const insideWindow = futureIso(10 * 60 * 1000)
    const outsideWindow = futureIso(FAR_FUTURE_MS)
    expect(isNearExpiry(requested, ONE_HOUR_MS)).toBe(false)
    expect(isNearExpiry(outsideWindow, ONE_HOUR_MS)).toBe(false)
    expect(isNearExpiry(insideWindow, ONE_HOUR_MS)).toBe(true)
  })

  it('still yields a normal connected session when it is short', async () => {
    // Four hours where the app asked for thirty days: a normal connected
    // session, reporting the clamped expiry.
    const config = baseConfig()
    const clamped = futureIso(FAR_FUTURE_MS)
    const { store } = await connectedStore({
      config,
      seedStore: newSeedStore(),
      expires: clamped
    })

    expect(store.getState().status).toBe('connected')
    expect(store.getState().expires).toBe(clamped)
    // Let the watch's deferred first check run: still far enough out.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getState().status).toBe('connected')
  })

  it('raises the reconnect banner when it lands inside the warning window', async () => {
    const config = baseConfig()
    const { store } = await connectedStore({
      config,
      seedStore: newSeedStore(),
      expires: futureIso(10 * 60 * 1000)
    })

    expect(store.getState().status).toBe('connected')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getState().status).toBe('reconnect')
  })
})

describe('a mid-life authorization failure', () => {
  // ASSUMPTION: a grant can stop verifying BEFORE its stated expiry, because
  // the annex generation it chained through can be collected out from under
  // it -- and on a client-less account no login-time sweep repairs that. The
  // 403 must route to the reconnect prompt, not surface as a raw error.
  it('routes an unexpired grant to reconnect rather than an error', async () => {
    const config = baseConfig()
    const { store } = await connectedStore({
      config,
      seedStore: newSeedStore()
    })
    expect(store.getState().status).toBe('connected')
    // The grant has NOT expired: this is the annex generation disappearing,
    // not the clock running out.
    expect(isExpired(store.getState().expires as string)).toBe(false)

    // A real 403 off the wire, through the real sync port, so the mapping this
    // depends on is exercised rather than assumed.
    const port = createPwsSyncPort({
      pws: rejectingClient(403),
      spaceUrl: `${SPACE_URL}/`,
      collectionId: COLLECTION_ID
    })
    const denial = await port.putContent({ id: 'row-1', data: { x: 1 } }).then(
      () => null,
      (err: unknown) => err
    )
    expect(denial).toBeInstanceOf(PwsSyncAuthError)
    expect(isAuthError(denial)).toBe(true)

    // The replication bootstrap's auth-error signal is what the session wires
    // that denial into.
    const { onAuthError } = startPwsSyncMock.mock.calls.at(-1)![0] as {
      onAuthError: () => void
    }
    onAuthError()

    expect(store.getState().status).toBe('reconnect')
    // A reconnect prompt, not a failure: no error copy, and the replica stays
    // open and usable.
    expect(store.getState().error).toBeNull()
    expect(isExpired(store.getState().expires as string)).toBe(false)
  })
})

describe('reconnecting to a standing-credential account', () => {
  // ASSUMPTION: the app's identity lives in the wallet, not in the wallet's
  // session. An account with zero durable clients still custodies the app-key
  // credential, so a later visit returns the same subject DID -- and therefore
  // the same X25519 recipient key every one of the app's collections is
  // encrypted to. Without this, a client-less account would orphan the app's
  // data on every visit.
  it('returns the same app-key subject DID and recipient key', async () => {
    const appSeed = crypto.getRandomValues(new Uint8Array(32))
    const credential = await appKeyCredential(appSeed)
    const { controllerDid } = await deriveIdentity({ seed: appSeed })
    const config = {
      appOrigin: ORIGIN,
      appName: APP_NAME,
      appUrl: APP_URL,
      collections: [{ id: COLLECTION_ID }],
      documentLoader
    }

    const recipientKeys: string[] = []
    const subjectDids: string[] = []
    // Two visits, two unrelated holders, the same custodied app key.
    for (let visit = 0; visit < 2; visit++) {
      const holder = await ephemeralHolder()
      chapiGetMock.mockImplementation(async ({ vpr }) =>
        walletVp({
          holder,
          challenge: vpr.challenge as string,
          credential,
          zcaps: [annexGrantFor({ controller: controllerDid })]
        })
      )
      const outcome = await loginWithWallet({ config })
      subjectDids.push(outcome.identity.controllerDid)
      recipientKeys.push(
        (outcome.identity.keyAgreementKey as unknown as { id: string }).id
      )
    }

    expect(subjectDids[0]).toBe(controllerDid)
    expect(subjectDids[1]).toBe(subjectDids[0])
    expect(recipientKeys[1]).toBe(recipientKeys[0])
    // And it is the very key a wallet derives from the controller DID alone,
    // which is what a share's roster entry names.
    expect(recipientKeys[0]).toBe(
      x25519RecipientFromDidKey({ did: controllerDid }).id
    )
  })

  // ASSUMPTION: the session's own reconnect keeps the identity too. The
  // re-grant runs a fresh App Connect round under a NEW per-visit holder and
  // returns depth-3, annex-signed, clamped grants -- and the session must come
  // back connected on the same controller DID it left on.
  it('lands connected again on the same controller through a new holder', async () => {
    const config = baseConfig()
    const seedStore = newSeedStore()
    const { store, seed, controllerDid } = await connectedStore({
      config,
      seedStore
    })
    expect(store.getState().status).toBe('connected')

    store.getState().notifyAccessExpired()
    expect(store.getState().status).toBe('reconnect')

    const holder = await ephemeralHolder()
    const renewedExpires = futureIso(FAR_FUTURE_MS)
    chapiGetMock.mockImplementation(async ({ vpr }) =>
      walletVp({
        holder,
        challenge: vpr.challenge as string,
        zcaps: [
          annexGrantFor({ controller: controllerDid, expires: renewedExpires })
        ]
      })
    )

    await store.getState().reconnect()

    expect(store.getState().error).toBeNull()
    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(controllerDid)
    expect(store.getState().expires).toBe(renewedExpires)
    // The seed -- and so the recipient key every collection is sealed to --
    // never moved.
    const stored = await seedStore.loadSeed()
    expect(stored).toEqual(seed)
    const reDerived = await deriveIdentity({ seed: stored! })
    expect(reDerived.controllerDid).toBe(controllerDid)
    expect((reDerived.keyAgreementKey as unknown as { id: string }).id).toBe(
      x25519RecipientFromDidKey({ did: controllerDid }).id
    )
  })
})

describe('an epoch this app cannot open', () => {
  // ASSUMPTION: no login-time sweep runs on a client-less account, so a
  // rotation torn part-way through its collection fan-out can leave a
  // collection keyed to an epoch this app holds no wrap for. On the SHARED
  // read path that degrades to a warn-and-skip: the listing returns the subset
  // it could decrypt rather than failing.
  it('warns and skips on the shared-collection read path', async () => {
    const app = await deriveIdentity({
      seed: crypto.getRandomValues(new Uint8Array(32))
    })
    const owner = await deriveIdentity({
      seed: crypto.getRandomValues(new Uint8Array(32))
    })
    const bystander = await deriveIdentity({
      seed: crypto.getRandomValues(new Uint8Array(32))
    })
    const appRecipient = x25519RecipientFromDidKey({ did: app.controllerDid })
    const bystanderRecipient = x25519RecipientFromDidKey({
      did: bystander.controllerDid
    })

    // The roster this app is in, and a later epoch it is not: exactly the state
    // an unswept rotation leaves a collection in.
    const opened = await mintRoster({
      recipients: [
        ownerRecipient({ keyAgreementKey: owner.keyAgreementKey }),
        appRecipient,
        bystanderRecipient
      ]
    })
    const rotated = await rotateRoster({
      descriptor: opened,
      removeKid: bystanderRecipient.id
    })
    expect(rotated.currentEpoch).not.toBe(opened.currentEpoch)

    const readableCipher = await createDocCipher({
      keyAgreementKey: owner.keyAgreementKey,
      keyResolver: owner.keyResolver,
      collectionId: SHARED_COLLECTION_ID,
      encryption: opened
    })
    const unreadableCipher = await createDocCipher({
      keyAgreementKey: owner.keyAgreementKey,
      keyResolver: owner.keyResolver,
      collectionId: SHARED_COLLECTION_ID,
      encryption: rotated
    })
    const readable = await readableCipher.encrypt({
      data: { id: 'credential-1', title: 'openable' }
    })
    const unreadable = await unreadableCipher.encrypt({
      data: { id: 'credential-2', title: 'sealed to an epoch we lack' }
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const reader = await SharedCollectionReader.open({
        // Opened on the roster this app is in; the refresh the unknown epoch
        // drives answers with no roster at all, so the retry fails too.
        remoteStore: fakeRemoteStore({
          collectionId: SHARED_COLLECTION_ID,
          spaceUrl: `${SPACE_URL}/`,
          descriptors: [opened, undefined],
          resources: {
            [readable.id]: readable.envelope,
            [unreadable.id]: unreadable.envelope
          }
        }),
        keyAgreementKey: app.keyAgreementKey,
        keyResolver: app.keyResolver,
        collectionId: SHARED_COLLECTION_ID
      })

      // The listing degrades to the readable subset instead of rejecting.
      expect(await reader.list()).toEqual([
        { id: readable.id, data: { id: 'credential-1', title: 'openable' } }
      ])
      expect(await reader.get(unreadable.id)).toBeUndefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // ASSUMPTION: the PRIVATE (app-owned) path lands on the fail-closed
  // placeholder cipher instead of failing the session. A connected boot that
  // reads no epoch-bearing descriptor for a collection stays `connected` with a
  // usable replica; only that collection's writes refuse, and its decrypts
  // report an unknown epoch so a later descriptor read can swap a real cipher
  // in without a reboot.
  it('leaves the private collection on its fail-closed placeholder cipher', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const config = baseConfig()
      const { store } = await connectedStore({
        config,
        seedStore: newSeedStore()
      })

      // The session is up and the replica is open, even though no descriptor
      // for `notes` could be read.
      expect(store.getState().status).toBe('connected')
      expect(store.getState().error).toBeNull()
      await expect(requireStore().countEntities('notes')).resolves.toBe(0)

      // Writes to that one collection refuse, in the placeholder's words.
      await expect(
        requireStore().insertEntity('notes', {
          id: crypto.randomUUID(),
          title: 'unsealable'
        })
      ).rejects.toThrow(/no key-epoch encryption descriptor/)
    } finally {
      warn.mockRestore()
    }
  })

  // The OTHER shape of the same hazard, and the one place the tolerance stops.
  // When the descriptor exists but its roster wraps no epoch to this app at all
  // -- a share removed, or a rotation whose fan-out never re-escrowed this app
  // -- the cipher build raises `KeyUnwrapError` from inside `LocalStore.init`,
  // so the CONNECTED activation fails outright rather than opening that one
  // collection behind the placeholder. The session still never dead-ends: it
  // falls back to a usable anonymous replica with the error surfaced. This
  // records the behavior as it stands, so a later change that narrows the
  // failure to the single affected collection updates this deliberately.
  it('loses the connected session when the roster wraps nothing to this app', async () => {
    const owner = await deriveIdentity({
      seed: crypto.getRandomValues(new Uint8Array(32))
    })
    remoteDescriptors.value = {
      [COLLECTION_ID]: await mintRoster({
        recipients: [ownerRecipient({ keyAgreementKey: owner.keyAgreementKey })]
      })
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store } = await connectedStore({
        config: baseConfig(),
        seedStore: newSeedStore()
      })

      expect(store.getState().status).toBe('local')
      expect(store.getState().error).toMatch(/not a recipient of any key epoch/)
      // Usable all the same: the anonymous replica opened behind the failure.
      await expect(requireStore().countEntities('notes')).resolves.toBe(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('reports the placeholder decrypt as an unknown epoch, not a hard failure', async () => {
    // The recovery signal itself: an unknown epoch is what makes the store
    // re-read the descriptor and swap in a real cipher once one exists, so a
    // session that meets an unswept collection recovers per collection rather
    // than needing a reboot.
    const cipher = createUnprovisionedDocCipher({
      collectionId: COLLECTION_ID
    })
    await expect(
      cipher.decrypt({ id: 'row-1', envelope: { jwe: {} } })
    ).rejects.toSatisfy(isUnknownEpochError)
  })
})
