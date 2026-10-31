# @interop/pws-react Changelog

## 0.33.0 - 2026-10-30

### Changed

- Breaking: the client is now `@interop/pws-client` 0.105.0 (renamed from
  `@interop/was-client`). The store's `was` member and the `was` option of the
  sync port factory are now `pws`, and the client's errors surface under their
  `Pws*` names (`PwsServerError`, `PwsSyncAuthError`, `PwsSyncConflictError`).
- Breaking: this package's `Was*` exports are renamed to `Pws*`: `PwsAppConfig`,
  `PwsCollectionConfig`, `PwsSyncConfig`, `PwsExpiryConfig`, `PwsRemoteStore`,
  `PwsAuthStore`, `PwsSessionProvider`, `PwsSessionContext`, `PwsSyncBootstrap`,
  `startPwsSync`, and `createPwsSyncPort`.
- Breaking: the package is renamed from `@interop/was-react` to
  `@interop/pws-react`, including its `./mui` and `./dev` entries.
- Breaking: the storage defaults derived from the package name change with it.
  `DEFAULT_DB_NAME` is `pws-react` and `DEFAULT_STORAGE_KEY_PREFIX` is
  `pws-react:`. An app on these defaults opens a fresh replica and mints a new
  `writerId`. There is no migration. `clearLocalData()` does not reach anything
  stored under the old defaults, including the wallet seed in
  `was-react-session`, so it stays on the browser until removed by hand.
- `DEFAULT_IDENTITY_HANDLE` is `pws-react`. The handle is cosmetic and does not
  affect keys or the derived DID.
- The console fallback logger's prefix is `[pws-react]` in place of
  `[was-react]`.
- Breaking: the Playwright CHAPI bridge globals are renamed to
  `__PWS_REACT_E2E_CHAPI__`, `__PWS_REACT_E2E_CHAPI_REQUESTS__`, and
  `__PWS_REACT_E2E_CHAPI_RESPONSES__`.
- Breaking: `defineDocumentApp` export files are tagged `pws-document/v1` in
  place of `was-document/v1`, and a file carrying the old tag is refused on
  import.
- Breaking: encrypted envelopes bind the `pws` JWE protected-header parameter in
  place of `was`, with no fallback. Envelopes written by earlier versions no
  longer decrypt, locally or from a server. An app with its own `dbName` reopens
  its old replica, and a private replica holding such rows fails hydration with
  `EncryptionError`: a connected session lands `local` with `error`, and an
  anonymous one stays on `boot` with `error`. There is no migration. Only
  `clearLocalData()` recovers such a replica, and a Space sealed under `was` has
  to be re-provisioned.
- Breaking: the replication driver is now `@interop/pws-sync` 0.13.0 (renamed
  from `@interop/was-sync`).
- `@interop/wallet-core` is now 0.113.0, which is on `@interop/pws-client` too,
  so a wallet and this library read each other's envelopes.
- The in-process test server dependency is now `@interop/web-spaces-server`
  0.45.0 (renamed from `was-teaching-server`).

### Fixed

- `SharedCollectionReader` no longer reports an envelope format the client does
  not admit as an expected legacy resource. `get()` rethrows the
  `EncryptionError`. A listing skips the resource at `error` level and rejects
  with that error when it decoded nothing, rather than answering `[]`.

## 0.32.0 - 2026-10-29

### Changed

- Breaking: a grant's Space is read off its delegation chain's root
  (was-client's `spaceUrlOf`), and its `invocationTarget` is classified beneath
  that Space URL. `ParsedGrants` carries `spaceUrl` in place of `baseUrl` and
  `spaceId`; the two "grants span two servers / two spaces" checks collapse into
  one on the Space URL. `parseInvocationTarget(target)` is replaced by
  `parseGrantTarget(zcap)`, which returns `{ spaceUrl, collectionId }`. The
  Space URL the root names is taken as given, in any form (a single fixed Space
  may live at any URL). A grant whose chain starts at no Space root capability
  is refused, as this module's own grant error with was-client's
  `ValidationError` as `cause`.
- `AudienceReader.replaceCapability` refuses a zcap whose chain roots in another
  Space, and changes nothing on the reader until every check has passed.
- Breaking: `WasRemoteStore` and `AudienceReader` build their client with
  `WasClient.forSpace({ spaceUrl })`: a grants-only app holds a Space URL and
  nothing above it. `WasRemoteStore.spaceUrl` replaces `spaceId`, and
  `AudienceReader.spaceUrl` replaces `serverUrl`.
- Breaking: `resolveSpaceOwner`, `createSpaceTrust`, and `createWasSyncPort`
  take `spaceUrl` in place of `baseUrl` / `spaceId`.
- Breaking: the persisted session record (`AppSessionRecord`) carries `spaceUrl`
  in place of `baseUrl` and `spaceId`. A record in the old shape fails the
  structural check and the reload lands in `local`; the next login re-persists
  it.
- Breaking: `provisionDevGrants` takes `baseServerUrl` (the server's base, e.g.
  `http://localhost:3002/`) in place of `serverUrl` (the Spaces Repository URL),
  builds the Space URL with `was.space(id).url`, and delegates each grant on a
  target built beneath it.
- The sync controller fills was-sync's port with `spaceUrl`. was-sync's default
  replication identifier changed with it, so every replica re-pulls its
  Collection from the beginning once.
- `@interop/was-client` `^0.100.1`, `@interop/wallet-core` `^0.109.0`,
  `@interop/was-sync` `^0.11.0`, `@interop/did-method-webvh` `^5.18.0`.

## 0.31.0 - 2026-10-29

### Changed

- `restoreAppSession` is removed from the root entry and `peekAppSession` is
  exported in its place: the one reader of the persisted session, which never
  wipes anything and leaves the expiry to the caller (`isExpired`).
- `RestoredAppSession` is renamed `AppSession` (the `persistAppSession` input:
  the record plus the seed).
- `snapshotWipeTargets` takes `sessionStoreDbName` and `anonStoreDbName`, and
  `SeedStore` carries the `dbName` it is bound to, so a wipe deletes an injected
  session store by its own name instead of assuming `<dbName>-session`.
- `WipeTargets` carries `sweepDbName` in place of `idbNamePrefixes`. The sweep
  no longer matches a broadcast-channel store: `LocalStore.removeDatabase`
  removes single-instance, as `init` opens, so RxDB opens no channel beside a
  replica.
- `seedStoreDbName` (`src/identity/seedStore.ts`) and `isReplicaDbName` beside
  `dbNameForController` name the seed-store and replica database shapes once,
  for the auth store that mints them and the sweep that matches them.

### Fixed

- The entity store's write verbs (`insert`, `update`, `upsert`) commit to the
  Map before the persist is awaited, and the persists of one id (`remove`
  included) run in call order, so a read-modify-write issued before the previous
  write has persisted merges onto what that one wrote instead of onto the
  pre-write value and dropping it, and two unawaited upserts of a new id no
  longer mint two rows. A persist that rejects puts the last persisted doc back,
  and a hydrate that lands mid-write keeps showing the write.
  `defineDocumentApp`'s `update` and `exportFile` inherit this.
- The clear-data sweep matches only the database names this library derives from
  its `dbName` (`<dbName>-session`, `<dbName>-anon`, `<dbName>-<8 hex>`, and the
  Dexie shells RxDB opens beside a replica), so clearing one app no longer wipes
  a sibling app on the same origin whose `dbName` extends it.
- `LocalStore.init` closes the database it opened when `addCollections` refuses
  (a stored schema hash that no longer matches), instead of leaving it open with
  its collections counted toward RxDB's process-wide cap.
- The adoption merge fills a missing `updatedAt` and a missing `writerId` each
  on its own. A payload carrying `updatedAt` but no `writerId` keeps its
  original instant instead of being re-stamped to the adoption time and
  outranking newer connected edits.
- An epoch-roster entry that names this app but fails its key-wrap check
  (`IntegrityError` from `@interop/was-client` 0.99.1) is routed as a tamper
  signal: the local store records it as the collection's spent refusal, and the
  shared-collection reader surfaces it as itself rather than as "not a
  recipient".
- A boot over a persisted session whose grants have expired lands `reconnect`
  over the connected replica, with the seed intact and no replication started,
  instead of wiping the session and landing an anonymous `local` replica with no
  reconnect banner. The replica opens on the cached descriptors alone, and
  `reconnect()` renews the grants, persists the record, and starts sync. When
  that expired restore fails with `KeyUnwrapError` or `IntegrityError` (a cached
  roster that no longer wraps a key to this app, or whose entry for it fails its
  key-wrap check), the record is cleared, so the session lands a clean `local`
  rather than re-running the failed bring-up on every reload; any other failure
  keeps the record for a reload or the reconnect to repair.
- A singleton duplicate that another client tombstoned while a hydrate was
  reconciling it is no longer re-removed or warned about, and `deleteEntity` no
  longer rewrites a tombstone a pull landed under it. A winner tombstoned while
  its losers were being removed is warned about.
- `login` resolves `null` instead of connecting when the session changed while
  the wallet popup was open (a provider unmount with no re-mount, a
  `clearLocalData`, a `connectWithGrants`). A sync-controller stop that throws
  no longer aborts the teardown, and `destroy` resets the session state even
  when its teardown throws.
- `logout` clears the persisted session record before the anonymous replica
  re-opens, so a re-open that fails no longer leaves the wallet seed on disk for
  a reload to hot-restore. A failed re-open, in `logout` and in a connected
  activation's fallback, now lands `local` with no replica and the failure on
  `error` instead of keeping the previous status with no replica attached.
- `AdoptDialog` swallows the rejection of the `login({ adopt })` it starts. The
  store already records a failed login on `useLogin().error`, so a wallet
  without App Connect support or a failed activation no longer also escapes the
  dialog as an unhandled rejection.
- `LocalStore.setDescriptorSource` re-arms the refresh guard, the in-flight
  refresh, and the recorded refusals together, and a refresh that outlives its
  source records nothing.
- A refresh whose fetched roster excludes this app is recorded and surfaces as
  `KeyUnwrapError`; a refresh that fails on the wire is logged and left
  un-spent.
- Per-collection cipher changes (the refresh, `applyRemoteDescriptor`,
  `applyCollectionMeta`) are serialized, and a descriptor that is an earlier
  head of the log than the held one is not swapped back in.
- A public (plaintext) collection row whose body is an EDV envelope (an object
  `jwe` member) no longer breaks the collection. The plaintext codec raises it
  as `IntegrityError`, the same failure a mis-bound payload id is, so hydration
  skips the row with a warning and hydrates the rest, and the conflict handler
  settles a 412 on it by last-write-wins stamp instead of failing the
  replication cycle on every retry. Any grant holder can write such a body, and
  before this every hydrate of that collection rejected.
- The sync bootstrap guards its per-collection hook. A cipher rebuild that
  throws `KeyUnwrapError` (a roster rotated off this app since the cached
  descriptor) now costs that one collection, which is warned about and left on
  the cipher it opened with, while every other collection replicates. Before,
  the throw rejected `startWasSync` as a whole and no collection replicated
  while the session stayed `connected`.

- The adopted anonymous replica is removed before its seed is cleared. The
  database goes through the wipe executor (so the Dexie shells RxDB's removal
  leaves standing go with it), and the seed is cleared only when nothing failed.
  Before, the seed was cleared first, so a failed removal (another tab holding
  the database) orphaned the replica under a name no later run could derive.
- The connect transition's replica swap opens only for an `adopt: 'merge'` login
  from `local`, the one case anonymous data is carried over. A write queued
  during a login from `reconnect` now rejects instead of waiting on the swap and
  landing in the newly connected account's replica as a create.
- `reconnect()` runs its post-popup epilogue (controller stop, record persist,
  sync restart, `connected` transition) on the lifecycle chain and re-checks the
  session first. A `logout`, `clearLocalData`, or `destroy` completed while the
  re-grant popup was open is no longer undone when the popup answers: the
  renewed grants are discarded with a warning, nothing is persisted, and no sync
  or expiry watch starts over the torn-down session.
- `AudienceReader.pull()` no longer reports a replay (or a listing read) cut by
  a denial of a request that left under a since-replaced zcap as
  `snapshot: true`. Such a cut pauses nothing but leaves the read partial; the
  pull now returns `snapshot: false` with the pages it did read, and the
  checkpoint stays at the last fully read page. A consumer applying the partial
  set as a snapshot would have dropped every post the cut kept it from reading.
- `hydrateSingleton` tombstones a duplicate row with a conditional write on the
  revision it read, and `deleteEntity` removes through RxDB's incremental write
  queue, so a pull that updated or tombstoned the row after it was read (the
  singleton decrypts can wait on a descriptor refresh) no longer fails the call
  with a storage conflict. A duplicate whose row moved meanwhile is skipped with
  a warning and reconciled by the next hydrate rather than removed unweighed,
  and a winner whose row moved tombstones no loser at all.

## 0.30.0 - 2026-10-12

### Changed

- Follow `@interop/was-client` 0.97.0, whose `WasClient` takes the server's
  Spaces Repository URL (`<base>/spaces/`) as `serverUrl`. `ParsedGrants` now
  carries the server's base URL as `baseUrl` (read off the grant targets,
  sub-path mount included) in place of `serverUrl`; the remote store builds its
  client over `spacesUrl({ baseUrl })`. Service discovery starts from that URL,
  which the WAS server itself answers, so a bare origin whose root is served by
  another application (a wallet's pages, say) no longer fails login with
  "carries no rel=service link". `createSpaceTrust` and `resolveSpaceOwner` take
  `baseUrl`, and `provisionDevGrants` takes the Spaces Repository URL as
  `serverUrl`.
- The persisted session record's `serverUrl` field is renamed `baseUrl` and
  holds the server's base URL. A record under the old shape fails the structural
  check and is dropped, so the next load falls through to a returning login.
- `CheckedGrants.parsed` and `LoginOutcome.parsed` are optional, absent for a
  grant-less login (an app requesting no collections, or a shared-only app whose
  user declined every share) in place of the former empty-string topology.
- `WasRemoteStore.serverUrl` is removed; read `was.serverUrl` or `was.baseUrl`
  off the store's client.
- Requires `@interop/was-sync` 0.10.0, whose controller port names the
  replication-identifier input `baseUrl`.

### Fixed

- A login that returns no grants lands `connected` again instead of failing its
  activation: the session persists no record, starts no replication, and builds
  no remote store, since there is no server to point them at. A reload of such a
  session lands in `local`, as before.

## 0.29.0 - 2026-10-11

### Changed

- A write issued during the connect transition (`login` / `connectWithGrants`)
  no longer rejects with "LocalStore is not initialized". The transition is a
  replica swap on the `StorageContext` (`beginSwap` / `endSwap`): the
  process-wide pointer stays with the session while the anonymous replica is
  detached, and the entity-store write verbs resolve their replica through the
  new `awaitStore`, which waits for the swap to attach and hydrate the connected
  replica (or the re-opened anonymous one, on a failed activation) and then runs
  the write there. `hydrate` still reads through `requireStore`. Only a merge
  opens a swap; under `adopt: 'leave'` a mid-transition write still rejects, so
  an edit of a set-aside document cannot resurrect it in the connected replica.
- `login`'s connect epilogue now rides the serialized lifecycle chain (its
  wallet popup await stays off it), and `connectWithGrants` is a no-op while a
  login is in flight, so neither can swap the replica out from under the other
  or under a `destroy`.
