/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * buildAppConnectVpr tests: the one-popup App Connect VPR carries a
 * DIDAuthentication query plus a single `AppConnectQuery` naming the app (its
 * display name and its canonical `appUrl`), with exactly one collection-scoped capability query per
 * requested collection -- and no `controller` or `reason` on those entries (the
 * wallet fills the controller; the consent screen supersedes reasons).
 */
import { describe, expect, it } from 'vitest'
import {
  buildAppConnectVpr,
  RW_ACTIONS,
  SHARED_ACTIONS
} from './loginRequest.js'
import type {
  IAppConnectCapabilityQuery,
  IAppConnectQuery,
  IVPRDetails
} from './walletRequestTypes.js'

const BASE = {
  challenge: 'challenge-1',
  domain: 'https://app.example',
  appName: 'Example',
  appUrl: 'https://app.example/notes-app'
}

function appConnectQueryOf(vpr: IVPRDetails): IAppConnectQuery {
  const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
  const query = queries.find(
    (entry): entry is IAppConnectQuery => entry.type === 'AppConnectQuery'
  )
  if (query === undefined) {
    throw new Error('No AppConnectQuery in the VPR.')
  }
  return query
}

function capabilityQueriesOf(vpr: IVPRDetails): IAppConnectCapabilityQuery[] {
  const { capabilityQuery } = appConnectQueryOf(vpr)
  return Array.isArray(capabilityQuery) ? capabilityQuery : [capabilityQuery]
}

