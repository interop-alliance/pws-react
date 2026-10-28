/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The tier-1 "one sandbox document" facade: `defineDocumentApp` builds the
 * whole was-react wiring (config, store registry, entity store) for an app
 * whose entire model is a single key-value document -- an Excalidraw-style
 * editor, a browser-game save file -- and returns a typed `useAppDocument` hook
 * over it. The app never sees `createEntityStore`, grants parsing, or sync
 * internals: it renders `doc`, calls `update`, and optionally offers file
 * export/import and a "Save to Web Spaces" connect button.
 *
 * The facade is a degenerate entity store: one collection (the app-named
 * sandbox collection) holding one logical document under a fixed id. The
 * stored row wraps the app's data (`{ id, updatedAt, writerId, data }`) so app
 * fields can never collide with the LWW fields the sync layer requires; the
 * entity store's write verbs stamp those fields on every write. Hydration
 * goes through `LocalStore.hydrateSingleton`, which LWW-reconciles the
 * duplicate envelope rows two devices can mint for the same logical document.
 *
 * `connect()` is plain `login()`: the config registers exactly one collection,
 * so the wallet consent screen shows a single legible request, and the default
 * adopt-on-login merge carries the local document into the granted collection.
 *
 * Multi-document ("slot") variants are deliberately not supported yet:
 * `hydrateSingleton` reconciles ALL rows of the collection down to one winner,
 * so named slots need a grouped per-id reconciler first. An app that has
 * outgrown one document should move to `createEntityStore`.
 */
import type {
  StoreRegistry,
  WasAppConfig,
  WasExpiryConfig,
  WasSyncConfig
} from '../config.js'
import type { SessionStatus } from '../session/authStore.js'
import { createEntityStore } from '../storage/entityStore.js'
import { requireStore } from '../storage/storageManager.js'
import type { SyncRollup } from '../storage/syncStatusStore.js'
import { useLogin, useLogout, useSyncStatus } from './hooks.js'

/**
 * The localStore / RxDB collection key the facade's one collection uses.
 */
export const DOCUMENT_COLLECTION_KEY = 'document'

/**
 * The fixed logical id of the singleton document row.
 */
const DOCUMENT_ID = 'main'

/**
 * The `format` tag stamped into (and required of) export files.
 */
export const DOCUMENT_EXPORT_FORMAT = 'was-document/v1'

/**
 * The at-rest row shape: the app's document wrapped beside the LWW fields the
 * sync layer resolves conflicts on, so app fields can never collide with them.
 */
interface StoredDocument<T> {
  id: string
  updatedAt: string
  writerId: string
  data: T
}

/**
 * Everything `defineDocumentApp` hands back: the config + registry to spread
 * into `WasSessionProvider`, and the typed document hook for components.
 */
export interface DocumentApp<T extends object> {
  /**
   * The app-wide was-react configuration (one sandbox collection,
   * local-first onboarding). Pass to `WasSessionProvider`.
   */
  config: WasAppConfig
  /**
   * The singleton-document store registry. Pass to `WasSessionProvider`.
   */
  registry: StoreRegistry
  /**
   * The tier-1 document hook. Usable in any component below the provider.
   */
  useAppDocument: () => {
    /**
     * The document: `undefined` during boot, then the stored value or the
     * configured `initial` when nothing has been written yet.
     */
    doc: T | undefined
    /**
     * Merge a partial patch (or apply an updater function) onto the current
     * document and persist it (the write verb stamps the LWW fields). The write
     * lands in the encrypted local replica first and replicates in the
     * background when connected. Each call reads the document as the previous
     * call left it, whether or not that call was awaited, so a burst of
     * unawaited updates composes in call order; a call whose persist rejects
     * leaves the document as it was before it.
     */
    update: (patch: Partial<T> | ((prev: T) => T)) => Promise<void>
    /**
     * The session state: `'local'` (no wallet, fully usable) is home for a
     * tier-1 app; `'connected'`/`'reconnect'` mirror the session machine.
     */
    status: SessionStatus
    /**
     * The aggregate replication rollup (`'offline'` until connected).
     */
    sync: SyncRollup
    /**
     * Serialize the current document to a downloadable JSON blob. An update
     * issued before the call is included, awaited or not.
     */
    exportFile: () => Promise<Blob>
    /**
     * Replace the document with one previously exported via `exportFile`.
     * Rejects when the file is not a `was-document/v1` export.
     */
    importFile: (file: File) => Promise<void>
    /**
     * "Save to Web Spaces": run the CHAPI wallet login, requesting a grant for
     * exactly this app's one sandbox collection, then adopt (merge) the local
     * document into it and start background sync. Resolves with `{ firstRun }`
     * on success (`firstRun` marks a brand-new app key, for a first-connect
     * confirmation), `null` when the user cancels a wallet popup, and REJECTS
     * on a genuine failure (the message is also mirrored into `error`).
     */
    connect: () => Promise<{ firstRun: boolean } | null>
    /**
     * Detach the wallet session (data already synced stays on the server and
     * in the kept device replica) and land back in a fresh `local` state.
     */
    disconnect: () => Promise<void>
    /**
     * True while the CHAPI login is in flight.
     */
    connecting: boolean
    /**
     * The last session error (a failed login or boot), or `null`.
     */
    error: string | null
  }
}