- A failed connect surfaces its error from the caller (`login`,
  `connectWithGrants`, `boot`) only, instead of once in the activation and once
  more in `login`.
- The connected activation runs its network half (the Space owner's log, the
  collection logs, the descriptor reads) before the anonymous replica is
  detached, so the swap holds only local work: collect, open, merge, hydrate. A
  failed read rejects with the anonymous replica still attached and nothing to
  undo.
- `provisionDevGrants` takes an `expires` option and defaults it to
  `DEV_GRANT_TTL_MS` (seven days, freewallet's write-grant lifetime; exported
  from `./dev`). It passed none before, so ezcap minted five-minute grants and
  the reconnect banner was raised right after a dev-connect.

## 0.28.0 - 2026-10-11

### Added

- `rxdb` is an optional peer, loaded lazily in `LocalStore.init()` /
  `removeDatabase()` and `SyncController.start()`. A replica-less app installs
  without it; an app that replicates adds it explicitly. New `ReplicaStorage`
  and `ReplicaChange` types replace the `rxdb` types on the public surface, so
  the declarations name no `rxdb` type. `test:dist` fails on a static `rxdb` or
  `@interop/was-sync/rxdb` import in `dist` (WR-44).
- `SyncController` declares the session's `writerId` to the server on every push
  (was-sync's `writerId` replication option, sent as the `Writer-Id` header).
  The new `WasSyncConfig.declareWriterId` (default `true`) opts out, withholding
  the label from the wire while the payload's LWW stamp is unchanged (WR-53).

### Changed

- **BREAKING**: `isAuthError` is no longer re-exported from the root entry.
  Import it from `@interop/was-sync/rxdb` (WR-44).
- **BREAKING**: `LocalStore.rxCollection` is `@internal` and stripped from the
  published declarations; its return type is RxDB's. Tests that reached the RxDB
  collection through it must go through `LocalStore`'s own verbs (WR-44).
- `resolveSpaceOwner` resolves the owner through wallet-core's
  `discoverAccountLog` instead of its own fetch, parse, and resolve body; the
  location check runs upstream.
- `provisionDevGrants` promotes the Space controller through wallet-core's
  `ensurePromotedSpaceController` under the configured Space name, so the
  promotion reads first and heals an interrupted run.

- **BREAKING**: every `edv` collection is read through a verifying descriptor
  source under was-client's `requireGoverned` policy. `WasRemoteStore` gains
  `descriptorSource`, wallet-core's `logGovernedDescriptorSource` over each
  collection's `meta/log` (invoked with the collection's own grant), checked
  against the Space owner's did:webvh account log. The owner is resolved from
  the Space's world-readable `id/did.jsonl` (`resolveSpaceOwner`): the log is
  fetched, resolved, and the resolved DID's log location is checked against the
  URL it was served from. The login-time read, the sync bootstrap's install,
  `LocalStore`'s unknown-epoch refresh, and `SharedCollectionReader` all acquire
  through it; a descriptor is never taken from the Metadata object's
  `encryption` projection any more. `remoteDescriptorSource` is removed from the
  root entry. A collection with no governing log stays fail-closed. The Space
  owner's verified view and the chain-head pins are held in memory for the
  connected activation on one `SpaceTrust` the login-time read and the sync
  bootstrap share (`fromGrants` takes it as `trust`), so the owner's log is
  fetched and verified once per activation. A failed Space-owner resolution is
  retried on the next read rather than remembered, and a shared collection whose
  descriptor read fails surfaces that failure as itself instead of as
  `SharedCollectionUnavailableError`.
- was-client's `UnverifiedDescriptorError` (a source that does not verify the
  governing log) surfaces as itself at every call site:
  `SharedCollectionReader.open` rethrows it ahead of
  `SharedCollectionUnavailableError`, and `LocalStore` surfaces it from the
  decrypt that met it and every later one, instead of the envelope's
  unknown-epoch error. A governing log the source refuses to adopt (a forged or
  discontinuous chain, vh-resource-log's `isResourceLogRefusal`) surfaces the
  same way at both sites. Any other refresh failure in `LocalStore` is logged at
  `warn` and re-asked on the next unknown-epoch decrypt.
- `resolveSpaceOwner` takes an optional `pinStore`, and `createSpaceTrust`
  passes its own, so the owner's account log is checked for chain-head
  continuity across resolutions within one activation like every collection log
  is.
- `createSpaceTrust`, `SpaceTrust`, `resolveSpaceOwner`, and
  `acquireGovernedDescriptor` are exported from the root entry, so a consumer
  building its own `WasRemoteStore` or `LocalStore` can share one trust across
  stores and build a verifying descriptor source.
- `provisionDevGrants` builds what a wallet's account genesis builds: a Space
  promoted to a did:webvh owner whose log is published at `id/did.jsonl`, and
  every private collection's epoch zero installed as the genesis of its
  `meta/log` through the log-governed descriptor store. `provisionerDid` is now
  the did:webvh. The server URL must be one did:webvh accepts (`https://`, or
  `http://` on the literal host `localhost`). The Metadata-write probe leaves
  `encryption` out of the body it writes back, since the server derives it from
  the log head.
- Remove `WasRemoteStore.readCollectionEncryption` (the Metadata object's
  `encryption` projection is no longer read for a descriptor; `descriptorSource`
  is the read) and `WasRemoteStore.markCollectionEncrypted` with the sync
  bootstrap's `{ encryption: { scheme: 'edv' } }` declaration write. A
  collection is declared encrypted by its governing log's genesis, and one with
  no log stays fail-closed under the policy above, so the bare declaration had
  nothing left to do.
- Add `@interop/vh-resource-log` as a dependency.
- Bump `@interop/was-sync` to 0.9.0 and `@interop/was-client` to 0.94.0. The ack
  write-back now stamps a pushed row's `updatedAt`, `updatedAtCounter`,
  `originId`, `createdBy`, and `meta` from the write response itself, so a row
  this replica created no longer depends on the feed echo for its server stamp
  (needs a server answering `201` / `200` with a body, was-teaching-server
  0.42.0 or later). The replica schema also gains an optional row-level
  `writerId` at the same schema version, so RxDB refuses to reopen an existing
  replica: as with 0.27.0, every remembered browser clears its local data and
  logs in again once, and local writes not yet pushed are lost with the old
  replica. Nothing in this library reads the push ack, so no code changed.

## 0.27.0 - 2026-10-10

### Changed

- Depend on `@interop/was-client` 0.94.0 for `parseAbsoluteSpaceTarget`,
  `allowsAction`, and `isDenialError`.

### Added

- `AudienceReader`, the member-side reader of one plaintext audience collection
  in another owner's Space, opened on a GET and HEAD zcap and a signer directly
  (`AudienceReader.open({ zcap, signer, checkpoint?, pageSize? })`). The client
  is built from the zcap's own `invocationTarget` (was-client's
  `parseAbsoluteSpaceTarget`), so the audience may live on another host.
  `pull()` follows the `changes` feed through its GET form from a per-reader
  checkpoint that moves only with the changes a pull returns, keeps
  `kind: 'resource'` entries only, replays from the start on a refused
  checkpoint, and falls back to the listing plus one GET per resource on a 405
  or 501 (both `snapshot: true`). A denial (401, 403, or the masked 404 with its
  `capability-revoked` / `capability-expired` causes, on the feed or settled
  against the container after a null body read) pauses the reader with its
  checkpoint kept; `replaceCapability({ zcap })` resumes it, and a denial of a
  request in flight under the replaced zcap pauses nothing. Exported with
  `AUDIENCE_CHANGES_PAGE_SIZE`, `AudienceChange`, and `AudiencePull`.

### Changed

- `SharedCollectionReader.list()` reads the widened `changes` feed through
  was-client's `Collection.documents()` walk instead of paging the feed itself.
  Only `kind: 'resource'` entries with JSON content are kept; the Collection's
  own records, unknown kinds, tombstones (`deleted`, was `_deleted`), and binary
  or `text/jsonl` resources drop out, and the walk resumes from each page's
  checkpoint.
- Bump `@interop/was-sync` to 0.8.2. The replica schema carries the server's
  write stamp (`updatedAtCounter`, `originId`, nested `meta`) in place of the
  integer `version` / `metaVersion`, at the same schema version, so RxDB refuses
  to reopen an existing replica. No migration or in-code forget is shipped:
  every remembered browser clears its local data (`clearLocalData()` removes the
  replica with its replication meta) and logs in again once, and local writes
  not yet pushed are lost with the old replica. Also bump `@interop/was-client`
  to 0.93.2, `@interop/wallet-core` to 0.104.1, and `@interop/wallet-request` to
  0.5.1.
- Docs: the party that asks a wallet for grants is the "requester" (an app,
  service, or agent), replacing "relying party" / "RP" in JSDoc, README, and
  ARCHITECTURE.md. Here the requester is the app running this library.
- Tests: the in-process server suites boot through `was-teaching-server/testing`
  (`startTestServer`, `openTempBackend`), against the server's 0.40.0 release.

## 0.26.0 - 2026-09-27

### Changed

- Bump wallet-request to 0.4.1 (appUrl rejects query).

## 0.25.0 - 2026-09-17

### Breaking

- Every decrypt is addressed by the row's/resource's own id, matching was-client
  0.68's required `DocCipher.decrypt({ id, envelope })` shape. `DocCipher`
  implementors must take `id`, and `LocalStore#decryptEnvelope` takes an options
  object (`{ key, id, envelope }`) rather than positional arguments. Both are
  root-entry API.

### Changed

- `@interop/was-client` bumped to `^0.69.0`, `@interop/was-sync` to `^0.4.0`,
  `@interop/did-method-webvh` to `^5.10.0`, `@interop/ezcap` to `^7.4.9`.
- The public plaintext codec checks the binding that is real on a public
  collection: the row id must equal the payload's own `id`. A mismatch (or a
  body carrying no string `id`) raises `IntegrityError`. It refuses a decrypt
  carrying no resource id at all through was-client's own `requireResourceId`,
  the guard both of that package's built-in ciphers run first.

### Fixed

- A private collection's `IntegrityError` fails that collection's replication
  cycle the same way any other fatal conflict-resolution error does; no new
  status or error-name contract was added for it.
- `LocalStore` hydration skips, with a warning, a public collection's row whose
  payload `id` is missing or differs from its row id, so one malformed document
  no longer fails hydration of the rest. The LWW conflict handler is lenient the
  same way: on a public collection a mis-bound side is compared on the
  last-write-wins stamp it still carries instead of failing the cycle, which the
  server's unchanged body would otherwise fail on every retry.
- `SharedCollectionReader.get()` surfaces `IntegrityError` instead of skipping
  the resource with the "not a recipient" warning. `list()` skips a mis-bound
  envelope (logged at `error`) so one of them cannot make a wallet-owned
  collection unlistable.

## 0.24.1 - 2026-09-15

### Changed

- Update to latest wallet-core@0.78.1 and was-client@0.65.0.

## 0.24.0 - 2026-09-14

