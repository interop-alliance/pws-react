/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Browser smoke test: the library imports and evaluates in a real Chromium
 * (via the Vite dev server transforming the TS source on the fly), and its key
 * public exports are present and of the right shape. This catches
 * browser-only breakages (bad import specifiers, top-level DOM/crypto access)
 * that the Node unit tests miss.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Navigates to the test page and runs the given evaluate step, retrying when
 * Vite's dep optimizer discovers a dependency mid-import on a cold cache and
 * triggers a full page reload, destroying the evaluate's execution context.
 *
 * @param options {object}
 * @param options.page {Page}
 * @param options.evaluate {Function}
 * @returns {Promise<ResultType>} The evaluate step's result.
 */
async function withOptimizerReloadRetry<ResultType>({
  page,
  evaluate
}: {
  page: Page
  evaluate: () => Promise<ResultType>
}): Promise<ResultType> {
  const maxAttempts = 3
  for (let attempt = 1; ; attempt++) {
    await page.goto('/test/index.html')
    try {
      return await evaluate()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (
        attempt < maxAttempts &&
        message.includes('Execution context was destroyed')
      ) {
        continue
      }
      throw err
    }
  }
}

test('the core entry imports and exposes its public API in the browser', async ({
  page
}) => {
  const exports = await withOptimizerReloadRetry({
    page,
    evaluate: () =>
      page.evaluate(async entry => {
        // The path is passed as an argument (not a literal) so the TypeScript
        // checker does not try to resolve the Vite-served source URL at build
        // time.
        const mod = await import(entry)
        return {
          createAuthStore: typeof mod.createAuthStore,
          PwsSessionProvider: typeof mod.PwsSessionProvider,
          useSession: typeof mod.useSession,
          loginWithWallet: typeof mod.loginWithWallet,
          SyncController: typeof mod.SyncController,
          startPwsSync: typeof mod.startPwsSync,
          parseGrants: typeof mod.parseGrants,
          createDocumentLoader: typeof mod.createDocumentLoader,
          DEFAULT_DB_NAME: mod.DEFAULT_DB_NAME
        }
      }, '/src/index.ts')
  })

  expect(exports.createAuthStore).toBe('function')
  expect(exports.PwsSessionProvider).toBe('function')
  expect(exports.useSession).toBe('function')
  expect(exports.loginWithWallet).toBe('function')
  expect(exports.SyncController).toBe('function')
  expect(exports.startPwsSync).toBe('function')
  expect(exports.parseGrants).toBe('function')
  expect(exports.createDocumentLoader).toBe('function')
  expect(exports.DEFAULT_DB_NAME).toBe('pws-react')
})

test('the mui subpath imports and exposes its components', async ({ page }) => {
  const exports = await withOptimizerReloadRetry({
    page,
    evaluate: () =>
      page.evaluate(async entry => {
        const mod = await import(entry)
        return {
          ProtectedRoute: typeof mod.ProtectedRoute,
          ReconnectBanner: typeof mod.ReconnectBanner,
          SyncStatusChip: typeof mod.SyncStatusChip,
          LogoutDialog: typeof mod.LogoutDialog,
          ClearDataDialog: typeof mod.ClearDataDialog
        }
      }, '/src/mui/index.ts')
  })

  expect(exports.ProtectedRoute).toBe('function')
  expect(exports.ReconnectBanner).toBe('function')
  expect(exports.SyncStatusChip).toBe('function')
  expect(exports.LogoutDialog).toBe('function')
  expect(exports.ClearDataDialog).toBe('function')
})
