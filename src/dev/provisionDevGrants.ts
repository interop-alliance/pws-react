/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Dev grant provisioning (CHAPI bypassed). Against a running was-teaching-server
 * this produces what a wallet's account genesis produces, in the same stage
 * order, and then delegates the app's grants:
 *
 *   1. derives a throwaway "provisioner" client key (stands in for the wallet
 *      client that owns the Space) and the app's own identity from the
 *      supplied seed, and mints a fresh Space id plus per-run did:webvh
 *      update keys;
 *   2. creates the Space with the provisioner's did:key as its controller, the
 *      world-readable plaintext `id` collection, and the requested
 *      collections. A PRIVATE collection is created bare, with no
 *      `encryption` member, since its governing log's genesis is what declares
 *      it encrypted. A PUBLIC collection stays plaintext with no descriptor;
 *   3. publishes the Space owner's one-entry did:webvh log at
 *      `/space/{spaceId}/id/did.jsonl`, whose document lists the provisioner
 *      key and its X25519 key-agreement twin;
 *   4. installs epoch[0] on every private collection through the
 *      log-governed descriptor store, so the collection's `meta/log` head is
 *      the epoch configuration, signed by the provisioner key the did:webvh
 *      document lists and verified against that published log. The app's
 *      identity key-agreement key is the sole recipient, and
 *      `blindedIndex: true` installs the blinded-index key alongside it
 *      (with the first epoch or never);
 *   5. promotes the Space controller from the did:key to the did:webvh,
 *      through wallet-core's promotion stage, keeping the Space's name;
 *   6. delegates a per-collection read/write zcap from the Space root
 *      capability (now controlled by the did:webvh) to the app's controller
 *      DID, signed under the did:webvh verification method of the provisioner
 *      key;
 *   7. returns the signed grants and (optionally) writes them to a JSON file
 *      the app loads in dev-sync mode;
 *   8. optionally probes whether the delegated, collection-scoped RW zcap
 *      authorizes an app-side PUT of the Collection Metadata object (the
 *      `meta` sub-resource).
 *
 * The server URL must be one did:webvh accepts: `https://`, or `http://` on
 * the literal host `localhost` (not `127.0.0.1`).
 *
 * Node only (uses `fs`); consumed through the package `./dev` subpath.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { WasClient, type ActionInput } from '@interop/was-client'
import { ensureFirstEpoch, ownerRecipient } from '@interop/was-client/edv'
import type { IDelegatedZcap } from '@interop/data-integrity-core'
import { CapabilityAgent } from '@interop/capability-agent'
import { agentsFromKeyAgent } from '@interop/was-client/identity'
import {
  collectionMeta,
  collectionPath,
  rootCapability,
  spacePath,
  toUrl
} from '@interop/was-client/paths'
import {
  ensureSpace,
  ensureSpaceAndCollection,
  errorStatus
} from '@interop/was-client/sync'
import { memoryResourceLogPinStore } from '@interop/vh-resource-log'
import {
  ensurePromotedSpaceController,
  mintSpaceId
} from '@interop/wallet-core/genesis'
import { ID_COLLECTION_SPEC } from '@interop/wallet-core/space'
import {
  clientSigningKeyMultibase,
  ensureDidWebvh,
  mintClientWebvhUpdateKeys,
  wasWebvhIdStore,
  webvhZcapClient
} from '@interop/wallet-core/webvh'
import {
  accountCollectionStores,
  userKeyRosterLogSigner
} from '@interop/wallet-core/keys'
import { deriveIdentity } from '../identity/agents.js'
import { RW_ACTIONS } from '../auth/loginRequest.js'

/**
 * A fixed, distinct default provisioner seed -- the "wallet" that owns the dev
 * Space. Kept separate from the app seed (the requester) so the delegation is
 * a genuine cross-identity grant, exactly as in the real wallet-to-requester
 * flow.
 */
export const DEFAULT_PROVISIONER_SEED: Uint8Array = new Uint8Array([
  0x70, 0x72, 0x6f, 0x76, 0x69, 0x73, 0x69, 0x6f, 0x6e, 0x65, 0x72, 0x2d, 0x64,
  0x65, 0x76, 0x2d, 0x73, 0x65, 0x65, 0x64, 0x2d, 0x30, 0x31, 0x32, 0x33, 0x34,
  0x35, 0x36, 0x37, 0x38, 0x39, 0x41
])

