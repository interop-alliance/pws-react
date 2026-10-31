/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Component tests (jsdom) for the `ProtectedRoute` onboarding switch. The store
 * is created directly and provided through `PwsSessionContext` (bypassing
 * `PwsSessionProvider`, so no `boot()` runs), and its status is driven with
 * `setState`; no IndexedDB / PWS server is touched. Covers:
 *
 * - `local-first` renders the routed outlet while `local`;
 * - `login-gated` redirects `local` to the login path;
 * - both show the boot spinner while `boot`;
 * - the fatal `bootstrap-error` alert is scoped to a boot/storage failure
 *   (`boot` + `error`) and never blanks a local-first app on a later
 *   (login-style) error.
 *
 * These live as Vitest component tests rather than Playwright: the repo's
 * browser harness (`test/index.html`) only imports modules to check export
 * shapes and has no React-mount plumbing, which would be disproportionate to add
 * for a routing switch that jsdom + react-router's `MemoryRouter` exercises
 * directly.
 *
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { PwsSessionContext } from '../../src/react/PwsSessionProvider.js'
import {
  createAuthStore,
  type SessionStatus,
  type PwsAuthStore
} from '../../src/session/authStore.js'
import { ProtectedRoute } from '../../src/mui/ProtectedRoute.js'
import type { StoreRegistry, PwsAppConfig } from '../../src/config.js'

const registry: StoreRegistry = {}

function baseConfig(onboarding: 'local-first' | 'login-gated'): PwsAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    onboarding,
    collections: [{ key: 'notes', id: 'notes' }],
    appUrl: 'http://localhost:5173/test-app',
    dbName: `pws-react-${Math.random().toString(36).slice(2)}`
  }
}

const liveStores: PwsAuthStore[] = []

function renderRoute({
  onboarding,
  status,
  error = null
}: {
  onboarding: 'local-first' | 'login-gated'
  status: SessionStatus
  error?: string | null
}): void {
  const store = createAuthStore({ config: baseConfig(onboarding), registry })
  liveStores.push(store)
  store.setState({ status, error })
  render(
    <PwsSessionContext.Provider value={store}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<div data-testid="app-outlet">app</div>} />
          </Route>
          <Route
            path="/login"
            element={<div data-testid="login-page">login</div>}
          />
        </Routes>
      </MemoryRouter>
    </PwsSessionContext.Provider>
  )
}

afterEach(async () => {
  cleanup()
  while (liveStores.length > 0) {
    await liveStores.pop()!.getState().destroy()
  }
})

describe('ProtectedRoute onboarding switch', () => {
  it('renders the outlet in local-first while local', () => {
    renderRoute({ onboarding: 'local-first', status: 'local' })
    expect(screen.getByTestId('app-outlet')).toBeDefined()
    expect(screen.queryByTestId('login-page')).toBeNull()
  })

  it('redirects to the login path in login-gated while local', () => {
    renderRoute({ onboarding: 'login-gated', status: 'local' })
    expect(screen.getByTestId('login-page')).toBeDefined()
    expect(screen.queryByTestId('app-outlet')).toBeNull()
  })

  it('renders the outlet in login-gated once connected', () => {
    renderRoute({ onboarding: 'login-gated', status: 'connected' })
    expect(screen.getByTestId('app-outlet')).toBeDefined()
  })

  it('shows the boot spinner while booting (either mode)', () => {
    renderRoute({ onboarding: 'local-first', status: 'boot' })
    expect(screen.getByTestId('bootstrap-loading')).toBeDefined()
    expect(screen.queryByTestId('app-outlet')).toBeNull()
  })
})

describe('ProtectedRoute fatal-error scoping', () => {
  it('shows the fatal alert only on a boot/storage failure (boot + error)', () => {
    renderRoute({
      onboarding: 'local-first',
      status: 'boot',
      error: 'disk is on fire'
    })
    expect(screen.getByTestId('bootstrap-error')).toBeDefined()
    expect(screen.queryByTestId('bootstrap-loading')).toBeNull()
  })

  it('never blanks a local-first app on a later (login-style) error', () => {
    renderRoute({
      onboarding: 'local-first',
      status: 'local',
      error: 'Login failed: user cancelled'
    })
    expect(screen.getByTestId('app-outlet')).toBeDefined()
    expect(screen.queryByTestId('bootstrap-error')).toBeNull()
  })
})
