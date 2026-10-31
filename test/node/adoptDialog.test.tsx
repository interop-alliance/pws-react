/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Component tests (jsdom) for `AdoptDialog`. The store is created directly and
 * provided through `PwsSessionContext` (no `boot()` runs), and its `login`
 * action is replaced with a stub, so no wallet, IndexedDB, or PWS server is
 * touched. Covers:
 *
 * - each choice closes the dialog and runs `login` with its `adopt` value;
 * - a `login` that rejects (the store records the error on `useLogin().error`
 *   and rethrows) does not escape the dialog as an unhandled rejection.
 *
 * The `login` stub is a plain function rather than a `vi.fn()`: Vitest's mock
 * subscribes to a returned promise to record its settled result, which marks a
 * rejection handled and would hide exactly the escape the last test watches
 * for.
 *
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PwsSessionContext } from '../../src/react/PwsSessionProvider.js'
import {
  createAuthStore,
  type AuthState,
  type PwsAuthStore
} from '../../src/session/authStore.js'
import { AdoptDialog } from '../../src/mui/AdoptDialog.js'
import type { PwsAppConfig } from '../../src/config.js'

const config: PwsAppConfig = {
  appName: 'Test App',
  appOrigin: 'http://localhost:5173',
  collections: [{ key: 'notes', id: 'notes' }],
  appUrl: 'http://localhost:5173/test-app',
  dbName: `pws-react-${Math.random().toString(36).slice(2)}`
}

const liveStores: PwsAuthStore[] = []

function renderDialog(outcome: 'resolve' | 'reject'): {
  onClose: ReturnType<typeof vi.fn>
  calls: Array<Parameters<AuthState['login']>[0]>
} {
  const calls: Array<Parameters<AuthState['login']>[0]> = []
  const login: AuthState['login'] = options => {
    calls.push(options)
    if (outcome === 'reject') {
      return Promise.reject(new Error('wallet unsupported'))
    }
    return Promise.resolve({ firstRun: false })
  }
  const store = createAuthStore({ config, registry: {} })
  liveStores.push(store)
  store.setState({ login })
  const onClose = vi.fn()
  render(
    <PwsSessionContext.Provider value={store}>
      <AdoptDialog open onClose={onClose} />
    </PwsSessionContext.Provider>
  )
  return { onClose, calls }
}

afterEach(async () => {
  cleanup()
  for (const store of liveStores.splice(0)) {
    await store.getState().destroy()
  }
})

describe('AdoptDialog', () => {
  it('closes and logs in with the chosen adopt mode', () => {
    const { onClose, calls } = renderDialog('resolve')
    fireEvent.click(screen.getByTestId('adopt-merge'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([{ adopt: 'merge' }])
  })

  it('passes adopt: leave for "Set it aside"', () => {
    const { calls } = renderDialog('resolve')
    fireEvent.click(screen.getByTestId('adopt-leave'))
    expect(calls).toEqual([{ adopt: 'leave' }])
  })

  it('does not let a rejected login escape as an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { onClose, calls } = renderDialog('reject')
      fireEvent.click(screen.getByTestId('adopt-merge'))
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(calls).toEqual([{ adopt: 'merge' }])
      // Let the rejection settle and the unhandledRejection hook fire.
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
