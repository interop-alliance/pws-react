/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app-side seam between the replication driver and `@interop/pws-client`.
 * Delegates to the client's own `createPwsSyncPort` -- which owns the PWS URL
 * grammar, the verbatim (codec-bypassing) `pws.request()` writes, the `changes`
 * feed pull, the key-epoch header, and the conditional-write ETag handling --
 * and pins the two options this library needs: the collection's delegated
 * capability, and `mapAuthErrors` so a `401` / `403` / the server's masked `404`
 * arrive as a `PwsSyncAuthError` the sync controller matches by name.
 *
 * What stays here is the narrowing to a `PwsSyncBasePort`: the 412 conflict
 * re-read (`get`) is supplied separately by `withFeedPrimaryRead`
 * (`@interop/pws-sync/rxdb`), which resolves the primary state from the
 * changes-feed BODY -- origin-independent, unlike a cross-origin `GET` whose
 * ETag header CORS hides.
 *
 * The session binding no longer builds its port through here: the controller
 * core takes the same two options as port flags and calls the client directly.
 * This wrapper stays as the published seam for a consumer driving replication
 * itself.
 */
import type { PwsClient } from '@interop/pws-client'
import { createPwsSyncPort as createClientSyncPort } from '@interop/pws-client/sync'
import type { IZcap } from '@interop/data-integrity-core'
// pws-sync still exports this type under its former prefix.
import type { WasSyncBasePort as PwsSyncBasePort } from '@interop/pws-sync'

/**
 * Builds a `PwsSyncBasePort` bound to a single Space + Collection on the remote
 * PWS server, backed by the session's signed `PwsClient`.
 *
 * @param options {object}
 * @param options.pws {PwsClient}       the session client (holds the signer)
 * @param options.spaceUrl {string}   the remote Space's absolute URL
 * @param options.collectionId {string}   the PWS collection id (e.g. `public-credentials`)
 * @param [options.capability] {IZcap}   the delegated session capability for
 *   this collection (a restored `delegated` tier session); absent in the full
 *   tier, where requests invoke root capabilities
 * @returns {PwsSyncBasePort}
 */
export function createPwsSyncPort({
  pws,
  spaceUrl,
  collectionId,
  capability
}: {
  pws: PwsClient
  spaceUrl: string
  collectionId: string
  capability?: IZcap
}): PwsSyncBasePort {
  // The client's port is this package's base port by construction (pws-sync
  // aliases the wire types from it), so a divergence fails to compile here.
  return createClientSyncPort({
    pws,
    spaceUrl,
    collectionId,
    ...(capability !== undefined && { capability }),
    mapAuthErrors: true
  })
}
