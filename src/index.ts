/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * `@interop/was-react`: build "Bring Your Own Everything" (BYOE) apps on Wallet
 * Attached Storage -- DID-Auth login via a CHAPI wallet, local-first encrypted
 * storage, and background sync to a WAS server.
 *
 * This is the core entry. The optional MUI + react-router components live at
 * `@interop/was-react/mui`; the Node-only dev-grant provisioner lives at
 * `@interop/was-react/dev`. Neither is re-exported here.
 *
 * It also exports the logging port -- `setLogger` and the `Logger` type -- so
 * an app can route this library's diagnostics into its own logger.
 */

// Configuration contract.
export {
  DEFAULT_DB_NAME,
  DEFAULT_STORAGE_KEY_PREFIX,
  DEFAULT_SYNC_POLL_MS,
  DEFAULT_EXPIRY_WARNING_MS,
  DEFAULT_EXPIRY_WATCH_MS,
  validateCollections,
  validateSharedCollections,
  type WasCollectionConfig,
  type SharedCollectionConfig,
  type WasSyncConfig,
  type WasExpiryConfig,
  type WasAppConfig,
  type StoreRegistryEntry,
  type StoreRegistry
} from './config.js'

// Grant parsing / topology routing.
export {
  parseInvocationTarget,
  parseGrants,
  type ParsedGrants
} from './grants.js'

// Identity: the seed-derived agents, including the identity key-agreement key
// every encrypted collection is read with.
export {
  deriveIdentity,
  DEFAULT_IDENTITY_HANDLE,
  type IdentityAgents
} from './identity/agents.js'
export {
  createDocumentLoader,
  type DocumentLoader
} from './identity/documentLoader.js'
export {
  createSeedStore,
  createDescriptorCache,
  type SeedStore
} from './identity/seedStore.js'
export {
  APP_KEY_CREDENTIAL_TYPE,
  APP_KEY_TYPE_ARRAY,
  issueSeedCredential,
  parseSeedCredential,
  findSeedCredential,
  bytesToBase64url,
  base64urlToBytes,
  type ParsedSeedCredential
} from './identity/seedCredential.js'
export {
  persistAppSession,
  restoreAppSession,
  clearAppSession,
  isExpired,
  isNearExpiry,
  earliestExpiry,
  type AppSessionRecord,
  type RestoredAppSession
} from './identity/appSession.js'

// Auth: CHAPI bridge, VPR construction, response verification, login flow.
export { DEFAULT_MEDIATOR_BASE, loadChapi, chapiGet } from './auth/chapi.js'
export {
  RW_ACTIONS,
  SHARED_ACTIONS,
  actionCeiling,
  newChallenge,
  buildAppConnectVpr,
  type GrantRequestCollection
} from './auth/loginRequest.js'
export {
  verifyLoginPresentation,
  grantsOf,
  checkGrants,
  type CheckedGrants
} from './auth/verifyResponse.js'
export {
  loginWithWallet,
  requestGrants,
  LoginCancelledError,
  WalletUnsupportedError,
  type LoginConfig,
  type LoginPhase,
  type LoginOutcome
} from './auth/loginFlow.js'
export type {
  IVPRDetails,
  IVPRQuery,
  IDIDAuthenticationQuery,
  IAppConnectQuery,
  IAppConnectCapabilityQuery,
  ICapabilityQueryDetail,
  IVerifiableCredential,
  IVerifiablePresentation,
  IZcap
} from './auth/walletRequestTypes.js'

// The RxDB-WAS replication driver lives in `@interop/was-sync` and is no
// longer re-exported here; import it from there (its root entry for the types,
// the schema, the conflict-handler seam and the writer-id mint, `./rxdb` for
// the handlers, the replication wiring and the controller core).

// Storage: local encrypted replica, the session-scoped storage context and
// the app-facing facades over the active one, entity stores, the delegated
// remote store, sync status, and the replication controller.
export { LocalStore } from './storage/localStore.js'
// The per-collection document cipher and the WAS sync port stay here: they
// bridge the driver to `@interop/was-client` and hold this library's key
// handling, which the driver never touches.
export {
  createDocCipher,
  createPlaintextDocCodec,
  createUnprovisionedDocCipher,
  type DocCipher
} from './storage/docCipher.js'
export { createWasSyncPort } from './storage/wasSyncPort.js'
// Re-exported beside `LocalStore` (with `deriveIdentity` and
// `createDescriptorCache` above) so a consumer handed the store directly is
// also handed everything needed to provision one under epoch-from-birth.
export { mintRecordEncryption } from '@interop/wallet-core/keyring'
export { StorageContext } from './storage/storageContext.js'
export {
  activateStorageContext,
  deactivateStorageContext,
  hasStorageContext,
  requireStorageContext,
  requireStore,
  hasStore,
  requireRemoteStore,
  hasRemoteStore,
  requireWriterId,
  stampLww
} from './storage/storageManager.js'
export { getWriterId, clearPersistedWriterId } from './storage/writerId.js'
export { createEntityStore, type EntityStore } from './storage/entityStore.js'
export {
  WasRemoteStore,
  type DeclarationResult,
  type EqualityQueryPage
} from './storage/wasRemoteStore.js'
export {
  SharedCollectionReader,
  SharedCollectionUnavailableError,
  SHARED_CHANGES_PAGE_SIZE,
  type SharedResource
} from './storage/sharedCollectionReader.js'
export {
  AudienceReader,
  AUDIENCE_CHANGES_PAGE_SIZE,
  type AudienceChange,
  type AudiencePull
} from './storage/audienceReader.js'
export { publicUrlFor } from './storage/publicUrl.js'
export {
  createSyncStatusStore,
  deriveSyncRollup,
  type SyncStatus,
  type SyncStatusStore
} from './storage/syncStatusStore.js'
export { isAuthError, SyncController } from './storage/syncController.js'
export { startWasSync, type WasSyncBootstrap } from './storage/wasSync.js'

// Session lifecycle: the session auth store factory (the four-state machine),
// and the wipe enumeration behind `clearLocalData`.
export {
  createAuthStore,
  executeLocalWipe,
  snapshotWipeTargets,
  type SessionStatus,
  type AuthState,
  type WasAuthStore,
  type LocalWipeReport,
  type WipeTargets
} from './session/index.js'

// React: the session provider + hooks.
export {
  WasSessionProvider,
  WasSessionContext,
  useAuthStore,
  useSession,
  useLogin,
  useLogout,
  useClearData,
  useHasLocalData,
  useReconnect,
  useSharedCollection,
  useSyncStatus,
  type SyncRollup,
  defineDocumentApp,
  DOCUMENT_COLLECTION_KEY,
  DOCUMENT_EXPORT_FORMAT,
  type DocumentApp
} from './react/index.js'

// The logging port: an app wires its own logger once at bootstrap, and this
// library's diagnostics ride it instead of the console fallback.
export { setLogger, type Logger } from './log.js'
