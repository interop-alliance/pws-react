/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The persisted app session: what a reload needs to restore the authenticated
 * state with ZERO wallet popups. It is adapted to the delegated model, where the
 * app is the requester (an app, service, or agent) and the seed itself is
 * persisted -- the wallet remains the recovery source of truth, this is only
 * the hot cache.
 *
 * Record: `{ seed, controllerDid, baseUrl, spaceId, grants, expires }`.
 * `baseUrl` is the WAS server's base URL (`ParsedGrants.baseUrl`).
 * `expires` is the earliest `expires` across the granted zcaps; a record past
 * it is cleared on load and the caller falls through to the returning-login
 * flow (same seed comes back from the wallet, same DID, same vault keys).
 *
 * Persistence rides on a `SeedStore` (see `seedStore.ts`) the caller supplies.
 */
import type { IZcap } from '@interop/data-integrity-core'
import type { SeedStore } from './seedStore.js'

export interface AppSessionRecord {
  controllerDid: string
  baseUrl: string
  spaceId: string
  grants: IZcap[]
  /**
   * ISO timestamp: the earliest expiry across the granted zcaps.
   */
  expires: string
}

/**
 * A restored session: the record plus the separately persisted seed.
 */
export interface RestoredAppSession extends AppSessionRecord {
  seed: Uint8Array
}

/**
 * A nominal far-future expiry (ms) standing in for "no expiry": used both for a
 * login that returned no grants (so there is no earliest-expiry to report) and
 * for grants minted without one (dev/test). Well past any near-expiry warning,
 * so the expiry watch never fires against it.
 */
export const NO_EXPIRY_MS = 100 * 365 * 24 * 60 * 60 * 1000

/**
 * Whether an ISO `expires` timestamp is in the past (or malformed).
 */
export function isExpired(expires: string, now: Date = new Date()): boolean {
  const at = new Date(expires).getTime()
  return Number.isNaN(at) || at <= now.getTime()
}

/**
 * Whether an ISO `expires` timestamp is within `thresholdMs` of now (or already
 * past, or malformed) -- the signal to surface the reconnect banner proactively,
 * before a live request fails with 401/403.
 */
export function isNearExpiry(
  expires: string,
  thresholdMs: number,
  now: Date = new Date()
): boolean {
  const at = new Date(expires).getTime()
  if (Number.isNaN(at)) {
    return true
  }
  return at - now.getTime() <= thresholdMs
}

/**
 * The earliest `expires` across a grant set. Grants without a parseable
 * `expires` are ignored; returns `null` when none carries one (callers treat
 * that as not restorable -- wallet grants always carry an expiry).
 */
export function earliestExpiry(grants: IZcap[]): string | null {
  let earliest: string | null = null
  for (const grant of grants) {
    const expires = (grant as { expires?: unknown }).expires
    if (typeof expires !== 'string') {
      continue
    }
    const at = new Date(expires).getTime()
    if (Number.isNaN(at)) {
      continue
    }
    if (earliest === null || at < new Date(earliest).getTime()) {
      earliest = expires
    }
  }
  return earliest
}

/**
 * Persists the session (seed + record) for hot restore.
 *
 * @param options {object}
 * @param options.session {RestoredAppSession}
 * @param options.store {SeedStore}
 * @returns {Promise<void>}
 */
export async function persistAppSession({
  session,
  store
}: {
  session: RestoredAppSession
  store: SeedStore
}): Promise<void> {
  const { seed, ...record } = session
  await store.saveSeed(seed)
  await store.saveRecord(record)
}

/**
 * Whether a value loaded out of a {@link SeedStore} is a structurally complete
 * session record. Says nothing about freshness -- an expired record is still a
 * well-formed one (which is exactly what the reconnect path reads).
 *
 * @param stored {unknown}
 * @returns {boolean}
 */
function isAppSessionRecord(stored: unknown): stored is AppSessionRecord {
  const record = stored as AppSessionRecord | null
  return (
    !!record &&
    typeof record.controllerDid === 'string' &&
    typeof record.baseUrl === 'string' &&
    typeof record.spaceId === 'string' &&
    Array.isArray(record.grants) &&
    record.grants.length > 0 &&
    typeof record.expires === 'string'
  )
}

/**
 * Reads the persisted seed and session record WITHOUT clearing anything and
 * WITHOUT applying the expiry rule -- the reconnect path's read, where the
 * record being past its expiry is the normal case and the seed must survive it
 * (only the grants need renewing). Either half comes back `null` when it is
 * missing or malformed.
 *
 * Use {@link restoreAppSession} for a hot restore instead: it enforces the
 * expiry and wipes a stale record.
 *
 * @param options {object}
 * @param options.store {SeedStore}
 * @returns {Promise<{ seed: Uint8Array | null, record: AppSessionRecord | null }>}
 */
export async function peekAppSession({ store }: { store: SeedStore }): Promise<{
  seed: Uint8Array | null
  record: AppSessionRecord | null
}> {
  const [seed, stored] = await Promise.all([
    store.loadSeed(),
    store.loadRecord()
  ])
  return {
    seed: seed ?? null,
    record: isAppSessionRecord(stored) ? stored : null
  }
}

/**
 * Restores the persisted session, or returns `null` (clearing any stale state)
 * when it is missing, malformed, or expired.
 *
 * @param options {object}
 * @param options.store {SeedStore}
 * @returns {Promise<RestoredAppSession | null>}
 */
export async function restoreAppSession({
  store
}: {
  store: SeedStore
}): Promise<RestoredAppSession | null> {
  const { seed, record } = await peekAppSession({ store })
  if (!seed || !record) {
    return null
  }
  if (isExpired(record.expires)) {
    await clearAppSession({ store })
    return null
  }
  return { seed, ...record }
}

/**
 * Wipes the persisted session (seed + record).
 *
 * @param options {object}
 * @param options.store {SeedStore}
 * @returns {Promise<void>}
 */
export async function clearAppSession({
  store
}: {
  store: SeedStore
}): Promise<void> {
  await store.clearSeedStore()
}