### Breaking

- A collection's description and its metadata are one object under WAS v0.5. The
  `encryption` descriptor, the public `plaintext.indexes` declaration, and the
  encrypted `custom` envelope all live on the Collection Metadata object at
  `meta`, under one validator. The old partial-body description `PUT` is gone;
  every write now reads that object first and carries it forward whole, so a
  declaration write no longer clears `custom` (where the blinded-index schema
  lives). Both the encryption declaration and the public `indexes` declaration
  go through was-client's `Collection.configure` merge rather than a raw `PUT`.
- The sync bootstrap reads a granted collection's Metadata object once per
  collection, public collections with indexes included, and feeds the cipher
  rebuild, the encryption declaration, and the public indexes declaration from
  that read. A private collection with a blinding key still costs extra reads:
  the blinded-index declaration and its schema install read the object again on
  their own.
- `provisionDevGrants`'s per-collection grant target is the collection's
  canonical container URL, and its write probe targets `meta`.
- Minimum versions: `@interop/was-client` `^0.63.0`, `@interop/wallet-core`
  `^0.76.0`, `@interop/was-sync` `^0.2.9`, and `was-teaching-server` `^0.33.0`
  for the in-process tests.
- `@interop/webkms-client` is replaced by `@interop/capability-agent` `^0.2.0`
  for `CapabilityAgent`, following `@interop/wallet-core`'s drop of its
  `./identity` subpath (now `@interop/was-client/identity`).
- A server still on WAS v0.4 no longer works against this release.
- `was-teaching-server` 0.33.0 admits a Collection-scoped grant at
  `PUT /space/{s}/{c}/meta`, so the encryption descriptor, the public `indexes`
  declaration, and the blinded-index schema all land under the per-collection
  grants this library holds. The warn-and-skip path stays for a read-only or
  withdrawn grant.
- `WasRemoteStore.markCollectionEncrypted` drops its `encryption` option; the
  skip check now reads `current.description.encryption` directly, since every
  caller already had one or the other. A caller that already knows a
  collection's descriptor without a read (the known-descriptor path in the sync
  bootstrap) skips the call itself instead of passing an absent `current`.
- The blinded-index declaration settles every missing attribute in one
  compare-and-swap write through was-client's `Collection.declareIndexes`,
  instead of one read-and-write per attribute. Minimum `@interop/was-client` is
  `^0.63.0`.

### Changed

- `@interop/wallet-request` 0.2.0. The counterpart test no longer exercises the
  legacy (pre-`appUrl`) app-key re-issue path, which that release removed.

## 0.23.0 - 2026-09-09

### Changed

- The App Connect request vocabulary and the app-key credential issuer
  (`serializedAppUrl`, `issueAppKeyCredential`, the credential's pinned wire
  constants, the wallet-request types) are imported from
  `@interop/wallet-request` 0.1.0; wallet-core 0.70.0 no longer ships the
  `request` subpath. `@interop/wallet-core` stays for `keyring` and `identity`.

## 0.22.2 - 2026-09-08

### Changed

- The `rxdb` peer floor is `^17.5.0`. Under 17.4 the Dexie storage never evicted
  a closed connection from its name cache, so `logout({ wipe: true })` followed
  by a login in the same page reopened the replica on a closed Dexie instance
  and failed with `DatabaseClosedError` (rxdb #8793, fixed in 17.5.0).

## 0.22.1 - 2026-09-08

### Changed

- `createWasSyncPort` returns the client's port as is. The runtime `putMeta`
  probe and the feed-page cast are gone, since `@interop/was-client` 0.54.0
  types the port as what it implements (`putMeta` required, `Json` bodies), so a
  divergence at the seam is now a compile error.

- `setLogger` also installs the logger into `@interop/was-sync`, so the
  replication driver's diagnostics (the controller core, conflict handling, push
  and pull) arrive under the app's namespace. The driver's per-call `log` option
  is gone with `@interop/was-sync`'s adoption of the logging port.

- The descriptor seam imports (`EncryptionDescriptorCache`,
  `EncryptionDescriptorSource`, `DescriptorRefreshPolicy`,
  `createRefreshingEdvDocCipher`) come from `@interop/was-client/edv`, their
  owner since `@interop/wallet-core` 0.69.0 stopped re-exporting them from
  `./descriptors`.

- `WasRemoteStore.declareCollectionIndexes` reads the public collection's
  description first and skips the PUT when the stored `plaintext.indexes`
  already matches the configured list, like the encryption-descriptor and
  blinded-index declarations, so a returning session writes nothing. A read that
  fails still leads to the PUT.

- The collection-description PUT body is typed as the client's
  `CollectionDescription` rather than an untyped record, so a drift from the
  shape the server reads is a compile error.

### Fixed

- A public collection's equality indexes are declared under the collection
  description's `plaintext` member (`plaintext: { indexes }`), the shape
  `was-teaching-server` 0.26.0 reads (after `@interop/storage-core` 0.10.0). A
  top-level `indexes` is no longer read by the server, so the bootstrap's
  declaration was being accepted and dropped, and equality queries on a public
  collection failed with a 400.

- `test/node/conditionalWrites.test.ts` follows the opaque `ETag` contract: the
  assumed rows carry the acked `etag` / `metaEtag`, which the push handler
  echoes as `If-Match`, instead of rebuilding a validator from `version`. The
  dev server moves to `was-teaching-server` 0.29.0, whose `ETag` carries the
  generation prefix `parseEtag` reads the revision from.

## 0.22.0 - 2026-09-05

### Added

- The logging port. `setLogger(logger)` on the package root installs the logger
  every call site in this package emits through and returns the one installed
  before it; the structural `Logger` type (`debug`, `info`, `warn`, `error`,
  each `(msg, data?)`) is exported beside it. An app wires it once at bootstrap,
  e.g. `setLogger(createLogger('wr'))` with `@interop/logger`. `@interop/logger`
  is a devDependency only: the published artifact carries no reference to it.

### Changed

- Every `console.*` call site in `src/` (39, across 11 files) emits through the
  port. An unwired consumer keeps today's channel and level through the console
  fallback, but not byte-identical output: messages carry a `[was-react]`
  prefix, values previously interpolated into the message text (collection ids,
  statuses, database names) now arrive in one trailing `data` object, and an
  Error rides as `data.err`. Anything matching console text by substring should
  not anchor at position 0.
- A failed wallet-presentation verification no longer logs the presentation
  body. An App Connect response embeds the app-key credential and its seed,
  which no log sink may receive; the per-check failures are still logged.

## 0.21.0 - 2026-09-05

### Changed

- The WAS replication driver now lives in `@interop/was-sync` and is a
  dependency of this package. What moved: the changes-feed pull handler, the
  conditional-write push handler, the `replicateRxCollection` wiring, the
  feed-backed conflict re-read, the synced-document schema, the conflict-handler
  seam with its last-write-wins default, the writer-id mint, and the controller
  core. `src/sync/` is gone; `docCipher.ts` and `wasSyncPort.ts` moved to
  `src/storage/`, which is where this package's key handling stays.
- `SyncController` (`src/storage/syncController.ts`) is now a binding over the
  package's `createSyncController`. Its public shape is unchanged
  (`start({ remoteStore, localStore, onRemoteChange, onAuthError })`, `reSync`,
  a terminal `stop`), and so are the skip of an uncovered collection, the status
  keying on the logical collection key, and the failed bring-up that flags every
  collection and rethrows. One behavior is new: the periodic re-sync now skips
  its tick while the browser reports itself offline, instead of firing into a
  known-down network.
- `storage/writerId.ts` is a thin binding over the package's mint: it supplies
  `DEFAULT_STORAGE_KEY_PREFIX` and `localStorage`. `getWriterId` and
  `clearPersistedWriterId` keep their names and their optional-prefix signature.
- `isAuthError` keeps its name and is re-exported from `@interop/was-sync/rxdb`.
  It is still exported from this package's root.
- `SyncStatus` is re-exported from `@interop/was-client/sync`, which now owns
  the four-string vocabulary the replication driver and the wallets' own sync
  engine both report. The Zustand status store, `deriveSyncRollup`, and
  `useSyncStatus` are unchanged.
- The "master" names became "primary" in the package: `MasterState` is
  `PrimaryState`, `MasterReadCache` is `PrimaryReadCache`, and
  `withFeedMasterRead` is `withFeedPrimaryRead`. RxDB's own `assumedMasterState`
  and `realMasterState` fields are RxDB's API and are untouched.
- The replica schema is the package's merged one, which adds `createdBy`. RxDB
  hashes a schema and refuses to open a replica whose stored hash differs at the
  same `version`, and it ships at `version: 0` with no migration strategy. Every
  existing local replica must therefore be cleared once: clear local data and
  log in again, and the collections re-pull from WAS. Anything written only
  locally and never synced is lost with it.

### Removed

The root barrel no longer re-exports the driver. Every name below is gone from
`@interop/was-react`; import it from the package named beside it.

- From `@interop/was-sync`: `syncedDocSchema`, `makeLwwConflictHandler`,
  `lwwFields`, and the types `LwwFields`, `SyncCheckpoint`, `SyncedDoc`,
  `WireDoc`, `WasSyncBasePort`, `WasSyncPort`, and `MasterState` /
  `MasterReadCache` (as `PrimaryState` / `PrimaryReadCache`).
- From `@interop/was-sync/rxdb`: `createWasReplication`, `createPullHandler`,
  `wireDocToRxDoc`, `createPushHandler`, the type `PushWriteAck`, and
  `withFeedMasterRead` (as `withFeedPrimaryRead`).
- From `@interop/was-client/sync`: `errorStatus`, `errorMessage`, `formatEtag`,
  `isEncryptedEnvelope`, `isUnknownEpochError`, `WasSyncConflictError`,
  `WasSyncAuthError`, and the type `Json` (also available from
  `@interop/was-sync`). These were pass-throughs; the client owns them.
- From `@interop/was-client/edv`: `hasKeyEpochs`, `epochRostersEqual`, also
  pass-throughs.

`createDocCipher`, `createPlaintextDocCodec`, `createUnprovisionedDocCipher`,
the type `DocCipher`, and `createWasSyncPort` stay exported from this package's
root: they hold this library's key handling and the client seam, which the
driver never touches.

### Dependencies

- `@interop/was-sync` `^0.1.0`, added.
- `rxdb ^17` is still a required peer: `LocalStore` is exported from the root
  entry and imports it. A replica-less app can drop it once that entry point is
  split (WR-44).

### Changed

- The last-write-wins comparison is `remotePayloadWins` from
  `@interop/social-core`, and `src/sync/lww.ts` is deleted. Its stamp accessor
  (`lwwFields`, `LwwFields`) moves to `src/sync/types.ts` and still ships from
  the root barrel. This is a behavior change on the three sites that compare
  outside conflict resolution: the anonymous-to-connected adopt, the
  duplicate-id pick in `hydrateSingleton`, and the entity store's patch. On a
  pair where exactly one `updatedAt` parses, the parseable side no longer wins;
  the raw strings compare lexically. One rule now, the one every wallet's stored
  data already converges under.
- A `412`-refused delete whose re-read body is unchanged is re-issued against
  the current ETag. A locally created row pushed with a revision the server has
  since moved past would otherwise be refused forever and stay live on the
  server. Every other `412` is still a real conflict.
- `bodiesEqual` compares JCS-canonicalized JSON. A stored body a host
  re-serializes with a different key order no longer reads as a change, which is
  what keeps the delete retry firing and stops a spurious `PUT` on an immutable
  content-addressed row.
- The push handler and the sync controller's `isAuthError` match the port's
  typed signals by `err.name`, through `isSyncConflictError`, `isSyncAuthError`,
  and `isUnknownEpochError` from `@interop/was-client/sync`, never by
  `instanceof`. An error raised by a second physical copy of the client is
  classified the same as this copy's. `err.status` is read off the matched value
  as a plain property.
- The server-managed `createdBy` creator DID is carried across the sync layer:
  it joins `OptionalBodyFields`, `WireDoc`, and `SyncedDoc`, and rides the pull
  mapping (live documents and tombstones) and the assembled conflict entry. The
  RxDB schema does not declare it yet; that lands with the merged schema when
  the driver moves into its own package.
- `MasterState.deleted` is optional. A feed-backed read sets it; a client `get`
  resolves `null` for a tombstone and sets nothing, and the push handler reads
  an absent flag as `false`.
- `getWriterId` no longer adopts a value left under the pre-rename
  `<prefix>clientId` key, and `clearPersistedWriterId` no longer removes that
  key. Where `localStorage` cannot answer, `getWriterId` mints a fresh id per
  call instead of remembering one for the process: a shared fallback stamped one
  label into two accounts' histories in the same tab.
- `docCipher.ts` no longer declares its own unknown-epoch predicate or its own
  base cipher shape. `isUnknownEpochError` ships from `@interop/was-client/sync`
  (still re-exported from the root barrel), and `DocCipher` extends the
  client's, adding the required `encryptUpdate` and the optional blinded-index
  `applyMeta`.
