/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The wipe enumeration: the one list of durable local state this library leaves
 * on a browser, and the one executor that deletes it. Clearing data must leave
 * nothing behind, and the failure it exists to prevent is an ORPHANED database
 * -- one whose name is derived from an identity the clear itself destroyed, so
 * no later run can name it, let alone delete it.
 *
 * Three rules keep that from happening:
 *
 * - Snapshot first. Every target is derived from live state BEFORE anything is
 *   deleted ({@link snapshotWipeTargets}), so the order of the deletions that
 *   follow cannot lose a name.
 * - Delete by known name. Each replica's database name is computable from its
 *   controller DID through `dbNameForController`, so it is deleted by that name
 *   whether or not the engine can enumerate databases.
 * - Treat `indexedDB.databases()` as discovery and verification, never as the
 *   deletion gate. An engine that does not implement it still gets every named
 *   database deleted; what it cannot confirm is reported as `unverified` rather
 *   than counted toward an outcome that reads clean.
 *
 * What the prefix sweep reaches beyond the snapshot: anonymous replicas that
 * earlier versions of this library already orphaned, and the replicas of other
 * wallet identities on this browser. Both are this app's own databases under
 * its own `dbName`, and removing them is what clearing data means.
 *
 * What no enumeration here reaches, stated plainly: data already synced to the
 * WAS server (this is a local clear, not an account deletion), forensic
 * recoverability of deleted IndexedDB data, and anything the app itself
 * persisted outside this library.
 */
import { DEFAULT_STORAGE_KEY_PREFIX } from '../config.js'
import {
  LocalStore,
  dbNameForController,
  type ReplicaStorage
} from '../storage/localStore.js'
import { clearPersistedWriterId } from '../storage/writerId.js'
import { log } from '../log.js'

/**
 * Every durable local target of a wipe, derived up front.
 */
export interface WipeTargets {
  /**
   * The RxDB replica database names, one per controller DID the snapshot could
   * reach (the connected identity, the anonymous one, or both).
   */
  replicaDbNames: string[]
  /**
   * The raw-IndexedDB seed stores: the session store (app-key seed, session
   * record, descriptor cache) and the anonymous seed store.
   */
  seedStoreDbNames: string[]
  /**
   * The name prefixes the sweep matches: the app's own base `dbName` (the seed
   * stores) and the RxDB/Dexie mangling of it (each replica collection is its
   * own IndexedDB database, named `rxdb-dexie-<dbName>-<hash>--<v>--<name>`).
   * Empty means no sweep: only the named targets and their Dexie sub-databases
   * are deleted and verified.
   */
  idbNamePrefixes: string[]
  /**
   * The localStorage prefix whose writer id is cleared, or `null` to leave it
   * in place (the logout grade: the user is expected to log back in on this
   * browser, and the id is only an attribution stamp).
   */
  storageKeyPrefix: string | null
}

/**
 * What a wipe deleted, and what it could not confirm.
 */
export interface LocalWipeReport {
  /**
   * The database names the executor issued a delete for and, where the engine
   * could confirm it, saw gone afterwards.
   */
  removed: string[]
  /**
   * Databases still present after the wipe, or whose delete threw.
   */
  failed: string[]
  /**
   * Deletions that were issued but could not be confirmed -- an engine without
   * `indexedDB.databases()`, or a delete another tab is blocking. Neither a
   * success nor a failure: a caller states the unconfirmed outcome rather than
   * claiming a clean wipe.
   */
  unverified: string[]
}

/**
 * Derives every wipe target from live state, before anything is deleted, at one
 * of the two grades the library ships:
 *
 * - `logout` (log out and erase): the CONNECTED replica and the session store.
 *   The anonymous replica and the writer id deliberately survive -- a
 *   local-first app keeps working logged out, and the user is expected to log
 *   back in on this browser -- so this grade runs no prefix sweep, which would
 *   reach the anonymous replica it is meant to spare.
 * - `clear` (clear data): everything this app ever wrote here -- both replicas,
 *   both seed stores, the writer id -- plus a prefix sweep for whatever the
 *   snapshot could not name.
 *
 * The anonymous controller DID must be resolved by the caller (re-derived from
 * the persisted anonymous seed) while that seed still exists: once it is
 * discarded, the database it names is unreachable.
 *
 * @param options {object}
 * @param options.dbName {string}   the app's base database name
 * @param options.grade {'logout' | 'clear'}
 * @param [options.connectedControllerDid] {string | null}   the wallet-derived
 *   controller DID, when a connected replica is open
 * @param [options.anonControllerDid] {string | null}   the anonymous controller
 *   DID (`clear` only; ignored at the `logout` grade)
 * @param [options.storageKeyPrefix] {string}   the localStorage prefix whose
 *   writer id the `clear` grade removes
 * @returns {WipeTargets}
 */
export function snapshotWipeTargets({
  dbName,
  grade,
  connectedControllerDid,
  anonControllerDid,
  storageKeyPrefix = DEFAULT_STORAGE_KEY_PREFIX
}: {
  dbName: string
  grade: 'logout' | 'clear'
  connectedControllerDid?: string | null
  anonControllerDid?: string | null
  storageKeyPrefix?: string
}): WipeTargets {
  const clearing = grade === 'clear'
  const dids = [
    connectedControllerDid,
    ...(clearing ? [anonControllerDid] : [])
  ].filter(did => !!did) as string[]
  return {
    replicaDbNames: [...new Set(dids)].map(controllerDid =>
      dbNameForController({ dbName, controllerDid })
    ),
    seedStoreDbNames: clearing
      ? [`${dbName}-session`, `${dbName}-anon`]
      : [`${dbName}-session`],
    idbNamePrefixes: clearing ? [`${dbName}-`, `rxdb-dexie-${dbName}-`] : [],
    storageKeyPrefix: clearing ? storageKeyPrefix : null
  }
}

