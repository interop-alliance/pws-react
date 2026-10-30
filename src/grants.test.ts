/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect } from 'vitest'
import type { IZcap } from '@interop/data-integrity-core'
import { ValidationError } from '@interop/was-client'
import { rootCapabilityId } from '@interop/was-client/paths'
import { parseGrants, parseGrantTarget } from './grants.js'

const SPACE_URL = 'http://localhost:3002/space/abc/'

/**
 * Minimal delegated-zcap stub carrying just the fields `parseGrants` reads:
 * a chain rooted at `spaceUrl`'s root capability, and the target.
 */
function grant(invocationTarget: string, spaceUrl = SPACE_URL): IZcap {
  return {
    '@context': ['https://w3id.org/zcap/v1'],
    id: `urn:uuid:${invocationTarget}`,
    parentCapability: rootCapabilityId(spaceUrl),
    controller: 'did:key:zApp',
    invocationTarget,
    allowedAction: ['GET', 'PUT'],
    expires: '2099-01-01T00:00:00Z',
    proof: {}
  } as unknown as IZcap
}

describe('parseGrantTarget', () => {
  it('reads the Space off the chain root and the collection off the target', () => {
    const parsed = parseGrantTarget(grant(`${SPACE_URL}action-items`))
    expect(parsed).toEqual({
      spaceUrl: SPACE_URL,
      collectionId: 'action-items'
    })
  })

  it('canonicalizes a bare Space URL in the root id', () => {
    const parsed = parseGrantTarget(
      grant(
        'https://was.example/space/s1/notes/',
        'https://was.example/space/s1'
      )
    )
    expect(parsed.spaceUrl).toBe('https://was.example/space/s1/')
    expect(parsed.collectionId).toBe('notes')
  })

  it('reads the Space off a chain rooted in the delegation proof', () => {
    const generation = `urn:zcap:${crypto.randomUUID()}`
    const deep = {
      ...grant(`${SPACE_URL}notes`),
      parentCapability: generation,
      proof: {
        proofPurpose: 'capabilityDelegation',
        capabilityChain: [rootCapabilityId(SPACE_URL), generation]
      }
    } as unknown as IZcap
    expect(parseGrantTarget(deep).spaceUrl).toBe(SPACE_URL)
  })

  it('rejects a space-scoped target (no collection)', () => {
    expect(() => parseGrantTarget(grant(SPACE_URL))).toThrow(
      /not collection-scoped/
    )
    expect(() => parseGrantTarget(grant(SPACE_URL.slice(0, -1)))).toThrow(
      /not collection-scoped/
    )
  })

  it('rejects a target outside the Space the chain roots in', () => {
    expect(() =>
      parseGrantTarget(grant('http://localhost:3002/space/other/notes'))
    ).toThrow(/not beneath the Space/)
  })

  it('rejects a grant whose chain roots in no Space, as a grant error', () => {
    const rootless = {
      ...grant(`${SPACE_URL}notes`),
      parentCapability: 'urn:x'
    }
    let caught: unknown
    try {
      parseGrantTarget(rootless as IZcap)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(ValidationError)
    expect((caught as Error).message).toMatch(/not rooted in a Space/)
    expect((caught as Error).cause).toBeInstanceOf(ValidationError)
    expect(() => parseGrantTarget(grant('not-a-url'))).toThrow(
      /not beneath the Space/
    )
    expect(() =>
      parseGrantTarget(grant(`${SPACE_URL}notes`, 'urn:not-a-url'))
    ).toThrow(/not rooted in a Space/)
  })

  it('takes the Space URL the chain root names as given, in any form', () => {
    // Under a mounted server root, at an origin root, and a single fixed
    // Space at a sub-path with no base server URL: a Space has no URL shape
    // of its own, so none of these is refused.
    expect(
      parseGrantTarget(
        grant('https://h/pws/space/s1/notes', 'https://h/pws/space/s1/')
      )
    ).toEqual({ spaceUrl: 'https://h/pws/space/s1/', collectionId: 'notes' })
    expect(
      parseGrantTarget(
        grant('https://alice.example/notes', 'https://alice.example/')
      )
    ).toEqual({ spaceUrl: 'https://alice.example/', collectionId: 'notes' })
    expect(
      parseGrantTarget(
        grant('https://alice.example/pws/notes', 'https://alice.example/pws/')
      )
    ).toEqual({ spaceUrl: 'https://alice.example/pws/', collectionId: 'notes' })
  })
})

describe('parseGrants', () => {
  it('routes per-collection grants and derives one Space', () => {
    const parsed = parseGrants([
      grant(`${SPACE_URL}action-items`),
      grant(`${SPACE_URL}projects`),
      grant(`${SPACE_URL}current-focus`)
    ])
    expect(parsed.spaceUrl).toBe(SPACE_URL)
    expect(Object.keys(parsed.byCollectionId).sort()).toEqual([
      'action-items',
      'current-focus',
      'projects'
    ])
    expect(parsed.byCollectionId['action-items']?.invocationTarget).toBe(
      `${SPACE_URL}action-items`
    )
  })

  it('rejects a space-scoped grant (no collection segment)', () => {
    expect(() =>
      parseGrants([grant(SPACE_URL), grant(`${SPACE_URL}goals`)])
    ).toThrow(/not collection-scoped/)
  })

  it('rejects grants spanning two Spaces', () => {
    const other = 'http://localhost:3002/space/def/'
    expect(() =>
      parseGrants([
        grant(`${SPACE_URL}goals`),
        grant(`${other}projects`, other)
      ])
    ).toThrow(/two Spaces/)
    const elsewhere = 'http://localhost:4000/space/abc/'
    expect(() =>
      parseGrants([
        grant(`${SPACE_URL}goals`),
        grant(`${elsewhere}projects`, elsewhere)
      ])
    ).toThrow(/two Spaces/)
  })

  it('rejects an empty grant set', () => {
    expect(() => parseGrants([])).toThrow()
  })
})