/**
 * Builds the complete wiring for a one-document app: a `WasAppConfig` with a
 * single sandbox collection and local-first onboarding, the singleton-document
 * store registry, and the typed `useAppDocument` hook bound to both.
 *
 * @param options {object}
 * @param options.appName {string}   human-readable name (consent reason lines)
 * @param options.appOrigin {string}   this app's own web origin
 * @param options.appUrl {string}   this app's canonical URL (absolute,
 *   query- and fragment-less, same-origin with `appOrigin`)
 * @param [options.mediatorBase] {string}   CHAPI mediator base URL
 * @param options.document {object}   `collectionId` (the WAS sandbox
 *   collection id) and `initial` (the document value before the first write)
 * @param [options.dbName] {string}   local database base name
 * @param [options.storageKeyPrefix] {string}   localStorage key prefix
 * @param [options.sync] {WasSyncConfig}   replication tuning
 * @param [options.expiry] {WasExpiryConfig}   near-expiry warning tuning
 * @returns {DocumentApp<T>}
 */
export function defineDocumentApp<T extends object>({
  appName,
  appOrigin,
  appUrl,
  mediatorBase,
  document,
  dbName,
  storageKeyPrefix,
  sync,
  expiry
}: {
  appName: string
  appOrigin: string
  appUrl: string
  mediatorBase?: string
  document: { collectionId: string; initial: T }
  dbName?: string
  storageKeyPrefix?: string
  sync?: WasSyncConfig
  expiry?: WasExpiryConfig
}): DocumentApp<T> {
  const { collectionId, initial } = document
  const docStore = createEntityStore<StoredDocument<T>>(DOCUMENT_COLLECTION_KEY)

  const config: WasAppConfig = {
    appName,
    appOrigin,
    appUrl,
    ...(mediatorBase !== undefined && { mediatorBase }),
    collections: [{ key: DOCUMENT_COLLECTION_KEY, id: collectionId }],
    onboarding: 'local-first',
    ...(dbName !== undefined && { dbName }),
    ...(storageKeyPrefix !== undefined && { storageKeyPrefix }),
    ...(sync !== undefined && { sync }),
    ...(expiry !== undefined && { expiry })
  }

  const registry: StoreRegistry = {
    [DOCUMENT_COLLECTION_KEY]: {
      // Whole-collection hydrate doubles as the duplicate-singleton
      // reconciler: keep the LWW winner, tombstone the losers.
      hydrate: async () => {
        const winner = await requireStore().hydrateSingleton<StoredDocument<T>>(
          DOCUMENT_COLLECTION_KEY
        )
        docStore.getState().replaceAll(winner ? [winner] : [])
      },
      upsert: doc => docStore.getState().patch(doc as StoredDocument<T>),
      drop: uuid => docStore.getState().drop(uuid),
      clear: () => docStore.getState().replaceAll([])
    }
  }

  /**
   * The current document data -- `initial` until the first write lands. The
   * imperative twin of the hook's reactive selector.
   *
   * @returns {T}
   */
  function currentData(): T {
    return docStore.getState().byId.get(DOCUMENT_ID)?.data ?? initial
  }

  /**
   * Merges the patch (or applies the updater) and persists the result under
   * the fixed document id; the entity store's `upsert` stamps the LWW fields
   * and owns the ordering of unawaited calls.
   *
   * @param patch {Partial<T> | ((prev: T) => T)}
   * @returns {Promise<void>}
   */
  async function update(patch: Partial<T> | ((prev: T) => T)): Promise<void> {
    const prev = currentData()
    const data =
      typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }
    await docStore.getState().upsert({ id: DOCUMENT_ID, data })
  }

  /**
   * Serializes the current document (or `initial` before any write) into a
   * tagged, versioned JSON blob.
   *
   * @returns {Promise<Blob>}
   */
  async function exportFile(): Promise<Blob> {
    const body = {
      format: DOCUMENT_EXPORT_FORMAT,
      app: appName,
      exportedAt: new Date().toISOString(),
      document: currentData()
    }
    return new Blob([JSON.stringify(body, null, 2)], {
      type: 'application/json'
    })
  }

  /**
   * Parses an export file and replaces the document with its contents (a
   * persisted write with fresh LWW stamps).
   *
   * @param file {File}
   * @returns {Promise<void>}
   */
  async function importFile(file: File): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      throw new Error('Not a valid export file (unreadable JSON).')
    }
    const record = parsed as { format?: string; document?: T } | null
    if (
      record === null ||
      record.format !== DOCUMENT_EXPORT_FORMAT ||
      typeof record.document !== 'object' ||
      record.document === null
    ) {
      throw new Error(
        `Not a "${DOCUMENT_EXPORT_FORMAT}" export file; nothing imported.`
      )
    }
    const imported = record.document
    await update(() => imported)
  }

  function useAppDocument(): ReturnType<DocumentApp<T>['useAppDocument']> {
    const held = docStore(state => state.byId.get(DOCUMENT_ID))
    const { login, authenticating, status, error } = useLogin()
    const { state: syncState } = useSyncStatus()
    const logout = useLogout()
    // Hydration completes before the machine leaves `boot`, so "left boot" is
    // exactly "the stored document (or its absence) is now known".
    const doc = status === 'boot' ? undefined : (held?.data ?? initial)
    return {
      doc,
      update,
      status,
      sync: syncState,
      exportFile,
      importFile,
      connect: () => login(),
      disconnect: () => logout(),
      connecting: authenticating,
      error
    }
  }

  return { config, registry, useAppDocument }
}
