/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The one acquisition policy for an `edv` collection's encryption descriptor:
 * was-client's `acquireDescriptor` under `requireGoverned`, so a descriptor is
 * adopted only through a source that declares `verifiesHistory: true`
 * ({@link WasRemoteStore.descriptorSource}). A plain source is refused with
 * `UnverifiedDescriptorError` before any fetch, and nothing refused is cached.
 * The login-time read, the sync bootstrap's install, and the local store's
 * unknown-epoch refresh acquire through {@link acquireGovernedDescriptor}. A
 * shared collection's self-refreshing cipher acquires inside was-client's own
 * build and cannot, so it applies the same two rules itself: `requireGoverned`,
 * and {@link fetchErrorSink} for the swallowed-fetch rethrow. Both consumers
 * classify what the acquisition refused with {@link isDescriptorRefusal}.
 */
import {
  acquireDescriptor,
  isKeyUnwrapError,
  UnverifiedDescriptorError
} from '@interop/was-client/edv'
import { isIntegrityError } from '@interop/was-client/sync'
import { isResourceLogRefusal } from '@interop/vh-resource-log'
import type {
  EncryptionDescriptorCache,
  EncryptionDescriptorSource
} from '@interop/was-client/edv'
import type { CollectionEncryption } from '@interop/was-client'

/**
 * A per-call in-memory `EncryptionDescriptorCache`: the cache seam
 * `acquireDescriptor` requires, where the caller keeps its own copy of the
 * result and wants no fallback to an earlier fetch.
 *
 * @returns {EncryptionDescriptorCache}
 */
export function memoryDescriptorCache(): EncryptionDescriptorCache {
  const descriptors = new Map<string, CollectionEncryption>()
  return {
    async readDescriptor({ collectionId }: { collectionId: string }) {
      return descriptors.get(collectionId)
    },
    async writeDescriptor({
      collectionId,
      descriptor
    }: {
      collectionId: string
      descriptor: CollectionEncryption
    }) {
      descriptors.set(collectionId, descriptor)
    }
  }
}

/**
 * Records the fetch failure was-client's acquisition swallows (it falls back
 * to the cache, which is empty here, so the answer would read as "no
 * descriptor") and rethrows it on demand. `onFetchError` is handed to the
 * acquiring call; `rethrow` runs after it, whether it resolved or rejected,
 * so "unknown" stays apart from "no descriptor". The error is boxed so a
 * falsy one is still recorded.
 *
 * @returns {object}   `onFetchError` to pass through, and `rethrow`
 */
export function fetchErrorSink(): {
  onFetchError: (err: unknown) => void
  rethrow: () => void
} {
  let fetchError: { err: unknown } | undefined
  return {
    onFetchError: err => {
      fetchError = { err }
    },
    rethrow: () => {
      if (fetchError) {
        throw fetchError.err
      }
    }
  }
}

/**
 * Whether an acquisition failure is a refusal that must surface as itself: a
 * source that does not verify the governing log
 * (`UnverifiedDescriptorError`, whose message names the fix), or a governing
 * log the source refused to adopt (a forged or discontinuous chain, matched by
 * name through vh-resource-log's own taxonomy). Both are security signals;
 * relabeling either as "not a recipient" or as the envelope's unknown epoch
 * would send it down a caller's warn-and-skip branch.
 *
 * @param err {unknown}
 * @returns {boolean}
 */
export function isDescriptorRefusal(err: unknown): err is Error {
  return err instanceof UnverifiedDescriptorError || isResourceLogRefusal(err)
}

/**
 * Whether a cipher build failed on the roster's own answer about this app: it
 * lists the epoch but wraps no key to this app (`KeyUnwrapError`), or its
 * entry for this app fails its key-wrap check (`IntegrityError`, a corrupt or
 * tampered entry). Either repeats on every retry against the same roster, so
 * a caller spends no further read on it: the refresh guard records it, and an
 * expired restore clears the record that would re-run the same bring-up.
 *
 * @param err {unknown}
 * @returns {boolean}
 */
export function isRosterEntryFailure(err: unknown): err is Error {
  return (
    err instanceof Error && (isKeyUnwrapError(err) || isIntegrityError(err))
  )
}

/**
 * Acquires one collection's descriptor through a verifying source. Resolves
 * `undefined` only for a collection with no governing log (unprovisioned, or
 * plaintext). Throws `UnverifiedDescriptorError` for a source that does not
 * verify, rethrows a verification refusal unchanged, and rethrows a swallowed
 * fetch failure ({@link fetchErrorSink}): every caller here must keep
 * "unknown" apart from "no descriptor", or a login would open a correctly
 * provisioned collection fail-closed over a network hiccup.
 *
 * @param options {object}
 * @param options.source {EncryptionDescriptorSource}
 * @param options.collectionId {string}
 * @returns {Promise<CollectionEncryption | undefined>}
 */
export async function acquireGovernedDescriptor({
  source,
  collectionId
}: {
  source: EncryptionDescriptorSource
  collectionId: string
}): Promise<CollectionEncryption | undefined> {
  const sink = fetchErrorSink()
  const descriptor = await acquireDescriptor({
    source,
    cache: memoryDescriptorCache(),
    collectionId,
    requireGoverned: true,
    onFetchError: sink.onFetchError
  })
  sink.rethrow()
  return descriptor
}