/**
 * How long a dev grant lives: seven days, the lifetime freewallet gives a
 * requester's write grant. A dev re-provisions when it lapses.
 */
export const DEV_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The outcome of a provisioning run: the signed grants plus the topology and
 * identities they were minted against. The JSON written to `outFile` (when
 * given) is `{ grants }`.
 */
export interface ProvisionDevGrantsResult {
  /**
   * One delegated read/write zcap per requested collection.
   */
  grants: IDelegatedZcap[]
  /**
   * The created space id.
   */
  spaceId: string
  /**
   * The canonical absolute space URL (`<baseUrl>/space/<spaceId>/`, with
   * the trailing slash a container URL carries).
   */
  spaceUrl: string
  /**
   * The app (requester) controller DID the grants were delegated to.
   */
  appDid: string
  /**
   * The Space owner's did:webvh (the promoted Space controller), whose log
   * is published at `/space/<spaceId>/id/did.jsonl`.
   */
  provisionerDid: string
  /**
   * Present only when `probe` was requested: the result of PUTting the
   * Collection Metadata object (read first, written back verbatim) with the
   * app's delegated RW zcap.
   */
  probe?: {
    authorized: boolean
    status?: number
    body?: unknown
  }
}

/**
 * Provisions a dev Space, its collections, and per-collection RW zcaps delegated
 * to the app DID derived from `seed`.
 *
 * @param options {object}
 * @param options.serverUrl {string}   the Spaces Repository URL of a running
 *   was-teaching-server (`http://localhost:3002/spaces/`)
 * @param options.seed {Uint8Array}   the app (requester) master seed; the
 *   app DID the grants are delegated to is derived from it
 * @param options.collections {Array<string | object>}   the WAS collections to
 *   create and grant: a bare id string (private by default) or
 *   `{ id, visibility, blindedIndex }`. A private collection is log-governed:
 *   its epoch[0] (sole recipient: the app's identity key-agreement key) is
 *   the genesis of its `meta/log`; a public one stays plaintext. `blindedIndex: true`
 *   additionally installs the collection's blinded-index key with that first
 *   epoch, which is the only moment it can be installed; it is ignored with a
 *   warning on a public collection, which is plaintext and needs no blinding
 * @param [options.spaceName] {string}   human-readable Space name (defaults to
 *   `'Dev Space'`)
 * @param [options.outFile] {string}   when given, the `{ grants }` JSON is
 *   written here (parent directories are created)
 * @param [options.provisionerSeed] {Uint8Array}   the seed of the Space owner's
 *   client key, the one the did:webvh document lists (defaults to
 *   `DEFAULT_PROVISIONER_SEED`). The did:webvh itself is fresh per run, since
 *   it embeds the freshly minted Space id
 * @param [options.identityHandle] {string}   cosmetic label for the app identity
 *   agent; does not affect the derived DID
 * @param [options.actions] {ActionInput[]}   the RW action set delegated per
 *   collection (defaults to the auth layer's `RW_ACTIONS`)
 * @param [options.expires] {string | Date}   when the delegated grants expire
 *   (defaults to `DEV_GRANT_TTL_MS` from now; left unset, ezcap would mint
 *   five-minute grants, too short to dev against)
 * @param [options.probe] {boolean}   when true, probe whether the delegated RW
 *   zcap authorizes a PUT of the Collection Metadata object (read first and
 *   written back verbatim, so an installed epoch roster is never clobbered)
 * @param [options.log] {(message: string) => void}   progress sink (defaults to
 *   a no-op; the CLI passes `console.log`)
 * @returns {Promise<ProvisionDevGrantsResult>}
 */
