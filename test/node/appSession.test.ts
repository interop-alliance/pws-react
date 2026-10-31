/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * App-session persistence tests (fake-indexeddb): persist/peek round trip,
 * an expired record surviving the read (the hot restore lands `reconnect` on
 * it), the earliest-expiry reduction, and logout wiping.
 */
import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { IZcap } from '@interop/data-integrity-core'
import {
  clearAppSession,
  earliestExpiry,
  isExpired,
  peekAppSession,
  persistAppSession,
  type AppSession
} from '../../src/identity/appSession.js'
import { createSeedStore } from '../../src/identity/seedStore.js'

const DB_NAME = 'pws-react-session'

function newStore() {
  return createSeedStore({ dbName: DB_NAME, idb: new IDBFactory() })
}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function sessionFixture(expires: string): AppSession {
  return {
    seed: crypto.getRandomValues(new Uint8Array(32)),
    controllerDid: 'did:key:z6MkTest',
    spaceUrl: 'http://localhost:3999/space/space-1/',
    grants: [
      { id: 'urn:zcap:1', invocationTarget: 'http://x/space/space-1/a' }
    ] as unknown as IZcap[],
    expires
  }
}

describe('isExpired', () => {
  it('is false for a future timestamp and true for a past one', () => {
    expect(isExpired(futureIso(60_000))).toBe(false)
    expect(isExpired(new Date(Date.now() - 60_000).toISOString())).toBe(true)
  })

  it('treats malformed timestamps as expired', () => {
    expect(isExpired('not-a-date')).toBe(true)
  })
})

describe('earliestExpiry', () => {
  it('returns the earliest parseable expiry', () => {
    const early = futureIso(1000)
    const late = futureIso(100_000)
    const grants = [
      { expires: late },
      { expires: early },
      {},
      { expires: 'garbage' }
    ] as unknown as IZcap[]
    expect(earliestExpiry(grants)).toBe(early)
  })

  it('returns null when no grant carries a parseable expiry', () => {
    expect(earliestExpiry([{} as unknown as IZcap])).toBeNull()
  })
})

describe('persist/peek', () => {
  it('round-trips a live session', async () => {
    const store = newStore()
    const session = sessionFixture(futureIso(60_000))
    await persistAppSession({ session, store })
    const { seed, record } = await peekAppSession({ store })
    expect(seed).toEqual(session.seed)
    expect(record).not.toBeNull()
    expect(record!.controllerDid).toBe(session.controllerDid)
    expect(record!.spaceUrl).toBe(session.spaceUrl)
    expect(record!.grants).toEqual(session.grants)
    expect(record!.expires).toBe(session.expires)
  })

  it('answers null halves with nothing persisted', async () => {
    const store = newStore()
    expect(await peekAppSession({ store })).toEqual({
      seed: null,
      record: null
    })
  })

  it('keeps an expired record and its seed, leaving the expiry to the caller', async () => {
    const store = newStore()
    const session = sessionFixture(new Date(Date.now() - 1000).toISOString())
    await persistAppSession({ session, store })
    const { seed, record } = await peekAppSession({ store })
    expect(seed).toEqual(session.seed)
    expect(record!.expires).toBe(session.expires)
    expect(isExpired(record!.expires)).toBe(true)
    // Nothing was wiped by the read.
    const again = await peekAppSession({ store })
    expect(again.seed).toEqual(session.seed)
    expect(again.record).toEqual(record)
  })

  it('answers a null record for a structurally invalid one', async () => {
    const store = newStore()
    const session = sessionFixture(futureIso(60_000))
    await persistAppSession({
      session: { ...session, grants: [] },
      store
    })
    const { seed, record } = await peekAppSession({ store })
    expect(seed).toEqual(session.seed)
    expect(record).toBeNull()
  })

  it('clearAppSession wipes the persisted session', async () => {
    const store = newStore()
    await persistAppSession({
      session: sessionFixture(futureIso(60_000)),
      store
    })
    await clearAppSession({ store })
    expect(await peekAppSession({ store })).toEqual({
      seed: null,
      record: null
    })
  })
})
