/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The session lifecycle layer: the session auth store factory (the four-state
 * `boot` | `local` | `connected` | `reconnect` machine).
 */
export {
  createAuthStore,
  type SessionStatus,
  type AuthState,
  type PwsAuthStore
} from './authStore.js'
export {
  executeLocalWipe,
  snapshotWipeTargets,
  type LocalWipeReport,
  type WipeTargets
} from './localWipe.js'
