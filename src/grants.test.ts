/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect } from 'vitest'
import type { IZcap } from '@interop/data-integrity-core'
import { parseGrants, parseInvocationTarget } from './grants.js'

/**
 * Minimal delegated-zcap stub carrying just the fields `parseGrants` reads.
 */
function grant(invocationTarget: string): IZcap {
  return {
    '@context': ['https://w3id.org/zcap/v1'],
    id: `urn:uuid:${invocationTarget}`,
    parentCapability: 'urn:zcap:root:x',
    controller: 'did:key:zApp',
    invocationTarget,
    allowedAction: ['GET', 'PUT'],
    expires: '2099-01-01T00:00:00Z',
    proof: {}
  } as unknown as IZcap
}

describe('parseInvocationTarget', () => {
  it('splits a collection target into origin, space, collection', () => {
    const parsed = parseInvocationTarget(
      'http://localhost:3002/space/abc123/action-items'
    )
    expect(parsed).toEqual({
      baseUrl: 'http://localhost:3002',
      spaceId: 'abc123',
      collectionId: 'action-items'
    })
  })

  it('tolerates a trailing slash on a collection target', () => {
    const parsed = parseInvocationTarget('https://was.example/space/s1/notes/')
    expect(parsed.baseUrl).toBe('https://was.example')
    expect(parsed.spaceId).toBe('s1')
    expect(parsed.collectionId).toBe('notes')
  })

  it('rejects a space-scoped target (no collection)', () => {
    expect(() =>
      parseInvocationTarget('https://was.example/space/s1/')
    ).toThrow(/not collection-scoped/)
    expect(() => parseInvocationTarget('https://was.example/space/s1')).toThrow(
      /not collection-scoped/
    )
  })

  it('rejects a non-WAS URL', () => {
    expect(() => parseInvocationTarget('http://x/not-a-space/y')).toThrow()
    expect(() => parseInvocationTarget('not-a-url')).toThrow()
  })
})

describe('parseGrants', () => {
  it('routes per-collection grants and derives one server + space', () => {
    const parsed = parseGrants([
      grant('http://localhost:3002/space/abc/action-items'),
      grant('http://localhost:3002/space/abc/projects'),
      grant('http://localhost:3002/space/abc/current-focus')
    ])
    expect(parsed.baseUrl).toBe('http://localhost:3002')
    expect(parsed.spaceId).toBe('abc')
    expect(Object.keys(parsed.byCollectionId).sort()).toEqual([
      'action-items',
      'current-focus',
      'projects'
    ])
    expect(parsed.byCollectionId['action-items']?.invocationTarget).toBe(
      'http://localhost:3002/space/abc/action-items'
    )
  })

  it('rejects a space-scoped grant (no collection segment)', () => {
    expect(() =>
      parseGrants([
        grant('http://localhost:3002/space/abc/'),
        grant('http://localhost:3002/space/abc/goals')
      ])
    ).toThrow(/not collection-scoped/)
  })

  it('rejects grants spanning two servers', () => {
    expect(() =>
      parseGrants([
        grant('http://localhost:3002/space/abc/goals'),
        grant('http://localhost:4000/space/abc/projects')
      ])
    ).toThrow(/two servers/)
  })

  it('rejects grants spanning two spaces', () => {
    expect(() =>
      parseGrants([
        grant('http://localhost:3002/space/abc/goals'),
        grant('http://localhost:3002/space/def/projects')
      ])
    ).toThrow(/two spaces/)
  })

  it('rejects an empty grant set', () => {
    expect(() => parseGrants([])).toThrow()
  })
})
