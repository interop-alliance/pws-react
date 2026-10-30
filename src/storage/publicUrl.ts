/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app-facing share-URL helper for the publish-copy share pattern: given a
 * logical collection key and a document id, composes the stable,
 * world-readable resource URL of that document in a public (plaintext)
 * collection. It routes the logical key to its PWS collection id through the
 * active session's storage context exactly as {@link EntityStore.query} does,
 * so it requires an open {@link LocalStore} and a wallet-connected session
 * (a remote store), and fails closed on non-public collections.
 */
import { requireStore, requireRemoteStore } from './storageManager.js'

/**
 * Composes the world-readable share URL for one document in a public
 * (plaintext) collection. The returned URL is what an unauthenticated reader
 * fetches (e.g. via `PwsClient.publicRead`) to consume the share link, and it
 * is stable across edits because a public collection stores the payload under
 * its own logical uuid. Requires an open store and a wallet-connected session,
 * and throws (fails closed) on a non-public / unprovisioned collection or an
 * empty id. The URL resolves publicly only once the document has replicated to
 * the server -- a locally-inserted doc shares after the next sync push.
 *
 * @param options {object}
 * @param options.collectionKey {string}   the app-side local collection key
 * @param options.id {string}   the document's logical uuid
 * @returns {string}
 */
export function publicUrlFor({
  collectionKey,
  id
}: {
  collectionKey: string
  id: string
}): string {
  const { id: collectionId } = requireStore().collectionConfig(collectionKey)
  return requireRemoteStore().publicUrlFor({ collectionId, id })
}
