/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Persistence of the per-install writer id: the last-write-wins tiebreak the
 * storage context stamps into every payload. The mint itself lives in
 * `@interop/pws-sync`, which takes both the key prefix and the storage as
 * required inputs; this module is the browser binding that supplies
 * {@link DEFAULT_STORAGE_KEY_PREFIX} and `localStorage`, so callers here keep
 * passing an optional prefix and nothing else.
 *
 * {@link getWriterId} resolves the id from localStorage (minting one on a
 * miss), {@link clearPersistedWriterId} removes it (the clear-data grade of the
 * wipe). The in-memory value a session stamps with lives on its
 * {@link StorageContext}; nothing here holds state.
 */
import {
  clearPersistedWriterId as clearMintedWriterId,
  getWriterId as mintWriterId,
  type WriterIdStorage
} from '@interop/pws-sync'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../config.js'

/**
 * `localStorage` as the mint's storage port. Reading the global lazily (rather
 * than capturing it at module load) keeps this module importable where there is
 * none: the mint's own try/catch then answers with a fresh id per call, since a
 * remembered module-level fallback would stamp one label into two accounts'
 * histories in the same tab.
 */
const browserStorage: WriterIdStorage = {
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key)
}

/**
 * A stable per-install writer id (the last-write-wins tiebreak stamped into
 * every payload), persisted in localStorage under `<prefix>writerId`.
 *
 * The id is an unkeyed, clearable attribution label -- never an identity.
 *
 * @param [options] {object}
 * @param [options.storageKeyPrefix] {string}   the localStorage key prefix
 *   (defaults to {@link DEFAULT_STORAGE_KEY_PREFIX})
 * @returns {string}
 */
export function getWriterId({
  storageKeyPrefix = DEFAULT_STORAGE_KEY_PREFIX
}: { storageKeyPrefix?: string } = {}): string {
  return mintWriterId({ storageKeyPrefix, storage: browserStorage })
}

/**
 * Clears the persisted writer id (the clear-data grade of the wipe), so nothing
 * this library wrote survives in localStorage. Only persistence is touched; the
 * running session's in-memory id is replaced by
 * {@link StorageContext.resetWriterId}, because the session keeps running over
 * its new anonymous replica and its write verbs still have to stamp.
 *
 * @param [options] {object}
 * @param [options.storageKeyPrefix] {string}   the localStorage key prefix
 *   (defaults to {@link DEFAULT_STORAGE_KEY_PREFIX})
 * @returns {void}
 */
export function clearPersistedWriterId({
  storageKeyPrefix = DEFAULT_STORAGE_KEY_PREFIX
}: { storageKeyPrefix?: string } = {}): void {
  clearMintedWriterId({ storageKeyPrefix, storage: browserStorage })
}