export async function provisionDevGrants({
  serverUrl,
  seed,
  collections,
  spaceName = 'Dev Space',
  outFile,
  provisionerSeed = DEFAULT_PROVISIONER_SEED,
  identityHandle,
  // The server accepts HEAD even though storage-core's ActionInput union omits
  // it, hence the assertion.
  actions = RW_ACTIONS as ActionInput[],
  expires = new Date(Date.now() + DEV_GRANT_TTL_MS),
  probe = false,
  log = () => {}
}: {
  serverUrl: string
  seed: Uint8Array
  collections: Array<
    | string
    | {
        id: string
        visibility?: 'private' | 'public'
        blindedIndex?: boolean
      }
  >
  spaceName?: string
  outFile?: string
  provisionerSeed?: Uint8Array
  identityHandle?: string
  actions?: ActionInput[]
  expires?: string | Date
  probe?: boolean
  log?: (message: string) => void
}): Promise<ProvisionDevGrantsResult> {
  const [
    { controllerDid: appDid, zcapClient: appZcapClient, keyAgreementKey },
    keyAgent
  ] = await Promise.all([
    deriveIdentity({ seed, identityHandle }),
    CapabilityAgent.fromSeed({
      seed: provisionerSeed,
      handle: 'dev-provisioner',
      keyName: 'provisioner-key'
    })
  ])
  // The provisioner's client key: its did:key controls the Space until the
  // promotion, and its X25519 twin is the key-agreement method the did:webvh
  // document publishes beside it.
  const {
    controllerDid: clientDid,
    zcapClient: clientZcapClient,
    keyAgreementKey: clientKeyAgreementKey
  } = agentsFromKeyAgent({ keyAgent })
  const { publicKeyMultibase: keyAgreementKeyMultibase } = clientKeyAgreementKey
  const clientWas = new WasClient({ serverUrl, zcapClient: clientZcapClient })
  // wallet-core's provisioning helpers and the path builders take the server
  // base URL, the parent of the Spaces Repository URL the client was given.
  const baseUrl = clientWas.baseUrl
  // Every run mints a fresh Space, so the update keys are minted per run too
  // and discarded with it: nothing ever appends to this log again.
  const updateKeys = mintClientWebvhUpdateKeys()
  const pinStore = memoryResourceLogPinStore()
  const spaceId = mintSpaceId()

  log(`Provisioning against ${serverUrl}`)
  log(`  provisioner key: ${clientDid}`)
  log(`  app (RP) DID:    ${appDid}`)
  log(`  space id:        ${spaceId}`)

  // The Space under the provisioner's did:key, then its collections. The
  // `id` collection is the world-readable plaintext home of the account log.
  // A private collection is created bare: the server refuses to govern a
  // Description that already carries a client-written `encryption` member,
  // so the governing log's genesis below is what declares it encrypted.
  const spaceDescription = await ensureSpace({
    was: clientWas,
    spaceId,
    controllerDid: clientDid,
    spaceName
  })
  const entries = collections.map(entry => {
    const {
      id,
      visibility = 'private',
      blindedIndex = false
    } = typeof entry === 'string' ? { id: entry } : entry
    return { id, visibility, blindedIndex }
  })
  await Promise.all([
    ensureSpaceAndCollection({
      was: clientWas,
      spaceId,
      controllerDid: clientDid,
      spaceDescription,
      collectionId: ID_COLLECTION_SPEC.collectionId,
      collectionName: ID_COLLECTION_SPEC.name,
      encryption: ID_COLLECTION_SPEC.encryption,
      isPublic: ID_COLLECTION_SPEC.isPublic
    }),
    ...entries.map(({ id, visibility }) =>
      ensureSpaceAndCollection({
        was: clientWas,
        spaceId,
        controllerDid: clientDid,
        spaceDescription,
        collectionId: id,
        collectionName: id,
        encryption: visibility === 'private' ? 'governed' : 'plaintext'
      })
    )
  ])

  // The did:webvh genesis: one entry listing the provisioner key, published
  // at `/space/{spaceId}/id/did.jsonl` through the account log's chain-head
  // pin.
  const { did } = await ensureDidWebvh({
    idStore: wasWebvhIdStore({ was: clientWas, spaceId, pinStore }),
    wasServerUrl: baseUrl,
    spaceId,
    clientKeys: {
      signingKeyMultibase: clientSigningKeyMultibase({ keyAgent }),
      keyAgreementKeyMultibase
    },
    updateKeys
  })
  log(`  space owner DID: ${did}`)

  // Epoch[0] on every private collection, as the genesis of its governing
  // log: signed by the provisioner key the did:webvh document lists, and
  // verified against the account log the store fetches back from the `id`
  // collection. The blinding key rides along with the first epoch or is
  // never installed at all, so the choice is made here and nowhere later.
  const storeFor = accountCollectionStores({
    storageServerUrl: baseUrl,
    zcapClient: clientZcapClient,
    spaceId,
    did,
    pinStore,
    signer: userKeyRosterLogSigner({ keyAgent })
  })
  // Each collection's log is its own, so the installs are independent.
  await Promise.all(
    entries.map(async ({ id, visibility, blindedIndex }) => {
      if (visibility === 'private') {
        await ensureFirstEpoch({
          store: storeFor(id),
          recipients: [ownerRecipient({ keyAgreementKey })],
          ...(blindedIndex && { blindedIndex: true })
        })
      } else if (blindedIndex) {
        log(
          `  collection "${id}": ignoring blindedIndex on a public ` +
            `(plaintext) collection -- there is nothing to blind`
        )
      }
    })
  )

  // The controller promotion: the wallet's own genesis stage, which reads
  // the Description first and converges from whatever state an interrupted
  // run left (confirmed, promoted, or healed through the did:key-signed
  // handle), carrying this Space's own name rather than the wallet's.
  const promotion = await ensurePromotedSpaceController({
    was: clientWas,
    wasAsClient: clientWas,
    spaceId,
    did,
    name: spaceName
  })
  log(`  space controller: ${promotion}`)

  // Each collection grant is delegated from the Space's ROOT capability,
  // attenuating the target down to the collection's container URL. The root
  // names the Space's controller, now the did:webvh, so the chain is signed
  // under the did:webvh verification method of the provisioner key. The
  // collection container URL (canonical trailing slash) then prefix-covers
  // everything the app invokes under it: its resources, the `query`
  // endpoint, the listing, and its Metadata object at `meta`.
  const owner = new WasClient({
    serverUrl,
    zcapClient: webvhZcapClient({ keyAgent, did })
  })
  const spaceUrl = toUrl({ baseUrl, path: spacePath(spaceId) })
  const spaceRoot = rootCapability({ target: spaceUrl, controller: did })

  // `Promise.all` preserves input order, so `grants[i]` still corresponds to
  // `collections[i]` (the probe below relies on that for `[0]`).
  const grants: IDelegatedZcap[] = await Promise.all(
    entries.map(async ({ id, visibility }) => {
      const zcap = await owner.grant({
        to: appDid,
        actions,
        expires,
        target: toUrl({ baseUrl, path: collectionPath(spaceId, id) }),
        capability: spaceRoot
      })
      log(`  collection "${id}": created (${visibility}) + delegated RW to app`)
      return zcap
    })
  )

  if (outFile !== undefined) {
    await mkdir(dirname(outFile), { recursive: true })
    await writeFile(outFile, JSON.stringify({ grants }, null, 2))
    log(`\nWrote ${grants.length} grants to ${outFile}`)
  }

  const result: ProvisionDevGrantsResult = {
    grants,
    spaceId,
    spaceUrl,
    appDid,
    provisionerDid: did
  }

  if (!probe) {
    return result
  }

  // --- Metadata-write probe -----------------------------------------------------
  // Using the app's OWN delegated RW zcap (not the provisioner root key),
  // attempt to PUT the Collection Metadata object at `meta`. The object is read
  // first and written back, so authorization is what is probed: the PUT
  // replaces the whole object, and a blind body would muddy the answer. The
  // one member left out is `encryption`. On a log-governed collection the
  // server derives it from the `meta/log` head and refuses any write that
  // carries it (409), so echoing it back would read as a refusal.
  const appWas = new WasClient({ serverUrl, zcapClient: appZcapClient })
  const probeCollectionId = entries[0]!.id
  const probeCapability = grants[0]!
  const probePath = collectionMeta(spaceId, probeCollectionId)
  log(`\nMetadata-write probe on "${probeCollectionId}" (delegated RW zcap):`)
  try {
    const current = await appWas.request({
      capability: probeCapability,
      path: probePath,
      method: 'GET'
    })
    const { encryption: _derived, ...writable } = (current.data ?? {
      id: probeCollectionId
    }) as { encryption?: unknown } & Record<string, unknown>
    const response = await appWas.request({
      capability: probeCapability,
      path: probePath,
      method: 'PUT',
      json: writable
    })
    log(`  AUTHORIZED -- server responded ${response.status}`)
    result.probe = { authorized: true, status: response.status }
  } catch (err) {
    const status = errorStatus(err)
    const data = (err as { data?: unknown }).data
    log(`  NOT AUTHORIZED -- status ${status ?? 'n/a'}`)
    if (data !== undefined) {
      log(`  server body: ${JSON.stringify(data)}`)
    }
    result.probe = { authorized: false, status, body: data }
  }

  return result
}
