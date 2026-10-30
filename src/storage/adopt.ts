/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The local-to-connected adoption merge: copies the anonymous replica's
 * decrypted payloads into the freshly opened connected replica. A copy
 * (decrypt with the anonymous cipher, re-encrypt with the connected cipher) is
 * the only possible mechanism -- the two replicas derive their keys from
 * different seeds, so envelopes are not portable across them.
 *
 * Merge policy, per logical uuid (deterministic, replica-independent):
 * - no connected doc under that uuid: insert.
 * - a connected doc exists: the adopted payload replaces it only when it wins
 *   the same last-write-wins rule replication runs ({@link remotePayloadWins});
 *   a connected doc without LWW fields always loses to a stamped adopted one.
 *
 * Adopted payloads missing `updatedAt`/`writerId` are stamped at adoption time
 * (the sync layer's conflict resolution requires them), each field on its own:
 * a missing `updatedAt` becomes the adoption instant and a missing `writerId`
 * becomes the session's resolved writer id, while a field already present
 * keeps its original value, so a doc edited long ago does not suddenly outrank
 * fresher remote edits.
 * That preserve-if-present rule is deliberately unlike the entity-store write
 * verbs, which always stamp fresh: this is a repair of an existing edit, not a
 * new one.
 */
import { remotePayloadWins } from '@interop/social-core'
import { lwwFields } from '@interop/pws-sync'
import type { LocalStore } from './localStore.js'

/**
 * Merges the collected anonymous-replica payloads into `store` (the already
 * open connected replica) under the per-uuid LWW policy above. Runs before the
 * first `hydrateAll`/sync start, so adopted rows enter the entity stores via
 * normal hydration and reach the server as ordinary creates on first push.
 *
 * The rows are written through `LocalStore` directly, which does not stamp;
 * the preserve-if-present / fill-if-missing repair below is deliberate and
 * differs from the entity-store write verbs' fresh-stamp-always rule, because
 * an adopted edit must keep the instant it was actually made.
 *
 * @param options {object}
 * @param options.store {LocalStore}   the open connected replica
 * @param options.entities {Record<string, Array<{ id: string }>>}   decrypted
 *   payloads per collection key, as collected from the anonymous replica
 * @param options.writerId {string}   the session's writer id, stamped onto
 *   adopted payloads that carry no `writerId` of their own
 * @returns {Promise<void>}
 */
export async function mergeAdopted({
  store,
  entities,
  writerId
}: {
  store: LocalStore
  entities: Record<string, Array<{ id: string }>>
  writerId: string
}): Promise<void> {
  let now: string | null = null
  // Collections are separate RxDB collections and each logical uuid appears at
  // most once per collection, so every write below is independent of every
  // other: they run concurrently rather than one round trip at a time.
  await Promise.all(
    Object.entries(entities).map(async ([key, payloads]) => {
      const existing = new Map(
        (await store.listEntities(key)).map(doc => [doc.id, doc])
      )
      await Promise.all(
        payloads.map(async payload => {
          let adopted = payload
          let adoptedLww = lwwFields(payload)
          if (!adoptedLww) {
            // Fill each field on its own: a payload carrying `updatedAt` but
            // no `writerId` keeps the instant it was edited, rather than being
            // re-stamped to now and outranking newer connected edits.
            const { updatedAt, writerId: payloadWriterId } = payload as {
              updatedAt?: unknown
              writerId?: unknown
            }
            adoptedLww = {
              updatedAt:
                typeof updatedAt === 'string'
                  ? updatedAt
                  : (now ??= new Date().toISOString()),
              writerId:
                typeof payloadWriterId === 'string' ? payloadWriterId : writerId
            }
            adopted = { ...payload, ...adoptedLww }
          }
          const current = existing.get(payload.id)
          if (!current) {
            await store.insertEntity(key, adopted)
            return
          }
          const currentLww = lwwFields(current)
          if (!currentLww || remotePayloadWins(adoptedLww, currentLww)) {
            await store.updateEntity(key, adopted)
          }
        })
      )
    })
  )
}
