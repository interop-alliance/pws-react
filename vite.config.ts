import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The Playwright dev server serves an otherwise-empty test page and imports
  // the library dynamically from the test. Point the dep optimizer at the two
  // entry modules so their (large) dependency graph is pre-bundled at cold
  // start, rather than lazily on the first dynamic import -- lazy discovery
  // re-optimizes mid-request and fails the in-flight module fetch.
  optimizeDeps: {
    entries: ['src/index.ts', 'src/mui/index.ts'],
    // The replication driver arrives as a separate package now, and a linked
    // one is treated as source rather than a dependency, so name it explicitly
    // for the same reason: lazy discovery re-optimizes mid-request. The same
    // goes for the two `rxdb` entry points, which `LocalStore` reaches through
    // a dynamic import (so a replica-less app resolves the root without the
    // optional peer) and which the crawl of the entries above therefore does
    // not reach.
    include: [
      '@interop/was-sync/rxdb',
      'rxdb/plugins/core',
      'rxdb/plugins/storage-dexie'
    ]
  },
  // A linked `@interop/was-sync` checkout would carry its own `rxdb` in its
  // node_modules, so without this the driver and this library could each
  // hold a physical copy: two sets of RxDB prototypes, with the
  // leader-election plugin installed on only one of them. Installed from the
  // registry, `rxdb` is that package's optional peer and already resolves to
  // one copy here, so this entry is a harmless guard against a duplicate
  // copy rather than something a registry install depends on.
  resolve: {
    dedupe: ['rxdb', '@interop/was-client']
  },
  // A dedicated port (with strictPort so Vite fails loudly instead of
  // silently drifting to another port) keeps the Playwright suite from
  // accidentally talking to some other project's dev server on 5173.
  server: {
    port: 5183,
    strictPort: true
  },
  test: {
    include: ['test/node/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    // Default to node (crypto/IndexedDB tests); React hook/component tests
    // opt into jsdom per-file via `// @vitest-environment jsdom`.
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}']
    }
  }
})