- Dependency floors: `@interop/was-client` `^0.49.0`, `@interop/wallet-core`
  `^0.67.0`, `@interop/webkms-client` `^14.7.5` (matching wallet-core's).
  `@interop/social-core` and `json-canonicalize` are added.

### Removed

- The root barrel no longer exports `remotePayloadWins`. It is
  `@interop/social-core`'s name, and one name has one owner; import it from
  there.

## 0.20.1 - 2026-09-05

### Fixed

- A transient failure of a collection-description read (a dropped connection, a
  5xx) is no longer taken for "no encryption descriptor".
  `WasRemoteStore.readCollectionEncryption` answers `undefined` only for a
  not-found response or a description with no `encryption` member; any other
  failure is thrown, wrapped with the collection id. A login fails its connected
  activation on it (falling back to `local` with the anonymous replica intact
  for a retry), a hot restore opens that collection fail-closed and still lands
  connected, the sync bootstrap skips the collection for the session with a
  warning, and the unknown-epoch refresh warns and leaves the cipher as it was.
- A transient failure of a collection's `/meta` read is no longer taken for "no
  metadata". `WasRemoteStore.readCollectionMeta` answers `undefined` only for a
  not-found response or a backend without metadata support (`501`); any other
  failure is thrown, wrapped with the collection id, and the sync bootstrap's
  blinded-index schema install warns and skips that collection.
- Neither read retries on its own: the HTTP client underneath already retries
  transient status codes and network errors, so a second retry layer only
  multiplied the attempts and the delay before a failure surfaced.
- A session that loses the attach-time storage-context claim (two providers
  booting at once, or a keyed remount overlapping the old provider's teardown)
  now closes the replica it opened before failing, instead of leaving an open
  RxDB database behind.
- `StorageContext.detachStore` now releases the active storage-context pointer
  when that context holds it, so every teardown (`destroy()`, logout,
  clear-data, the connected activation's fallback to `local`) releases it.
  Previously nothing did, and after a provider unmount the facades kept
  resolving the retired context; they now throw until the next boot claims a
  live one.
- A connected activation that fails and whose fallback to `local` also fails now
  surfaces the activation's own error; the fallback's is warned about.

## 0.20.0 - 2026-09-04

### Changed

- **BREAKING:** The process-wide storage holders are replaced by a
  session-scoped `StorageContext` (`src/storage/storageContext.ts`), created by
  `createAuthStore` and exposed as `storageContext` on the auth store's state.
  It owns the open replica, the remote store, the writer id, the sync status
  store, and the re-hydrate timers, and its `whileAttached` is the one staleness
  mechanism the change patches, the scheduled re-hydrates, and `hasLocalData`
  run on. The app-facing facades (`requireStore`, `hasStore`,
  `requireRemoteStore`, `hasRemoteStore`, `requireWriterId`, `stampLww`,
  `publicUrlFor`, the entity-store verbs) now resolve the active context, and
  opening a replica while another context still holds one throws (before the
  database is opened) instead of clobbering it. `createAuthStore` skips its
  creation-time activation while another session is live, so a keyed provider
  remount fails the new provider's boot rather than throwing during render.
- `hasLocalData()` keeps resolving `false` (with a warning) when a count fails
  against the attached replica, rather than rejecting into the login handler.
- Tearing down a session now cancels the pending re-hydrates before draining the
  sync controller, so a debounced re-hydrate cannot fire against a replica that
  is about to close.
- **BREAKING:** Removed `setLocalStore`, `clearLocalStore`, `setRemoteStore`,
  `clearRemoteStore`, `setWriterId`, `clearWriterId`, `useSyncStatusStore`,
  `hydrateAll`, `clearAllEntityStores`, `patchFromChange`, `scheduleRehydrate`,
  and `cancelScheduledRehydrates`. Test harnesses attach a store through
  `new StorageContext({ registry, writerId }).attachStore(store)`; the
  re-hydrate verbs are `StorageContext` methods; sync status is
  `storageContext.syncStatus` (a vanilla zustand store,
  `createSyncStatusStore`).
- **BREAKING:** `SyncController` takes a `syncStatus` store in its constructor;
  `mergeAdopted` takes the `writerId` explicitly.
- `getWriterId` moved to `src/storage/writerId.ts` beside the new
  `clearPersistedWriterId` (localStorage only); the running session's id is
  replaced by `StorageContext.resetWriterId`.
- `issueSeedCredential` delegates to wallet-core's `issueAppKeyCredential` (the
  issuer the wallet mints with) instead of re-implementing the app-key
  credential's shape; its signature and return value are unchanged. Requires
  `@interop/wallet-core` >= 0.66.0. The test teaching server is bumped to
  0.25.1, which verifies the `eddsa-jcs-2022` zcap proofs newer wallet-core
  releases sign with.

### Added

- New exports: `StorageContext`, `activateStorageContext`,
  `deactivateStorageContext`, `hasStorageContext`, `requireStorageContext`,
  `createSyncStatusStore`, `clearPersistedWriterId`, and the `SyncStatusStore`
  type.

## 0.19.0 - 2026-08-26

### Added

- `clearLocalData()` now resolves with a `LocalWipeReport`, describing what was
  removed and, on an engine that could not confirm a deletion, what stays
  `unverified`.
- New exports: `executeLocalWipe` and `snapshotWipeTargets`
  (`src/session/localWipe.ts`) and `clearWriterId`
  (`src/storage/storageManager.ts`), plus the `LocalWipeReport` and
  `WipeTargets` types.
- Test coverage confirming that conditional writes (`ifMatch` / `ifNoneMatch`)
  on encrypted collections now produce an RxDB conflict entry on a lost race,
  rather than the silent last-write-wins the preconditions previously degraded
  to on this class of collection.
- Test coverage for connecting to a wallet account anchored by a standing unlock
  credential with no enrolled durable clients: a deeper delegation chain, an
  ephemeral, non-stable presentation holder, a grant expiry shortened to its
  parent's, a mid-life authorization failure routing to `reconnect`, and a key
  epoch this app cannot open degrading a shared read to a warn-and-skip and a
  descriptor-less private collection to its fail-closed cipher. A
  wallet-composed counterpart case now exercises the same annex-shaped grant
  against `@interop/wallet-core`'s real request/response composition.

### Fixed

- `clearLocalData()` no longer orphans the anonymous replica: run from a
  connected session, it used to remove only the open replica, discard the
  anonymous seed, and mint a fresh identity, stranding the previous anonymous
  replica under a database name nothing could derive again. It now snapshots
  every database name before deleting anything and reaches both replicas.
- `logout({ wipe: true })` no longer leaves empty database shells behind: RxDB's
  own removal clears a collection's table but leaves its IndexedDB database
  standing, and the erase grade now deletes those shells too.
- The writer id is now cleared by `clearLocalData()`; it previously survived
  every wipe grade.

### Changed

- The logout and clear-data dialog copy is more precise about what each grade
  erases: the logout dialog names the connected replica specifically, and the
  clear-data dialog distinguishes the connected case (the synced copy survives)
  from the local-only case (this browser is the only copy).
- Upgraded `@interop/wallet-core` to ^0.56.0 and `@interop/was-client` to
  ^0.44.5.

## 0.18.1 - 2026-08-13

### Changed

- `hasKeyEpochs` is now re-exported from `@interop/was-client/edv` instead of
  being implemented here, and the local store's descriptor-refresh comparison
  uses that subpath's `epochRostersEqual` (also re-exported). Requires
  `@interop/was-client` >= 0.37.0.

## 0.18.0 - 2026-08-13

### Added

- Documents written through the sync path now carry blinded `indexed` entries:
  the sync bootstrap reads each hmac-bearing private collection's stored `/meta`
  (after declaring its blinded-index attributes) and installs the persisted
  index schema on that collection's document cipher
  (`LocalStore.applyCollectionMeta`), so app writes are findable by equality
  queries. The installed schema survives cipher rebuilds (epoch rotations).
  Documents sealed before the schema was installed remain unfindable until
  rewritten.
- `WasRemoteStore.readCollectionMeta` reads a collection's raw stored `/meta`
  value.

### Changed

- Upgraded `@interop/was-client` to 0.36.0 (adds the `applyMeta` / build-time
  `meta` support on `createEdvDocCipher` that the above uses).

## 0.17.0 - 2026-08-12

### Changed

- The session's encryption-descriptor policy (mint at local birth, cache-only
  read, live completion, cache write-back) moved out of the auth store into
  `src/storage/descriptorManager.ts`; the auth store only sequences it.
- `createDescriptorCache` gained bulk `readAllDescriptors` / `writeDescriptors`
  operations, so a bring-up phase reads or writes every collection's descriptor
  in one IndexedDB cycle instead of one per collection.
- The sync bootstrap and the login-time descriptor read now share one
  read-filter helper instead of duplicating the sequence.

## 0.16.0 - 2026-08-12

### Added

- The root entry re-exports `mintRecordEncryption` (from
  `@interop/wallet-core/keyring`) beside `LocalStore`, `deriveIdentity`, and
  `createDescriptorCache`, so a consumer opening a `LocalStore` directly can
  mint the epoch-bearing encryption descriptor that epoch-from-birth requires
  without depending on wallet-core.

## 0.15.0 - 2026-08-12

### Added

- Equality queries now work on private (encrypted) collections, through the same
  `entityStore.query({ equals, limit, cursor })` verb. Attribute names and
  values are blinded client-side with the collection's blinding key before the
  request is sent, the server matches opaque tokens, and the returned envelopes
  are decrypted locally. A public collection keeps its plaintext
  `filter[attr]=value` GET; `WasRemoteStore.queryCollectionByEquality` routes on
  visibility.
- `indexes` is now valid on a private collection. The requirement is that the
  collection was provisioned with a blinded-index key, which installs with its
  first key epoch or never.
- The sync bootstrap declares a private collection's configured `indexes` as
  blinded-index attributes in the collection's own encrypted metadata
  (`WasRemoteStore.declareBlindedIndexes`), so every recipient discovers what is
  queryable and the server never sees the attribute names. Only missing
  attributes are declared. Non-fatal: a collection provisioned without the key
  is warned about and still replicates in full.
- `WasRemoteStore.fromGrants` accepts the app's identity keys
  (`keys: { keyAgreementKey, keyResolver }`) and feeds them to the client's EDV
  keystore, which is what the blinded-index verbs build their codec from.
  Replication still moves envelopes verbatim and bypasses the codec. The
  blinding key is never passed in; the codec unwraps it from the collection's
  encryption descriptor.
- `provisionDevGrants` collection entries accept `blindedIndex?: boolean`
  (private collections only; ignored with a warning on a public one).

### Known limitations

- Documents written through the local-first sync path do not yet carry blinded
  index entries, because `@interop/was-client`'s sync doc cipher does not carry
  the index schema yet. A blinded query therefore finds only documents written
  through an index-aware codec path; existing documents become findable once
  rewritten that way.
- Index declarations are prospective: a document written before its attribute
  was declared carries no blinded entry for it.

## 0.14.0 - 2026-08-12

### Breaking

- Entity-store `insert` / `update` / `upsert` now stamp the last-write-wins
  fields `updatedAt` and `writerId` themselves, overwriting any the caller
  supplied, and their parameter type no longer requires those fields. Callers
  that still stamp keep compiling; their values are ignored.
- `mergeAdopted` no longer takes a `writerId` option; it sources the fill stamp
  from the session's resolved writer id.
- Removed the unused `collectionKeyForId` export; `isPublicCollection` (the
  shared visibility predicate resolving the `'private'` default) is exported
  from the config module in its place.
- `WasRemoteStore.markCollectionEncrypted` now requires the already-read
  `encryption` descriptor (its read-before-write guard no longer issues its own
  GET); the sync bootstrap reads each description once and feeds both the cipher
  rebuild and the guard.

### Added

- `setWriterId` / `requireWriterId` install and read the session's resolved
  writer id in the storage manager, and `stampLww` is the single place a
  payload's LWW fields are minted. `createAuthStore` installs the id before any
  replica opens.

### Changed

- `defineDocumentApp` no longer stamps LWW fields itself; its `update` upserts
  `{ id, data }` and the write verb stamps.
- The VPR / App Connect wire types (`IVPRDetails`, `IDIDAuthenticationQuery`,
  `ICapabilityQueryDetail`, `IAppConnectQuery`, `IAppConnectCapabilityQuery`)
  and the app-key credential constants (`APP_KEY_CREDENTIAL_TYPE`,
  `APP_KEY_TYPE_ARRAY`) now re-export from `@interop/data-integrity-core/vpr`
  and `@interop/wallet-core/request` instead of re-declaring them; exported
  names are unchanged.
- The sync bootstrap reuses the encryption descriptors the login flow read
  moments earlier (`startWasSync`'s `knownDescriptors` input) instead of
  re-issuing one GET per private collection on a fresh login; a hot restore
  still reads live as its freshness refresh.
- The adoption merge writes payloads concurrently per collection (and
  collections concurrently), the shared-collection resource-listing fallback
  fetches and decrypts concurrently, and `hydrateSingleton` tombstones duplicate
  losers from the rows it already holds instead of re-querying each.
- `clearSeedStore` wipes the session store in a single transaction.
- Internal dedup: the login / `connectWithGrants` connect epilogue, the
  `LocalStore` decrypt-all-rows loop, `updateEntity`'s resurrect branches, and
  `defineDocumentApp`'s current-data reads each live in one place now;
  `beginSync` resolves `void`.

## 0.13.1 - 2026-08-12

### Changed

- Rewrote ARCHITECTURE.md and AGENTS.md to describe the shipped `appUrl` profile
  and the subsystems the previous docs omitted (the session state machine, the
  anonymous local-first replica, adoption, `writerId`, the storage/sync layers,
  `defineDocumentApp`, the MUI dialogs, the document loader and descriptor
  cache), checked against the App Connect spec.
- Corrected stale code comments: the shared-collection reader's
  undecryptable-envelope wording now names pre-epoch legacy envelopes (a share
  escrows the reader into every existing epoch), and
  `checkGrantsForCollections`'s JSDoc no longer claims public collections get an
  add-only action set.
- Strengthened the wallet-core counterpart suite: the app-key credential is now
  also located and parsed inside a wallet-core-composed, DIDAuth-signed response
  VP that `verifyLoginPresentation` accepts, and the shared-collection tests
  derive the wallet-side recipient with was-client's real
  `x25519RecipientFromDidKey` instead of a local mirror of it.
- Tightened both new suites further: the composed-VP test asserts the
  `appConnect: { firstRun }` member and an embedded grant survive signing
  (`grantsOf` recovers the grant), derives the wallet holder with wallet-core's
  `agentsFromSeed`, and replaces a vacuous locate assertion; the
  shared-collection rosters carry was-client's real recipient `type` instead of
  a hardcoded literal, so a recipient-type migration fails the suite.
- Removed the unused `@interop/x25519-key-agreement-key` devDependency (it still
  arrives transitively).

## 0.13.0 - 2026-08-12

### Breaking

- Ported to the App Connect `appUrl` profile
  (`https://w3id.org/byoe/app-connect/v1`, the profile handle the credential's
  hosted context URL names). `WasAppConfig.appUrl` -- the application's
  canonical URL, absolute, fragment-less, and same-origin with the app's live
  browser origin -- replaces `credential: { credentialType, vocabBase }`; the
  `SeedCredentialConfig` type is gone. App identity is scoped to the triple
  (user, origin, `appUrl`).
- The app-key credential's `type` is the fixed two-entry array
  `['VerifiableCredential', 'AppKeyCredential']`, its `@context` is
  `['https://www.w3.org/2018/credentials/v1', 'https://w3id.org/byoe/app-connect/v1']`
  (a hosted context, no inline term object and nothing interpolated from a
  vocabulary base), and `credentialSubject` carries `appUrl` alongside `id`,
  `seed`, and `origin`.
- `findSeedCredential({ presentation, appUrl })` locates by the
  `credentialSubject.appUrl` claim alone; the `AppKeyCredential` marker type is
  deliberately NOT required there, so a wrong credential surfaces as a parse
  error rather than as "the wallet returned nothing".
- `parseSeedCredential({ credential, origin, appUrl })` enforces the spec's six
  parse checks in order: marker type, exact `appUrl` match, self-issue, exact
  `origin` match, a seed decoding as base64url-no-pad to exactly 32 bytes, and
  the seed-to-subject DID binding.
- `issueSeedCredential` takes
  `{ seed, origin, appUrl, appName, documentLoader }`.
- A public collection's allowed actions are the full vocabulary
  `GET, HEAD, POST, PUT, DELETE`, the same as a private collection's: published
  content is still the application's own data, and un-publishing and revision
  are data management like any other write. `PUBLIC_ACTIONS` is removed;
  `actionCeiling` returns the full vocabulary for both classes; requesting
  `PUT`/`DELETE` on a public collection no longer throws. `RW_ACTIONS` is
  ordered as in the spec table (`GET, HEAD, POST, PUT, DELETE`).
- `getClientId` is renamed `getWriterId`, `useSession().clientId` is
  `.writerId`, and the LWW payload field and localStorage key are `writerId`. A
  writer id is an unkeyed, clearable attribution label, never an identity; the
  keyed identity is the app key. `getWriterId` adopts a value left under the old
  `<prefix>clientId` key once and removes it, so an existing install keeps its
  id -- but payloads already stored with a `clientId` field lose their LWW
  tiebreaker and fall back to the `updatedAt` comparison.

### Changed

- The login flow serializes `appUrl` once, against the app's live browser origin
  (the same value it sends as the request `domain`), and uses that one string
  for the request, the credential lookup, and the parse check. A configured
  `appOrigin` that differs from the live origin is warned about and is not used
  as the bind.

### Added

- Counterpart tests running both halves of the contract against
  `@interop/wallet-core`'s real implementation: the built VPR is accepted by
  `appConnectRequestOf`, a credential minted by `mintAppKeyCredential` is
  located and parsed, and a legacy pre-`appUrl` credential run through
  `findLegacyAppKeyCredential` + `reissueAppKeyCredential` still recovers the
  same controller DID.

## 0.12.0 - 2026-08-11

### Changed

- Requires `@interop/was-client` >= 0.34.
- `createWasSyncPort` now delegates to was-client's own `createWasSyncPort`
  (built with `mapAuthErrors: true`) instead of hand-building requests; it still
  returns a `WasSyncBasePort`, with `get` supplied by `withFeedMasterRead`.
- WAS URL grammar is imported from `@interop/was-client/paths` (`spacePath`,
  `collectionPath`, `collectionItems`, `resourcePath`, `toUrl`,
  `rootCapability`); the local `collectionPath` in `grants.ts` is gone.
- `publicUrlFor` builds its URL through the shared path builders, fixing a
  double slash when the server URL ends in `/` and rejecting reserved and
  dot-segment ids.
- `WasSyncAuthError`, `WasSyncConflictError`, and `errorMessage` are now
  re-exported from `@interop/was-client` rather than declared locally; the
  exported names are unchanged.
- `SyncCheckpoint` is an alias of was-client's type, and `MasterState` extends
  was-client's (adding the required `deleted` flag, and picking up `createdBy`).

## 0.11.1 - 2026-08-10

### Breaking

- Emit the renamed App Connect descriptor type IRIs:
  `https://w3id.org/byoe#private-collection` (was `byoe#collection`) and
  `https://w3id.org/byoe#shared-wallet-collection` (was
  `byoe#shared-collection`), per the 2026-08-10 spec rename. No dual-emit or
  dual-read tolerance: logging in requires a wallet that resolves the new IRIs.

## 0.11.0 - 2026-08-10

### Breaking

- Epoch-from-birth (`@interop/was-client@0.32` / `@interop/wallet-core@0.24`): a
  private collection's cipher now only exists from an epoch-bearing `encryption`
  descriptor; the single-recipient cipher path is gone. A collection with no
  descriptor yet opens behind a fail-closed placeholder
  (`createUnprovisionedDocCipher`, exported along with `hasKeyEpochs`) that
  refuses writes and treats reads as unknown-epoch until a live descriptor read
  swaps in the real cipher.
- The key-epoch wire header is now `Key-Epoch` (was `WAS-Key-Epoch`); requires a
  server release that reads the new spelling.
- `createDescriptorCache` takes a required `controller` DID and stamps the
  persisted blob with it: a cache bound to a different controller reads as
  empty, so a login under a new controller never builds ciphers from another
  identity's cached descriptors.
- `provisionDevGrants` creates private collections with
  `encryption: { scheme: 'edv' }` plus a first key epoch (the app identity KAK
  as sole recipient), and `collections` entries accept
  `string | { id, visibility }`.

### Added

- `readRemoteDescriptors({ parsed, zcapClient, collections })`: the login-time
  read that completes the descriptor cache before the connected replica opens.
- The anonymous replica mints its own one-epoch descriptors at local birth
  (persisted beside the anon seed and wiped with it), so local-only data is
  epoch-sealed the same way connected data is.

### Changed

- Register the BYOE App Connect context (`byoe-context`, now `^0.3.0` with the
  `appUrl` term) directly on the document loader, instead of relying on
  `@interop/security-document-loader` bundling it; update to
  `@interop/security-document-loader@10` (which no longer bundles it).

### Fixed

- `logout` and `clearLocalData` now ride the serialized boot/destroy lifecycle
  chain. Previously a logout clicked during the StrictMode remount churn after a
  reload (boot -> destroy -> boot) ran its teardown and fresh-local re-open
  concurrently with the queued boot's hot restore -- the two open/teardown
  sequences on the process-wide holder could deadlock the re-open (the logout
  never resolved and the app never returned to the login page), or the boot
  could resurrect the session the logout had just torn down.

## 0.10.0 - 2026-08-09

### Breaking

- `checkGrants` takes `collections` as `GrantRequestCollection[]` (id +
  visibility) instead of `string[]`, so the required actions can be capped at
  each collection's class ceiling.
- `buildAppConnectVpr` no longer defaults `actions` to `RW_ACTIONS`: when
  omitted, each collection now requests exactly its class ceiling. An explicit
  `actions` set naming an action above a requested collection's ceiling (or an
  empty set) throws at build time as a configuration error.

### Fixed

- Public collections no longer fail login against a conformant wallet: a
  `visibility: 'public'` collection is requested with at most the add-only set
  (`GET`, `HEAD`, `POST`) and its required actions are capped at that ceiling,
  so the add-only grant the wallet returns now validates instead of being
  rejected over `PUT`/`DELETE`. Added `PUBLIC_ACTIONS` and `actionCeiling`
  exports.

## 0.9.0 - 2026-08-06

### Breaking

- `AuthState.accessExpired` removed: it was always `status === 'reconnect'`.
  `useSession()` and `useReconnect()` still return `accessExpired`, now
  computed.
- `AuthState.authenticating` removed: it always moved with `phase`, which is now
  the single source of truth for a login in flight. `useSession()` and
  `useLogin()` still return `authenticating`, computed as `phase !== null`.
- `initAppSession` removed -- call `deriveIdentity` (which now enforces the
  32-byte master-seed rule the wrapper used to add).
- `createSyncController` removed -- use
  `new SyncController({ collections, sync })`.
- The wallet-side request types are no longer exported: `WalletAPIMessage`,
  `IVPOffer`, `IVPRequest`, `IQueryByExample`, `IZcapQuery`, `WalletResponse`,
  `WalletRequestProfile`. The relying-party types this library emits and
  consumes (`IVPRDetails`, `IVPRQuery`, `IDIDAuthenticationQuery`,
  `IAppConnectQuery`, `IAppConnectCapabilityQuery`, `ICapabilityQueryDetail`)
  stay.
- `useSyncStatusStore().statuses` is keyed by the registry's logical collection
  `key` instead of the WAS collection id (two entries may share one id, and
  every other layer routes on `key`).

### Fixed

- `WasAppConfig.storageKeyPrefix` now actually reaches the LWW `clientId`
  resolution: `createAuthStore` resolves the id once from the configured prefix,
  exposes it as `AuthState.clientId` / `useSession().clientId`, and the adoption
  repair stamps with that same id. Previously the config field was inert --
  internal stamps always used the default `was-react:` prefix, so a configured
  prefix forked the install's tiebreak identity (and the documented migration
  affordance silently did nothing).

