/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for this library's binding over `@interop/pws-sync`'s writer-id
 * mint: that it supplies {@link DEFAULT_STORAGE_KEY_PREFIX} and `localStorage`,
 * and that a clear touches only the prefix it was given. The mint's own
 * semantics (mint-once, the fresh-id-per-call answer from a storage that
 * throws) are the package's tests.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { clearPersistedWriterId, getWriterId } from './writerId.js'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../config.js'

beforeEach(() => {
  localStorage.clear()
})

describe('clearPersistedWriterId', () => {
  it('removes the persisted id so a later getWriterId mints a fresh one', () => {
    const first = getWriterId()
    clearPersistedWriterId()
    expect(
      localStorage.getItem(`${DEFAULT_STORAGE_KEY_PREFIX}writerId`)
    ).toBeNull()

    const second = getWriterId()
    expect(second).not.toBe(first)
  })

  it('only clears the configured prefix, leaving other prefixes intact', () => {
    getWriterId({ storageKeyPrefix: 'myapp:' })
    const defaulted = getWriterId()

    clearPersistedWriterId({ storageKeyPrefix: 'myapp:' })

    expect(localStorage.getItem('myapp:writerId')).toBeNull()
    expect(localStorage.getItem(`${DEFAULT_STORAGE_KEY_PREFIX}writerId`)).toBe(
      defaulted
    )
  })
})
