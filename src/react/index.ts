/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The React layer: the session provider plus the hooks over the bound store.
 * Framework-only (no MUI / router); the optional MUI components live under the
 * `./mui` subpath.
 */
export { PwsSessionProvider, PwsSessionContext } from './PwsSessionProvider.js'
export {
  useAuthStore,
  useSession,
  useLogin,
  useLogout,
  useClearData,
  useHasLocalData,
  useReconnect,
  useSharedCollection,
  useSyncStatus,
  type SyncRollup
} from './hooks.js'
export {
  defineDocumentApp,
  DOCUMENT_COLLECTION_KEY,
  DOCUMENT_EXPORT_FORMAT,
  type DocumentApp
} from './documentApp.js'