### Changed

- Identity assembly (signer, `ZcapClient`, the Ed25519-to-X25519 conversion, key
  resolver) now comes from `@interop/wallet-core/identity`'s
  `agentsFromKeyAgent`, so the conversion both sides of a share must agree on
  has one implementation; only the pinned derivation inputs (seed bytes,
  `keyName`) stay local. `@interop/x25519-key-agreement-key` is no longer a
  runtime dependency.
- `getClientId` no longer throws in an environment without `localStorage`; it
  falls back to a process-stable unpersisted id.
- Reuse `@interop/was-client/sync` primitives (`isEncryptedEnvelope`,
  `errorStatus`, `formatEtag`, `parseEtag`, the `Json` type) instead of local
  copies; the package's own export names are unchanged.
- Performance: the session bootstrap reads each private collection's description
  once instead of twice, builds per-collection ciphers and opens
  shared-collection readers concurrently, and login derives the master identity
  once (`parseSeedCredential` now returns the derived `IdentityAgents`).
  `countEntities` uses RxDB's `count()` instead of materializing every row, and
  the local-data and adoption probes run their per-collection work in parallel.
- Performance: conflicting rows in one push batch now share a single
  changes-feed read via a per-batch master-state cache, instead of each
  triggering its own full feed walk.
- `SharedCollectionReader` decrypts fast-path pages concurrently; its
  once-per-reader epoch refresh is promise-memoized so concurrent decrypts after
  a key rotation share one descriptor re-read (previously only the first would
  recover).
- Encryption-descriptor acquisition and the unknown-epoch refresh now run on
  `@interop/wallet-core/descriptors` instead of hand-rolled copies:
  `SharedCollectionReader` builds a `createRefreshingEdvDocCipher`, `LocalStore`
  drives one `DescriptorRefreshPolicy`, and the offline descriptor cache is an
  `EncryptionDescriptorCache` over the session store (`createDescriptorCache`).
  Descriptor reads go through a new `remoteDescriptorSource`, which invokes the
  per-collection delegated zcap.
