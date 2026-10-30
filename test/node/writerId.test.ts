/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the per-install LWW writer id wiring: `getWriterId` persists
 * under the configured `storageKeyPrefix`, and `createAuthStore` resolves the
 * id once from `PwsAppConfig.storageKeyPrefix` and exposes it on the session
 * state -- the migration affordance the config documents (a prior install's
 * prefixed id is preserved) -- and installs it on the session's storage
 * context, which the write verbs and the adoption repair stamp from.
 *
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { requireWriterId } from '../../src/storage/storageManager.js'
import { getWriterId } from '../../src/storage/writerId.js'
import { createAuthStore } from '../../src/session/authStore.js'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../../src/config.js'
import type { PwsAppConfig } from '../../src/config.js'

function baseConfig(): PwsAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    collections: [{ key: 'notes', id: 'notes' }],
    appUrl: 'http://localhost:5173/test-app'
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('getWriterId', () => {
  it('mints once and stays stable under the default prefix', () => {
    const first = getWriterId()
    expect(first.length).toBeGreaterThan(0)
    expect(getWriterId()).toBe(first)
    expect(localStorage.getItem(`${DEFAULT_STORAGE_KEY_PREFIX}writerId`)).toBe(
      first
    )
  })

  it('reads an existing id persisted under a custom prefix', () => {
    localStorage.setItem('myapp:writerId', 'existing-install-id')
    expect(getWriterId({ storageKeyPrefix: 'myapp:' })).toBe(
      'existing-install-id'
    )
  })

  it('keeps ids under different prefixes independent', () => {
    const defaulted = getWriterId()
    const prefixed = getWriterId({ storageKeyPrefix: 'myapp:' })
    expect(prefixed).not.toBe(defaulted)
    expect(getWriterId({ storageKeyPrefix: 'myapp:' })).toBe(prefixed)
  })
})

describe('createAuthStore writerId resolution', () => {
  it('honors the configured storageKeyPrefix (the migration affordance)', () => {
    localStorage.setItem('myapp:writerId', 'existing-install-id')
    const store = createAuthStore({
      config: { ...baseConfig(), storageKeyPrefix: 'myapp:' },
      registry: {}
    })
    expect(store.getState().writerId).toBe('existing-install-id')
    // The same value is installed on the active storage context the write
    // verbs stamp from, before any replica opens.
    expect(requireWriterId()).toBe('existing-install-id')
  })

  it('resolves under the default prefix when none is configured', () => {
    const store = createAuthStore({ config: baseConfig(), registry: {} })
    expect(store.getState().writerId).toBe(getWriterId())
  })
})
