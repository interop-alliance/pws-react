/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, expect, it } from 'vitest'
import {
  validateCollections,
  validateSharedCollections,
  type SharedCollectionConfig,
  type PwsCollectionConfig
} from './config.js'

describe('validateCollections', () => {
  it('accepts an empty registry and default/explicit visibilities', () => {
    expect(() => validateCollections([])).not.toThrow()
    expect(() =>
      validateCollections([
        { key: 'notes', id: 'notes' },
        { key: 'drafts', id: 'drafts', visibility: 'private' },
        { key: 'posts', id: 'microblog-posts', visibility: 'public' }
      ])
    ).not.toThrow()
  })

  it('accepts the same PWS id under two keys with matching visibility', () => {
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared', visibility: 'public' },
        { key: 'b', id: 'shared', visibility: 'public' }
      ])
    ).not.toThrow()
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared' },
        { key: 'b', id: 'shared', visibility: 'private' }
      ])
    ).not.toThrow()
  })

  it('rejects an unknown visibility value (fail-closed)', () => {
    const collections = [
      { key: 'posts', id: 'posts', visibility: 'unlisted' }
    ] as unknown as PwsCollectionConfig[]
    expect(() => validateCollections(collections)).toThrow(/unknown visibility/)
  })

  it('accepts equality indexes on a public collection', () => {
    expect(() =>
      validateCollections([
        {
          key: 'posts',
          id: 'microblog-posts',
          visibility: 'public',
          indexes: ['author', 'inReplyTo']
        }
      ])
    ).not.toThrow()
  })

  it('accepts blinded-index attributes on a private collection', () => {
    expect(() =>
      validateCollections([{ key: 'notes', id: 'notes', indexes: ['author'] }])
    ).not.toThrow()
  })

  it('rejects empty and duplicate index attribute names', () => {
    expect(() =>
      validateCollections([
        { key: 'posts', id: 'posts', visibility: 'public', indexes: [''] }
      ])
    ).toThrow(/empty index attribute/)
    expect(() =>
      validateCollections([
        {
          key: 'posts',
          id: 'posts',
          visibility: 'public',
          indexes: ['author', 'author']
        }
      ])
    ).toThrow(/twice/)
    // The same shape rules apply on a private (blinded-index) collection.
    expect(() =>
      validateCollections([{ key: 'notes', id: 'notes', indexes: [''] }])
    ).toThrow(/empty index attribute/)
    expect(() =>
      validateCollections([
        { key: 'notes', id: 'notes', indexes: ['author', 'author'] }
      ])
    ).toThrow(/twice/)
  })

  it('rejects diverging index declarations for the same private PWS id', () => {
    expect(() =>
      validateCollections([
        { key: 'a', id: 'notes', indexes: ['author'] },
        { key: 'b', id: 'notes', indexes: ['tag'] }
      ])
    ).toThrow(/diverging index/)
  })

  it('rejects diverging index declarations for the same PWS id', () => {
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared', visibility: 'public', indexes: ['author'] },
        { key: 'b', id: 'shared', visibility: 'public', indexes: ['tag'] }
      ])
    ).toThrow(/diverging index/)
    // Identical declarations (in any order) are fine.
    expect(() =>
      validateCollections([
        {
          key: 'a',
          id: 'shared',
          visibility: 'public',
          indexes: ['author', 'tag']
        },
        {
          key: 'b',
          id: 'shared',
          visibility: 'public',
          indexes: ['tag', 'author']
        }
      ])
    ).not.toThrow()
  })

  it('rejects the same PWS id registered as both private and public', () => {
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared' },
        { key: 'b', id: 'shared', visibility: 'public' }
      ])
    ).toThrow(/encrypted and public/)
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared', visibility: 'public' },
        { key: 'b', id: 'shared', visibility: 'private' }
      ])
    ).toThrow(/encrypted and public/)
  })
})

describe('validateSharedCollections', () => {
  const OWNED: PwsCollectionConfig[] = [
    { key: 'notes', id: 'notes' },
    { key: 'posts', id: 'microblog-posts', visibility: 'public' }
  ]

  it('accepts an absent or disjoint shared registry', () => {
    expect(() =>
      validateSharedCollections({ collections: OWNED })
    ).not.toThrow()
    expect(() =>
      validateSharedCollections({
        collections: OWNED,
        sharedCollections: [
          { key: 'credentials', id: 'private-credentials' },
          { key: 'contacts', id: 'contacts' }
        ]
      })
    ).not.toThrow()
  })

  it('rejects an empty key or id', () => {
    expect(() =>
      validateSharedCollections({
        collections: OWNED,
        sharedCollections: [{ key: '', id: 'contacts' }]
      })
    ).toThrow(/empty "key"/)
    expect(() =>
      validateSharedCollections({
        collections: OWNED,
        sharedCollections: [{ key: 'contacts', id: '' }]
      })
    ).toThrow(/empty "id"/)
  })

  it('rejects a duplicate key or id', () => {
    expect(() =>
      validateSharedCollections({
        collections: OWNED,
        sharedCollections: [
          { key: 'contacts', id: 'contacts' },
          { key: 'contacts', id: 'contacts-history' }
        ]
      })
    ).toThrow(/key "contacts" is declared twice/)
    expect(() =>
      validateSharedCollections({
        collections: OWNED,
        sharedCollections: [
          { key: 'contacts', id: 'contacts' },
          { key: 'people', id: 'contacts' }
        ]
      })
    ).toThrow(/id "contacts" is declared twice/)
  })

  it('rejects a collection that is both app-owned and shared', () => {
    expect(() =>
      validateSharedCollections({
        collections: OWNED,
        sharedCollections: [{ key: 'notes', id: 'contacts' }]
      })
    ).toThrow(/also an app collection key/)
    expect(() =>
      validateSharedCollections({
        collections: OWNED,
        sharedCollections: [{ key: 'shared-notes', id: 'notes' }]
      })
    ).toThrow(/also an app collection id/)
  })

  it('rejects a non-string key (fail-closed)', () => {
    const sharedCollections = [
      { key: 7, id: 'contacts' }
    ] as unknown as SharedCollectionConfig[]
    expect(() =>
      validateSharedCollections({ collections: OWNED, sharedCollections })
    ).toThrow(/empty "key"/)
  })
})