- `LocalStore`'s unknown-epoch descriptor refresh is now spent once per
  collection per SESSION rather than once per decrypt call, so an envelope no
  descriptor will ever route cannot drive a description read per resource;
  concurrent decrypts of the same collection share that one re-read. A fresh
  descriptor installed by the sync bootstrap (`applyRemoteDescriptor`) re-arms
  it. `LocalStore.setEpochRefresher(fn)` is replaced by
  `setDescriptorSource({ collectionEncryption })`.
- A mid-session revoke on a shared collection is now reported by the ordinary
  skip warning for an undecryptable resource; the separate "could not refresh
  its key-epoch roster" warning is gone. `list()` still degrades to the subset
  it can decrypt.
- Internal dedup: one shared App Connect round trip for login and reconnect, one
  store-teardown path (`deactivateStore({ deleteDb })`), one `bodiesEqual` /
  wire-field copier / scalar-or-array helper, a shared `collectionPath` URL
  builder, a typed non-clearing `peekAppSession` read for reconnect, and an
  internal MUI `ConfirmDialog` frame behind the three dialogs.
- The sync bootstrap announces collection descriptions only for collections the
  app registered, instead of for every granted id.
- Docs: fixed stale `urn:was:` IRIs and a stale `deviceId` mention in
  `config.ts` JSDoc (the LWW tiebreak field is `clientId`).
- Docs: README and ARCHITECTURE examples use the `https://w3id.org/byoe#`
  descriptor and claim IRIs instead of the retired `urn:was:` spellings, and
  ARCHITECTURE links the App Connect companion spec
  (https://github.com/interop-alliance/app-connect-spec).
- Update to latest interop deps.

## 0.8.3 - 2026-08-05

### Fixed

- **Security**: `verifyLoginPresentation` now rejects a response VP whose
  presentation-level proof set contains any non-`authentication` proof, and
  checks the challenge/domain on every proof. Previously the challenge check
  could bind to a proof the crypto layer never signature-verified (proof
  ordering decided which purpose was enforced), so a captured VP could be
  replayed against a fresh challenge by appending an unsigned authentication
  proof. The root fix lands in `@interop/verifier-core` (its presentation
  purpose is now selected by scanning all proofs, not `proof[0]`); the check
  here fails closed even against an older verifier-core.
- **Security**: `reconnect` now compares the re-granted `serverUrl` / `spaceId`
  against the live session's persisted record and refuses on a mismatch, instead
  of silently re-pointing the encrypted replica at a different server or space.
  Switching storage requires an explicit logout + login.
- A shared-only app (`collections: []`, non-empty `sharedCollections`) now
  completes login when the user declines the share: the wallet's empty grant set
  is accepted with a warning and no reader is opened, instead of the whole login
  failing with "The wallet returned no storage grants."
- The LWW conflict handler now distinguishes "no LWW stamp" (a tombstone or
  absent body) from "could not decrypt": an undecryptable side is never scored
  as the loser (an undecryptable master is adopted rather than overwritten by an
  older local payload; an undecryptable local row is re-asserted rather than
  dropped), and each case is logged. Its decrypt also routes through the
  epoch-refreshing path, so a master written under an unseen key epoch recovers
  via a descriptor re-read instead of failing.
- Two push-path defects that dropped writes while reporting success: clearing a
  resource's `custom` metadata is now written to the server (a `/meta` PUT of
  the cleared state) instead of silently skipped, and a `/meta` 412 that follows
  a successful content write now preserves the acked content version instead of
  discarding it (which left the local row's `If-Match` stale).
- A single resource-scoped `/meta` 404 (a metadata push racing a remote delete)
  no longer flips the whole session to "access expired": the row is corroborated
  against the changes feed and resolved as remote-deleted, and the session
  escalates only when the feed read is itself denied.
- `remotePayloadWins` (LWW) now compares `updatedAt` chronologically (parsed to
  epoch ms) instead of lexically, so mixed ISO-8601 precision (`...05Z` vs
  `...05.400Z`) and offset forms (`+00:00`) order correctly; unparseable stamps
  lose to parseable ones, with a documented lexical fallback when neither
  parses.
- Content pushes now send the `WAS-Key-Epoch` header: the `DocCipher` seam no
  longer drops the `epoch` the was-client cipher returns, the local row and the
  `changes`-feed wire type carry it, and `putContent` stamps it -- so a
  spec-following third-party reader gets the correct pre-decrypt key hint.
- `patchFromChange` captures the local store before its decrypt `await` and
  bails when the holder was closed or swapped across it, so a pull burst in
  flight across a logout/login teardown neither throws an unhandled rejection
  nor writes the previous session's data into the new replica.
- A failed sync bootstrap now surfaces: the session records a "Sync failed to
  start" error and the per-collection statuses report `error` in the sync
  rollup, instead of resolving silently as "Local only"; the controller's
  failure path no longer latches its terminal stop, so sync can be started again
  on the same session.
- Two login-path races: the adopted-anonymous-replica cleanup now runs after the
  connected status lands and is best-effort (a cleanup failure no longer leaves
  the session reporting `local` over a live connected session), and the
  `adopt: 'merge'` collect decides off a pre-login state snapshot (a provider
  unmount while the wallet popup is open no longer makes the merge silently
  adopt nothing).
- The proactive grant-expiry warning fires on the first check: the immediate
  near-expiry probe is deferred until after the caller has set
  `status: 'connected'`, so restoring a session already inside the warning
  window raises the reconnect banner immediately instead of waiting a full watch
  interval.
- A share revoked mid-session now degrades its `SharedCollectionReader` with a
  warning (skipping the resources it can no longer decrypt) instead of rejecting
  the whole `list()` and discarding already-decrypted resources.
- The CHAPI path no longer dereferences `import.meta.env` unguarded, so non-Vite
  consumers (webpack / Rspack / Parcel, Node SSR) no longer crash at login;
  without it the e2e bridge simply stays off (Vite is not a required toolchain,
  now stated in the README).

## 0.8.2 - 2026-08-03

### Fixed

- `connectWithGrants` now runs on the same serialized lifecycle chain as
  `boot`/`destroy`, with a connected-state guard. Fired from a mount-time effect
  (its typical call site, e.g. a dev-connect hook), it raced a dev-mode
  remount's queued destroy/boot pair, which tore down and re-opened the
  anonymous replica underneath the in-flight connect -- nondeterministically
  dropping the local data the `adopt: 'merge'` collect was meant to carry into
  the connected replica. `login` deliberately stays off the chain: it blocks on
  a wallet popup that must not stall a queued destroy, and being user-driven it
  never runs as part of the mount race.

### Changed

- Update to `@interop/wallet-core@0.16.0` and `@interop/was-client@0.26.0`
  (additive upstream releases; no API changes here).

## 0.8.1 - 2026-08-03

### Changed

- Update to `byoe-context@0.2.0` (adds the `LoginCredential` and
  `preferredUsername` terms to the App Connect context).

## 0.8.0 - 2026-08-01

### Changed

- **BREAKING**: All BYOE-layer wire vocabulary moves from the retired `urn:was:`
  / `urn:freewallet:vocab#` schemes to the shared `https://w3id.org/byoe#`
  namespace. The app-key credential's marker type and claim terms now expand to
  `https://w3id.org/byoe#AppKeyCredential` / `#seed` / `#origin` (imported from
  the published `byoe-context` package), and `buildAppConnectVpr` emits the
  `https://w3id.org/byoe#collection` / `#public-collection` /
  `#shared-collection` descriptor types. Matching is literal string equality on
  both sides, so this release pairs with the wallet-side renames
  (`@interop/wallet-core` 0.9.0 and the matching Freewallet build); token
  spellings and JSON keys are unchanged.

## 0.7.0 - 2026-08-01

### Changed

- **BREAKING**: Renamed the collection-encryption "marker" surface to
  "encryption descriptor", following the WAS spec's wording (the object is the
  `encryption` member of a Collection Description, so "descriptor" names it by
  what it describes). Renamed exports: `LocalStore.applyRemoteMarker` to
  `applyRemoteDescriptor`, `LocalStore.open({ markers })` to `{ descriptors }`,
  `SeedStore.saveMarkers` / `loadMarkers` to `saveDescriptors` /
  `loadDescriptors`, `startWasSync({ onMarkersFetched })` to
  `{ onDescriptorsFetched }`, and `activateSession({ markers })` to
  `{ descriptors }`. `MarkerResult` -- the outcome type shared by
  `markCollectionEncrypted()` and `declareCollectionIndexes()` -- is renamed to
  the neutral `DeclarationResult` rather than an encryption-specific name, since
  the indexes declaration has nothing to do with encryption. The persisted
  offline-cache record key in the session IndexedDB moves from `markers` to
  `descriptors` with no migration: an orphaned cached entry is refetched on the
  next connected sync. The `AppKeyCredential` marker type and the App Connect
  response marker are different senses of the word and are unchanged.
- Bumped `@interop/wallet-core` to `^0.8.0` and `@interop/was-client` to
  `^0.23.0`, the releases carrying the same rename upstream (the wire format is
  unchanged -- the word never crosses the wire).

## 0.6.0 - 2026-08-01

### Added

- did:webvh resolution in the app document loader. `createDocumentLoader` now
  composes `@interop/security-document-loader`'s default did:key + did:web
  resolver set with the `@interop/did-method-webvh` driver, so a wallet may
  present its Login With Wallet VP holder as a did:webvh (proof verification
  method `<did:webvh>#<key>`) and `verifyLoginPresentation` resolves it.
  Resolution is VERIFIED resolution -- the driver's default history-log verifier
  (hash chain + entry proofs) is active, and a tampered or forged `did.jsonl`
  fails closed. did:key / did:web resolution is unchanged, and did:webvh DIDs on
  `localhost` resolve over plain http for local dev, matching did:web.
  Backward-compatible: apps should pick up this release before any wallet
  switches its VP holder to a did:webvh.

### Fixed

- README's "Login flow" section documented the removed three-popup flow (probe /
  store-key / request-grants); rewritten to the shipped single-popup App Connect
  exchange, including the `WalletUnsupportedError` fail-closed path and the
  `{ firstRun }` login result.
- The login-flow test wallet's `appConnect` context term now uses the IRI the
  real wallet emits (`urn:freewallet:vocab#appConnect`), so the fixture drifts
  with the actual wire term instead of coining its own.

## 0.5.0 - 2026-07-30

### Added

- Read-and-decrypt support for SHARED collections: one of the wallet's own
  encrypted collections that the user chooses to let this app read. Declare them
  in the new `WasAppConfig.sharedCollections` registry (`{ key, id }`, validated
  by `validateSharedCollections`); they are read-only by construction -- never
  replicated into RxDB, never written to, no local replica, and excluded from
  the sync bootstrap's collection-description writes. Each covered collection
  gets a `SharedCollectionReader` (`list` / `get`), exposed on the auth store as
  `sharedCollections` and through the new `useSharedCollection(key)` hook.
  `list()` pages the WAS `changes` feed, which returns whole pages of documents
  with their (undecrypted) bodies, so reading a collection costs one request per
  page rather than one per resource; tombstones are skipped so the result is the
  live set. A backend without the `changes-query` feature falls back to a
  listing plus per-resource reads, with a one-time warning.
  `SHARED_CHANGES_PAGE_SIZE` is exported and `SharedCollectionReader.open` takes
  an optional `pageSize`.
- `buildAppConnectVpr` takes `sharedCollections` (WAS collection ids) and
  appends one `urn:was:shared-collection` capability query per id with the new
  read-only `SHARED_ACTIONS` (`GET`/`HEAD`) set -- an app never requests writes
  on a wallet collection. As with `urn:was:public-collection`, a wallet that
  predates the descriptor type reports it unsatisfiable and the request fails
  closed, rather than degrading to a ciphertext-only read that would look like
  corrupt data.
- `IdentityAgents` now carries `keyAgreementKey` + `keyResolver`: the app's
  IDENTITY key-agreement key, the X25519 twin of its `did:key` controller. That
  is the recipient identity a wallet writes into the key-epoch roster of any
  collection this app reads, so the key is derived on both sides and never
  travels on the wire.

### Changed

- **Breaking:** every encrypted collection -- app-provisioned as well as shared
  -- is now read and written with the app's IDENTITY key-agreement key, derived
  once per session. `LocalStore.init` takes `keyAgreementKey` + `keyResolver`
  (`IdentityAgents`) in place of the master `seed`, and no longer derives a key
  per collection; `rebuildCipher` reuses the same key material. One rule now
  covers every key-epoch roster entry: a recipient is the X25519 (Montgomery)
  twin of a controller `did:key`, whether the recipient is an app or a person. A
  share is grantable to an arbitrary `did:key` where no app seed exists, so the
  recipient has to be derivable from the controller DID alone -- which is why
  unification could only go this way. It also gets a client secret out of the
  wallet's grant path: the wallet no longer needs the app seed to provision an
  encrypted app collection.

  What this costs, stated plainly: the HKDF domain separation between
  collections is gone, and one key now reads every collection the app touches.
  With key epochs that key only unwraps an epoch secret rather than being the
  content key, and the seed it derives from is persisted in the same process
  anyway, so the separation bought less than it looks like.

  This is a data-migration event for any app that already stored rows under the
  old per-collection keys: existing envelopes were sealed to a key that is no
  longer derived, so they will not decrypt.