describe('buildAppConnectVpr', () => {
  it('includes a DIDAuthentication query alongside the AppConnectQuery', () => {
    const vpr = buildAppConnectVpr({ ...BASE, collections: [{ id: 'notes' }] })
    const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
    expect(queries.map(entry => entry.type)).toEqual([
      'DIDAuthentication',
      'AppConnectQuery'
    ])
    expect(vpr.challenge).toBe(BASE.challenge)
    expect(vpr.domain).toBe(BASE.domain)
  })

  it('carries the app name and the serialized appUrl in the app block', () => {
    const vpr = buildAppConnectVpr({ ...BASE, collections: [{ id: 'notes' }] })
    expect(appConnectQueryOf(vpr).app).toEqual({
      name: BASE.appName,
      appUrl: BASE.appUrl
    })
  })

  it('emits the appUrl in serialized form, not as spelled', () => {
    const vpr = buildAppConnectVpr({
      ...BASE,
      appUrl: 'https://app.example:443/a/../notes-app',
      collections: [{ id: 'notes' }]
    })
    expect(appConnectQueryOf(vpr).app.appUrl).toBe(
      'https://app.example/notes-app'
    )
  })

  it('refuses an appUrl that is not same-origin with the domain', () => {
    expect(() =>
      buildAppConnectVpr({
        ...BASE,
        appUrl: 'https://other.example/notes-app',
        collections: [{ id: 'notes' }]
      })
    ).toThrow()
  })

  it('refuses an appUrl carrying a fragment', () => {
    expect(() =>
      buildAppConnectVpr({
        ...BASE,
        appUrl: 'https://app.example/notes-app#main',
        collections: [{ id: 'notes' }]
      })
    ).toThrow()
  })

  it('emits exactly one collection-scoped query per collection, no controller or reason', () => {
    const collections = [{ id: 'notes' }, { id: 'projects' }]
    const vpr = buildAppConnectVpr({ ...BASE, collections })
    const capabilityQuery = capabilityQueriesOf(vpr)

    expect(capabilityQuery).toHaveLength(collections.length)
    expect(capabilityQuery.map(entry => entry.referenceId)).toEqual(
      collections.map(collection => collection.id)
    )
    for (const entry of capabilityQuery) {
      expect(entry.invocationTarget).toEqual({
        type: 'https://w3id.org/byoe#private-collection',
        name: entry.referenceId
      })
      expect(entry.allowedAction).toEqual(RW_ACTIONS)
      // The wallet fills the controller; the consent screen supersedes reasons.
      expect('controller' in entry).toBe(false)
      expect('reason' in entry).toBe(false)
    }
  })

  it(
    'emits https://w3id.org/byoe#public-collection for visibility: public and keeps ' +
      'private collections on https://w3id.org/byoe#private-collection',
    () => {
      const vpr = buildAppConnectVpr({
        ...BASE,
        collections: [
          { id: 'microblog-posts', visibility: 'public' },
          { id: 'drafts', visibility: 'private' },
          { id: 'notes' }
        ]
      })
      const capabilityQuery = capabilityQueriesOf(vpr)

      expect(capabilityQuery.map(entry => entry.invocationTarget)).toEqual([
        {
          type: 'https://w3id.org/byoe#public-collection',
          name: 'microblog-posts'
        },
        { type: 'https://w3id.org/byoe#private-collection', name: 'drafts' },
        { type: 'https://w3id.org/byoe#private-collection', name: 'notes' }
      ])
      // Both classes allow the full action vocabulary, so each collection
      // requests exactly it.
      expect(capabilityQuery.map(entry => entry.allowedAction)).toEqual([
        RW_ACTIONS,
        RW_ACTIONS,
        RW_ACTIONS
      ])
    }
  )

  it('allows PUT and DELETE on a public collection', () => {
    const vpr = buildAppConnectVpr({
      ...BASE,
      collections: [{ id: 'microblog-posts', visibility: 'public' }],
      actions: ['GET', 'PUT', 'POST', 'DELETE']
    })
    const capabilityQuery = capabilityQueriesOf(vpr)
    expect(capabilityQuery[0]?.allowedAction).toEqual(RW_ACTIONS)
  })

  it('throws at build time on an action outside the vocabulary', () => {
    expect(() =>
      buildAppConnectVpr({
        ...BASE,
        collections: [{ id: 'microblog-posts', visibility: 'public' }],
        actions: ['GET', 'PATCH']
      })
    ).toThrow(/outside its class's allowed actions: PATCH/)
  })

  it('keeps an explicit narrower action set, in table order', () => {
    const vpr = buildAppConnectVpr({
      ...BASE,
      collections: [{ id: 'microblog-posts', visibility: 'public' }],
      actions: ['POST', 'GET']
    })
    const capabilityQuery = capabilityQueriesOf(vpr)
    expect(capabilityQuery[0]?.allowedAction).toEqual(['GET', 'POST'])
  })

  it('throws on an explicit empty action set (empty allowedAction means every action)', () => {
    expect(() =>
      buildAppConnectVpr({
        ...BASE,
        collections: [{ id: 'notes' }],
        actions: []
      })
    ).toThrow(/requests no actions/)
  })

  it('requests no whole-space (https://w3id.org/byoe#space) query', () => {
    const vpr = buildAppConnectVpr({ ...BASE, collections: [{ id: 'notes' }] })
    const capabilityQuery = capabilityQueriesOf(vpr)

    const hasSpaceQuery = capabilityQuery.some(
      entry =>
        typeof entry.invocationTarget === 'object' &&
        entry.invocationTarget.type === 'https://w3id.org/byoe#space'
    )
    expect(hasSpaceQuery).toBe(false)
  })

  it('honors a custom action set', () => {
    const vpr = buildAppConnectVpr({
      ...BASE,
      collections: [{ id: 'notes' }],
      actions: ['GET']
    })
    const capabilityQuery = capabilityQueriesOf(vpr)
    expect(capabilityQuery).toHaveLength(1)
    expect(capabilityQuery[0]?.allowedAction).toEqual(['GET'])
  })

  it('emits an empty capabilityQuery when no collections are requested', () => {
    const vpr = buildAppConnectVpr({ ...BASE, collections: [] })
    expect(capabilityQueriesOf(vpr)).toEqual([])
  })

  it(
    'appends one read-only https://w3id.org/byoe#shared-wallet-collection ' +
      'descriptor per shared id',
    () => {
      const vpr = buildAppConnectVpr({
        ...BASE,
        collections: [{ id: 'notes' }],
        sharedCollections: ['private-credentials', 'contacts']
      })
      const capabilityQuery = capabilityQueriesOf(vpr)
      expect(capabilityQuery).toHaveLength(3)
      // App collections first, then the shares, in declaration order.
      expect(capabilityQuery.slice(1)).toEqual([
        {
          referenceId: 'private-credentials',
          allowedAction: SHARED_ACTIONS,
          invocationTarget: {
            type: 'https://w3id.org/byoe#shared-wallet-collection',
            name: 'private-credentials'
          }
        },
        {
          referenceId: 'contacts',
          allowedAction: SHARED_ACTIONS,
          invocationTarget: {
            type: 'https://w3id.org/byoe#shared-wallet-collection',
            name: 'contacts'
          }
        }
      ])
      // Read-only by construction: a custom RW action set never reaches a
      // share.
      expect(SHARED_ACTIONS).toEqual(['GET'])
    }
  )

  it('keeps shared descriptors read-only even under a custom action set', () => {
    const vpr = buildAppConnectVpr({
      ...BASE,
      collections: [{ id: 'notes' }],
      sharedCollections: ['contacts'],
      actions: ['GET', 'PUT', 'POST', 'DELETE']
    })
    const capabilityQuery = capabilityQueriesOf(vpr)
    expect(capabilityQuery[0]?.allowedAction).toEqual(RW_ACTIONS)
    expect(capabilityQuery[1]?.allowedAction).toEqual(SHARED_ACTIONS)
  })
})