/**
 * Lists the IndexedDB database names, or `null` on an engine that does not
 * implement `databases()` (or refuses the call).
 *
 * @param idb {IDBFactory}
 * @returns {Promise<string[] | null>}
 */
async function listDatabaseNames(idb: IDBFactory): Promise<string[] | null> {
  if (typeof idb.databases !== 'function') {
    return null
  }
  try {
    const listed = await idb.databases()
    return listed.map(entry => entry.name).filter(name => !!name) as string[]
  } catch (err) {
    log.warn('Could not enumerate IndexedDB databases', { err })
    return null
  }
}

/**
 * Deletes one IndexedDB database by name. A delete another connection is
 * blocking is reported rather than awaited forever: the request stays pending
 * in the engine, and the executor's verification probe is what decides whether
 * it landed.
 *
 * @param options {object}
 * @param options.name {string}
 * @param options.idb {IDBFactory}
 * @returns {Promise<{ blocked: boolean }>}
 */
async function deleteIdbDatabase({
  name,
  idb
}: {
  name: string
  idb: IDBFactory
}): Promise<{ blocked: boolean }> {
  return await new Promise((resolve, reject) => {
    const request = idb.deleteDatabase(name)
    request.onsuccess = () => resolve({ blocked: false })
    request.onblocked = () => resolve({ blocked: true })
    request.onerror = () =>
      reject(request.error ?? new Error(`Could not delete database ${name}.`))
  })
}

/**
 * Executes a wipe over a snapshot: the replica databases (through RxDB, so each
 * one's internal metadata store goes with its collections), the seed stores,
 * then a prefix sweep for anything the snapshot could not name, then the writer
 * id. Every stage is best-effort and its failure is collected rather than
 * aborting the rest, because a stage that throws must not leave the later
 * stages' state behind.
 *
 * The live replica must already be torn down (an open database blocks its own
 * deletion), which is the caller's job.
 *
 * @param options {object}
 * @param options.targets {WipeTargets}
 * @param [options.storage] {ReplicaStorage}   the storage the replicas were
 *   created with (defaults to Dexie/IndexedDB)
 * @param [options.idb] {IDBFactory}   the IndexedDB factory (defaults to the
 *   global one; inject a fake for tests)
 * @returns {Promise<LocalWipeReport>}
 */
export async function executeLocalWipe({
  targets,
  storage,
  idb = indexedDB
}: {
  targets: WipeTargets
  storage?: ReplicaStorage
  idb?: IDBFactory
}): Promise<LocalWipeReport> {
  const issued = new Set<string>()
  const failed = new Set<string>()
  const unverified = new Set<string>()
  // Deletes another connection is holding up. The engine keeps the request
  // pending, so one of these still standing at the end is unconfirmed rather
  // than failed.
  const blockedNames = new Set<string>()

  for (const name of targets.replicaDbNames) {
    try {
      await LocalStore.removeDatabase({
        dbName: name,
        ...(storage && { storage })
      })
      issued.add(name)
    } catch (err) {
      log.warn('Could not remove a replica database', { dbName: name, err })
      failed.add(name)
    }
  }

  for (const name of targets.seedStoreDbNames) {
    try {
      const { blocked } = await deleteIdbDatabase({ name, idb })
      issued.add(name)
      if (blocked) {
        blockedNames.add(name)
        unverified.add(name)
      }
    } catch (err) {
      log.warn('Could not delete a seed store', { dbName: name, err })
      failed.add(name)
    }
  }

  // What the sweep deletes and the verification probe looks for: anything
  // under one of the app's prefixes, plus every named target and the Dexie
  // sub-databases that embed its name. The second half is what makes RxDB's
  // own removal complete -- `RxDatabase.remove()` clears each collection's
  // table but leaves its IndexedDB database standing.
  function matchesApp(name: string): boolean {
    return (
      targets.idbNamePrefixes.some(prefix => name.startsWith(prefix)) ||
      [...targets.replicaDbNames, ...targets.seedStoreDbNames].some(
        target => name === target || name.includes(target)
      )
    )
  }

  const listed = await listDatabaseNames(idb)
  if (listed === null) {
    // No enumeration: the named deletes above still ran, but nothing sweeps
    // and nothing confirms, so every issued name is reported unconfirmed.
    for (const name of issued) {
      unverified.add(name)
    }
  } else {
    for (const name of listed.filter(matchesApp)) {
      try {
        const { blocked } = await deleteIdbDatabase({ name, idb })
        issued.add(name)
        if (blocked) {
          blockedNames.add(name)
          unverified.add(name)
        }
      } catch (err) {
        log.warn('Could not delete a database', { dbName: name, err })
        failed.add(name)
      }
    }
  }

  if (targets.storageKeyPrefix !== null) {
    clearPersistedWriterId({ storageKeyPrefix: targets.storageKeyPrefix })
  }

  const remaining = await listDatabaseNames(idb)
  for (const name of (remaining ?? []).filter(matchesApp)) {
    if (blockedNames.has(name)) {
      continue
    }
    unverified.delete(name)
    failed.add(name)
  }

  return {
    removed: [...issued].filter(name => !failed.has(name)),
    failed: [...failed],
    unverified: [...unverified]
  }
}