- **Breaking:** `deriveCollectionKeys`, `DEFAULT_KAK_HANDLE`, and
  `CollectionKeys` are no longer re-exported from `@interop/was-react` (nor from
  `identity/agents.js`). The derivation itself is unchanged and still lives in
  `@interop/wallet-core/identity`; it simply has no caller here. Import it from
  there if an app still needs it.
- **Breaking:** `startWasSync` now resolves to
  `{ remoteStore, sharedCollections }` rather than the remote store alone, so
  the bootstrapped shared-collection readers reach the caller.
- **Breaking:** every app-key credential now carries a shared `AppKeyCredential`
  marker type (`urn:was:AppKeyCredential` -- one stable IRI for every app,
  defined in the inline `@context`), and `parseSeedCredential` requires it. The
  marker makes "presents as an app key" a term check rather than a shape
  heuristic, which is what lets a wallet refuse a foreign app key at store time
  instead of storing it and quietly ignoring it. It is a self-declaration, not
  evidence -- a planted credential controls its own `type` array -- so the
  seed-to-DID binding remains the only check that authenticates. Requiring it on
  both sides means a credential can only reach the delegation path by carrying
  it. An app key issued by an earlier version (or a wallet that predates the
  marker) no longer parses; `findSeedCredential` still finds it by the app's own
  type, so this surfaces as a visible parse error rather than a silent re-mint.
  `APP_KEY_CREDENTIAL_TYPE` is exported.
- **Breaking:** an app key's `seed` and `origin` claims now carry shared
  `urn:was:seed` / `urn:was:origin` IRIs instead of ones namespaced under the
  app's `vocabBase`: they mean the same thing in every app, so two apps' keys no
  longer make semantically identical claims under different IRIs. The JSON shape
  is unchanged (`credentialSubject.seed` / `.origin` keep their keys);
  `vocabBase` now namespaces only the app's own type term.

## 0.4.0 - 2026-07-23

### Added

- Multi-recipient (key-epoch) read support for app-provisioned encrypted
  collections. `WasRemoteStore.readCollectionEncryption` reads a collection's
  encryption marker via its delegated capability; on login/reconnect each
  private collection's marker is fetched and cached (persisted alongside the
  session seed) so an offline or hot-restored session can build its epoch-aware
  ciphers without a live read.
- A private collection's document cipher now routes through the marker: a
  multi-recipient envelope decrypts from the app's own deterministic
  per-collection key (the same key registered as its roster entry), while a
  pre-epoch envelope keeps decrypting through the single-key path (no
  migration). Writes on an epoch collection stamp the current epoch. A decrypt
  that meets an unseen epoch (a rotation on another device) re-reads the marker
  once and rebuilds the cipher; a marker whose epoch differs from the one a
  collection opened with rebuilds its cipher so later writes use the current
  epoch.

### Changed

- `WasRemoteStore.markCollectionEncrypted` now reads the collection description
  first and skips the bare-marker PUT when any `encryption` block is already
  present, so it can never overwrite an existing epoch roster (reported as
  `ok` + `skipped`). It becomes a no-op fallback for servers/wallets that did
  not provision a roster.

## 0.3.6 - 2026-07-23

### Changed

- `deriveCollectionKeys` / `CollectionKeys` / `DEFAULT_KAK_HANDLE` now delegate
  to `@interop/wallet-core/identity` (moved there verbatim; re-exported here, so
  existing imports keep working).

## 0.3.5 - 2026-07-22

### Changed

- Improve diagnostics when a wallet presentation fails verification: the thrown
  error now includes each failing check's problem details (not just the check
  names), and the full presentation plus the failing check results are logged to
  the console for debugging.

## 0.3.4 - 2026-07-22

### Fixed

- Connecting (via `login` or `connectWithGrants`) with the merge-adoption
  default could fail for apps with many collections: the adoption collect opened
  a fresh handle on the anonymous replica while the process-wide holder was
  still open, so both replicas' collections were open at once -- and the
  connected replica's open then tripped RxDB's process-wide open-collections cap
  (error COL23; free RxDB allows 13, so any app with more than 6 collections
  could not connect). The connect transition now tears the anonymous holder down
  before collecting the adoptable payloads, so at most one replica's collections
  are open at any moment; a collect failure at that point re-opens the anonymous
  replica and rethrows, leaving `local` intact.

## 0.3.3 - 2026-07-22

### Changed

- Update to latest `@interop/` deps, convert private fields from `_` to `#`
  prefix.

## 0.3.2 - 2026-07-20

### Fixed

- Revoked/expired storage access is now detected against real WAS servers. A WAS
  server masks a failed capability invocation as `404` ("URL not found or
  invalid authorization") rather than `401`/`403`, so an unauthorized caller
  cannot probe which resources exist -- which meant the sync port's 401/403-only
  mapping never recognized a revoked grant, and the session stayed `connected`
  (no reconnect banner) with only a generic sync error showing. The port now
  also maps a `404` on the query (pull) and content/meta write paths to
  `WasSyncAuthError`: on those paths the invoked collection is known to exist,
  so a `404` means the invocation itself was rejected. A `404` on delete still
  counts as the already-absent success.

## 0.3.1 - 2026-07-20

### Fixed

- Revoked/expired storage access was not detected on live replication errors:
  RxDB serializes a pull/push handler's thrown error to plain JSON before
  wrapping it, so the typed `WasSyncAuthError` instance never appears in the
  emitted error graph and `isAuthError` returned false -- the session stayed
  `connected` (no reconnect banner) while the sync status chip showed an error.
  `isAuthError` now also matches the serialized error by `name`.

## 0.3.0 - 2026-07-20

### Changed

- **BREAKING**: Renamed the hook returned by `defineDocumentApp` from
  `useDocument` to `useAppDocument`.
- **BREAKING**: Renamed `deviceId` to `clientId` across the board (an SPA is a
  client, not a device): the LWW tiebreak field stamped into every synced
  payload, the `getDeviceId` helper (now `getClientId`), and the
  `<prefix>deviceId` localStorage key (now `<prefix>clientId`). No migration:
  rows already stored or synced under `deviceId` no longer carry a recognized
  LWW stamp, and each install mints a fresh client id on first load after the
  upgrade.

## 0.2.2 - 2026-07-20

### Removed

- **BREAKING**: Removed the `was-provision-dev-grants` CLI (the package `bin`
  entry and `src/dev/cli.ts`). Use the programmatic `provisionDevGrants` from
  `@interop/was-react/dev` instead.

## 0.2.1 - 2026-07-20

### Changed

- `ClearDataDialog` warning text is now mode-aware: once connected, it explains
  that only the device copy is erased and the data already synced to the Web
  Space survives (reconnect to bring it back), instead of the local-only "cannot
  be recovered" warning, which was inaccurate in that state.
- `clearLocalData` now also clears the persisted connected session (as `logout`
  already did), so clearing data while connected fully disconnects -- the next
  page load lands in `local` mode instead of silently reconnecting and syncing
  the cleared data back down.

## 0.2.0 - 2026-07-20

### Changed

- Login With Wallet is now a single CHAPI popup ("App Connect") instead of the
  former three-popup (probe, store, grants) first-run flow. One `get` carries a
  new `AppConnectQuery` (app name + seed-credential naming + the collection
  grant requests); the wallet matches an existing app key or mints a fresh one
  internally and returns the app-key credential together with the delegated
  zcaps in one signed response VP. `buildSeedProbeVpr` and `buildGrantsVpr` are
  replaced by `buildAppConnectVpr`, and the CHAPI store step is gone
  (`chapiStore` and `wrapCredentialForStore` removed). The `login()` outcome
  contract is unchanged (`{ firstRun }` on success, `null` on cancel, reject on
  error); `firstRun` is now read from the wallet-provided
  `presentation.appConnect.firstRun`.
- The `LoginPhase` values collapse from `probing` / `storing-key` /
  `requesting-grants` / `verifying` to just `connecting` / `verifying`.

### Requirements

- This release requires a wallet that understands `AppConnectQuery` (Freewallet
  with App Connect support). An older wallet cannot satisfy the query and
  returns no app key; that fails closed with a clear `WalletUnsupportedError`
  ("Your wallet does not support App Connect yet; update Freewallet to log in.")
  rather than a generic verification error.

## 0.1.12 - 2026-07-20

### Fixed

- Fixed a race where a fast unmount/remount of the session provider (for
  example, React dev-mode double effects) could leave the app on a closed
  database handle or an empty-looking hydrate. `boot` and `destroy` are now
  serialized inside the session store, so a teardown fired while a boot is still
  opening/hydrating waits for that boot to settle before running, and a boot
  queued after it re-opens cleanly -- the open/hydrate/sync bring-up can no
  longer overlap a teardown.

### Changed

- The sync-status chip no longer labels the no-replication state "Offline"
  (local-only mode is not offline). The rollup states now read `Local only`,
  `Sync error`, `Syncing`, and `Synced`, with tooltips clarifying that
  local-only data stays on the device and the other states are connected to
  storage. The `SyncStatusChip` `data-sync-state` attribute now emits the
  machine state key (`offline`/`error`/`syncing`/`synced`) directly, so it is
  stable regardless of the human-readable copy.
- The app-key credential now carries a top-level `name` and `description` so a
  wallet renders it as, for example, "Text Editor app key" with a sentence
  explaining what the key is for, instead of a generic "Verifiable Credential".
  `issueSeedCredential` gains a required `appName` option supplying the
  human-readable app name.

## 0.1.11 - 2026-07-20

### Changed

- `login()` now rejects on a genuine failure instead of swallowing it. It still
  records the message in `error` (so the UI state reflects the failure), but the
  returned promise rejects rather than resolving. On success it resolves with
  `{ firstRun }` (`firstRun` is true when this login created a brand-new app
  key, so an app can show a "connected for the first time" confirmation); on a
  user cancellation of a wallet popup it resolves with `null` and leaves no
  error. The tier-1 `useDocument().connect()` facade returns the same outcome.

### Removed

- The `wasServerUrl` app-config option (on `WasAppConfig` and
  `defineDocumentApp`) and the corresponding `expectedServerUrl` grant check.
  Grants are no longer required to target a pre-configured server URL: the
  wallet decides where the user's Space lives and the sync layer derives its
  target from the grants. Grants are still verified on their own terms
  (controlled by the expected DID, cover the requested collections, unexpired,
  single origin and single space).

## 0.1.10 - 2026-07-19

### Added

- Server-side equality queries on public collections. `WasCollectionConfig`
  grows an optional `indexes` field declaring the queryable content attributes
  (e.g. `indexes: ['author', 'inReplyTo']`); `validateCollections` rejects
  declarations fail-closed (public collections only -- the encrypted
  blinded-index path is not yet supported -- plus empty/duplicate names and
  diverging declarations for one WAS collection id). The sync bootstrap
  best-effort announces the declaration in the collection description
  (`WasRemoteStore.declareCollectionIndexes`, a sibling of the encryption marker
  PUT).
- `EntityStore.query({ equals, limit?, cursor? })`: runs one equality query
  against the collection on the server and returns `{ docs, hasMore, cursor? }`
  without touching the in-memory Map. Multiple `equals` attributes AND together;
  values are string equality only. On the wire it is the cacheable
  `filter[attr]=value` GET on the collection list endpoint with filter
  attributes emitted in sorted (canonical) order, signed with the granted
  collection capability (`WasRemoteStore.queryCollectionByEquality`; page type
  `EqualityQueryPage`).
- A process-wide holder for the per-session delegated remote store
  (`setRemoteStore` / `requireRemoteStore` / `hasRemoteStore` /
  `clearRemoteStore`), installed by `createAuthStore` once background sync
  bootstraps and cleared on logout/teardown, so entity-store verbs that need the
  server (`query`) can reach it. `LocalStore` exposes `collectionConfig(key)`
  (the registered `WasCollectionConfig` for one collection key).
- `publicUrlFor({ collectionKey, id })` (and the underlying
  `WasRemoteStore.publicUrlFor({ collectionId, id })`): composes the stable,
  world-readable resource URL for a document in a public collection -- the share
  link an unauthenticated reader fetches, for the publish-copy share pattern.
  Stable across edits because a public collection stores the payload under its
  logical uuid; fails closed on non-public / unprovisioned collections and empty
  ids.

### Changed

- **BREAKING**: The login flow now requests `visibility: 'public'` collections
  with the distinct `urn:was:public-collection` descriptor type, so the wallet
  provisions them plaintext with a public-read policy and renders a
  world-readable consent warning. Wallets that predate the descriptor render
  such a request unsatisfiable (fail-closed) instead of silently provisioning a
  private collection. `buildGrantsVpr` and `LoginConfig` now take
  `GrantRequestCollection[]` (`{ id, visibility? }`, exported) instead of bare
  collection-id strings; apps using `createAuthStore` are unaffected.
- `createDocumentLoader` no longer takes a `wasServerUrl` option: the http
  did:web dev shim is gone, since `@interop/security-document-loader` 9.4.4 (via
  `@interop/did-web-resolver` 6.3.0) now resolves did:web DIDs on loopback hosts
  (`localhost` / `127.0.0.1`, any port) over plain http natively. The loader is
  the plain security loader again.

## 0.1.9 - 2026-07-19

### Added

- Public (plaintext) collections: `WasCollectionConfig` grows an optional
  `visibility` field (`'private'` default | `'public'`). A public collection is
  world-readable and therefore plaintext -- `LocalStore` skips per-collection
  key derivation and stores payloads as-is through a pass-through codec
  (`createPlaintextDocCodec`), the stored resource id is the payload's own
  logical `id` (a stable, shareable resource URL across edits), and the
  encryption-marker PUT is skipped for it during sync bootstrap. Reading an EDV
  envelope out of a public collection fails with a descriptive error instead of
  mis-indexing it.
- `validateCollections()`: fail-closed registry validation (unknown `visibility`
  values; the same WAS collection id registered as both private and public), run
  automatically by `LocalStore.init`.
- End-to-end plaintext sync coverage against an in-process `was-teaching-server`
  (push verbatim public payloads + encrypted private envelopes, marker skip,
  pull into a fresh replica).

### Changed

- `startWasSync` now requires the app's collection registry (`collections`), and
  `WasRemoteStore.fromGrants` accepts an optional one, so the sync bootstrap
  knows which collections are public. `MarkerResult` gains a `skipped` flag.

## 0.1.8 - 2026-07-19

### Added

- `defineDocumentApp()` + `useDocument()`: the "one sandbox document" facade.
  `defineDocumentApp<T>({ appName, appOrigin, document: { collectionId, initial }, credential, ... })`
  builds the complete wiring for an app whose entire model is a single key-value
  document (an Excalidraw-style editor, a game save file): a one-collection
  local-first `WasAppConfig`, the singleton-document store registry, and a typed
  `useDocument` hook returning
  `{ doc, update, status, sync, exportFile, importFile, connect, disconnect, connecting, error }`.
  The facade owns the LWW stamping (app data is wrapped beside
  `updatedAt`/`deviceId`, so app fields can never collide with them), hydrates
  through `LocalStore.hydrateSingleton` (duplicate singleton envelopes reconcile
  to the LWW winner), serializes tagged `was-document/v1` export files, and
  wires `connect()` to the wallet login -- the config registers exactly one
  collection, so the consent screen shows a single legible request and the
  adopt-on-login merge carries the local document into it.
- `EntityStore.upsert(doc)`: persisting insert-or-update over
  `LocalStore.upsertEntity`, for callers that do not track an insert-vs-update
  flag of their own (e.g. a singleton document).

## 0.1.7 - 2026-07-19

### Added

- Local-to-connected adoption: `login()` and `connectWithGrants()` now take
  `{ adopt: 'merge' | 'leave' }` (default `'merge'`). On a merge, data created
  in the anonymous `local` replica is copied into the connected replica before
  its first hydrate and sync start (decrypted with the anonymous cipher,
  re-encrypted with the connected one -- the two replicas derive their keys from
  different seeds), so adopted documents reach the server as ordinary creates on
  first push. Merge policy is last-write-wins per logical uuid, using the same
  `remotePayloadWins` rule replication runs; payloads missing
  `updatedAt`/`deviceId` are stamped at adoption time, and ones that carry them
  keep their original values. After a successful merge the anonymous seed and
  database are deleted (a later logout lands in a genuinely fresh `local`);
  `'leave'` -- and any login cancel or failure -- keeps the anonymous replica
  fully intact.
- `hasLocalData()` store action + `useHasLocalData()` hook: whether the
  anonymous `local` replica holds any documents, the check a login affordance
  runs to decide whether to offer the adoption choice.
- `AdoptDialog` in `./mui`: the pre-login three-way choice (bring my data / set
  it aside / cancel), calling `login({ adopt })` itself.
- `LocalStore.countEntities(key)` (live-row count without decrypting) and static
  `LocalStore.removeDatabase({ dbName, storage })` (delete a closed database by
  name).
- `lwwFields()` is now exported from the sync layer (previously an internal
  helper of the entity store).

### Changed

- `LocalStore.insertEntity` / `updateEntity` / `upsertEntity` are now generic
  over the payload type (`T extends { id: string }`), so typed app documents and
  inline literals pass without tripping excess-property checks.
- `connectWithGrants` and login adoption read the anonymous replica through a
  fresh database handle derived from the persisted anonymous seed, so a
  StrictMode double-boot after a page reload (which can leave the process-wide
  holder as a closed duplicate) can no longer abort the connect.

## 0.1.6 - 2026-07-18

### Added

- Local-first onboarding: with no wallet session, the store now opens an
  encrypted anonymous-seed replica (persisted in `<dbName>-anon`, same
  per-collection key derivation as a connected replica), so an app is fully
  usable before or without connecting a wallet. New `WasAppConfig.onboarding`
  (`'local-first' | 'login-gated'`, default `'login-gated'`, the historical gate
  behavior) and `WasAppConfig.seedLocal` (one-time dev-fixtures hook for a
  brand-new anonymous replica).
- `clearLocalData` action (+ `useClearData` hook): deletes the local replica and
  mints a fresh anonymous seed/DID and replica. Backed by the new
  `LocalStore.remove()`.
- `connectWithGrants({ seed, grants })`: non-CHAPI connect from an explicit
  seed + grant set (dev/test and provisioned-grants paths), driving the same
  connected-state replication path as wallet login.
- New `./mui` dialogs `LogoutDialog` (log out keeping vs erasing local data) and
  `ClearDataDialog` (confirm-and-wipe for local mode).

### Changed

- Breaking: the session store is now a four-state machine, `SessionStatus`
  (`'boot' | 'local' | 'connected' | 'reconnect'`), replacing `AuthStatus` with
  no back-compat alias. `restore()` is renamed `boot()`; a restore hit lands
  `connected`, a miss or error falls to `local` (never a dead login screen), and
  both finish opening + hydrating the replica before leaving `'boot'`.
- Breaking: `logout()` now takes `{ wipe?: boolean }` (default keeps the local
  replica) and lands in a fresh anonymous `local` state instead of navigating to
  a login screen.
- Breaking hook shapes: `useSession()` adds `onboarding` and `authenticating`;
  `useLogin()` returns `{ login, authenticating, phase, error, status }`;
  `useLogout()` returns `(options?: { wipe?: boolean }) => Promise<void>`.
- `ProtectedRoute` is now a thin switch over `onboarding` + `status`; boot is
  kicked off by `WasSessionProvider` on mount. Its fatal-error alert is scoped
  to boot/storage failures, so a failed or cancelled wallet login no longer
  blanks a local-first app.
- Breaking: `parseGrants` requires every delegated grant to be collection-scoped
  (space-scoped targets are rejected), and `ParsedTarget.collectionId` is now
  required.

### Removed

- Breaking (privacy): the automatic read-only whole-space capability query in
  the wallet login request. Apps now request only collection-scoped
  capabilities; no runtime code ever invoked the space grant. The
  `SPACE_READ_REFERENCE_ID` export is gone with it.
- Breaking: `useAppReady` -- "app ready" is now simply `status !== 'boot'`.

### Migration

- No persisted-session back-compat: sessions that fail to restore (including
  older ones carrying a space-read grant) silently land in `local`, or on the
  login path in a login-gated app.

## 0.1.5 - 2026-07-12

### Fixed

- Push path: a `404` on `DELETE` is now treated as success (the resource is
  already absent -- a row created and deleted locally before its first push, or
  deleted remotely first). Previously the 404 rejected the whole push batch,
  which RxDB retried indefinitely, permanently wedging that collection's push
  queue on a phantom tombstone.
- Entity stores: the remote patch path now applies the last-write-wins guard
  before upserting. Patch events decrypt asynchronously, so two events for the
  same doc could apply out of order (or a stale pull echo could trail a newer
  optimistic local write) and leave stale content in the UI; a stale incoming
  payload is now discarded. Docs without the LWW fields (`updatedAt`/`deviceId`)
  keep the previous last-patch-wins behavior.

### Removed

- `EntityStore.hydrated`: the flag was written but never read by any consumer.
  Reintroduce it if a UI ever needs a per-collection "hydration done" signal.

## 0.1.4 - 2026-07-12

### Added

- `LocalStore.upsertEntity()`: inserts the entity when the collection has no row
  for its uuid yet, otherwise re-encrypts it in place (the hydration index is
  the source of truth, so callers need not track an insert-vs-update flag).
- `LocalStore.hydrateSingleton()`: hydrates a singleton collection (at most one
  logical entity) and reconciles duplicate rows -- two devices that each created
  the singleton before syncing -- down to the last-write-wins winner,
  tombstoning the losers so the space converges on one row.
- `LocalStore.envelopeIdFor()`: exposes the hydration index's
  `uuid -> envelopeId` mapping so the sync patch path can tell a tombstone for
  the live envelope apart from one for a stale duplicate.
- `cancelScheduledRehydrates()`: drops every pending debounced re-hydrate;
  called during session teardown so a timer that outlives logout never reaches a
  torn-down store.

### Fixed

- `LocalStore.updateEntity()` no longer throws when the entity's envelope is
  gone (a remote tombstone was pulled mid-edit); it resurrects the entity as a
  fresh create, matching the mutable-head LWW rule (a live local edit beats a
  remote tombstone).
- `patchFromChange()` ignores a pulled tombstone whose envelope id differs from
  the one the entity currently lives in (a reconciled singleton loser or a
  pre-resurrection row) -- previously such a stale tombstone dropped the live
  doc; a debounced re-hydrate that fires after teardown is now a no-op.

### Changed

- Performance: hydration and index building decrypt rows concurrently instead of
  serially (the unlock hot path).

## 0.1.3 - 2026-07-12

### Fixed

- Conflict handling and revision tracking: accepted conditional writes now adopt
  the server's response ETag (previously every update paid a guaranteed 412 and
  deletes never replicated -- tombstones silently resurrected); metadata-only
  edits are compared (`custom`) so concurrent metadata changes no longer
  converge by push order; and the post-412 changes-feed re-read throws a
  retryable error when it exhausts its scan budget instead of fabricating a
  false tombstone on large collections.
- Session lifecycle: `reconnect()` no longer logs the user out on expired grants
  (it reads the seed directly rather than through the expiry-wiping
  `restoreAppSession()`); a failed session activation tears the local store back
  down and surfaces the error through `useAppReady` instead of leaving it
  installed for the next (possibly different) identity; hot restore re-validates
  grant coverage of the configured collections and raises the reconnect prompt
  proactively, while the sync controller skips uncovered collections instead of
  403-looping into a spurious session-expired banner.
- Teardown: `SyncController.stop()` is terminal, and session teardown awaits an
  in-flight sync start, so logging out mid-start no longer leaks an unstoppable
  replication loop; a new `destroy()` action on the auth store, called on
  `WasSessionProvider` unmount, disarms the expiry watch and closes the store
  (persisted session survives), fixing orphaned timers under React StrictMode
  remounts.
- README: entity payloads must carry `updatedAt` and `deviceId` (from
  `getDeviceId()`) on every insert and update -- the last-write-wins pair; the
  Quick start `Note` example now includes `deviceId`.

### Changed

- Performance: the sync pull path coalesces a burst of incoming remote changes
  into one entity-store update per flush (initial sync was O(N^2) Map copies
  plus one re-render per document).
- Reuse and API shape: 401/403 from the sync port now throw a typed
  `WasSyncAuthError` (with shared `errorStatus`/`errorMessage` helpers exported
  from the sync entry); grant-target parsing, response-ETag reading, and
  conditional-write headers now come from `@interop/was-client` (bumped to
  `^0.14.5` -- a reserved sub-endpoint grant like `/space/:id/policy` is no
  longer misread as a collection grant); seed-path base64url/hex codecs come
  from `@scure/base` (new direct dependency); `createWasSyncPort` returns a
  `WasSyncBasePort` without `get()`, which the `withFeedMasterRead` wrapper
  alone provides (the base implementation was unused and broken cross-origin);
  the sync-status precedence rollup moved into the store as `deriveSyncRollup`
  with `useSyncStatus` unchanged in shape.
- Test files colocated under `src/` are no longer compiled into `dist/` (and so
  no longer shipped in the npm package).

## 0.1.0-0.1.2 - 2026-07-10

### Added

- Initial extraction of the reusable "Bring Your Own Everything" (BYOE) React
  plumbing from a production BYOE app.
- CHAPI "Login With Wallet" DID-Auth flow: seed probe, grants request, and
  relying-party response verification.
- Self-issued seed credential: mint, store to, and recover from the wallet, with
  origin and seed-to-DID binding checks; a stable did:key identity and
  per-collection vault keys derived deterministically from the master seed.
- Session lifecycle store plus React provider and hooks (`useSession`,
  `useLogin`, `useLogout`, `useReconnect`, `useSyncStatus`, `useAppReady`): hot
  restore, login, near-expiry reconnect, and logout.
- Encrypted local-first RxDB (Dexie/IndexedDB) replica of per-collection EDV
  envelopes, with background WAS replication, last-writer-wins conflict
  resolution, and an aggregate sync-status rollup.
- Optional MUI + react-router components (`ProtectedRoute`, `ReconnectBanner`,
  `SyncStatusChip`) under the `./mui` entry.
- Node-only dev-grants provisioner (`provisionDevGrants`) and the
  `was-provision-dev-grants` CLI under the `./dev` entry.
